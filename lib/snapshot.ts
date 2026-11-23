import fs from 'node:fs'
import path from 'node:path'

import { designStatuses } from './readiness.ts'
import type { Claim, FactoryEvent, PrReport } from './store.ts'

// What marge's /factory page shows, built from the factory's own state. The contract is marge-web's
// factory/done/002-factory-overview/ApiContract.md.

export type LoggedEvent = FactoryEvent & { id: string }

export interface Counts {
  upNext: number
  planNotFinished: number
  done: number
}

export interface WatchedRepo {
  claim: Claim | null
  report: (number: number) => PrReport | null
  // Set when the watcher paused this repo because its build exited non-zero.
  exitCode: number | null
  counts: Counts
}

export interface Build {
  runId: string
  repo: string
  designNumber: string
  designName: string
  status: (typeof CATALOG.statuses)[number]['key']
  stages: string[]
  currentStage: number
  reason: string
  pr: { position: number; total: number; number: number | null; url: string | null }
  lastEventAt: string
}

export const CATALOG = {
  statuses: [
    { key: 'needs_you', label: 'Needs you', shortLabel: 'You', role: 'attention' },
    { key: 'stopped', label: 'Stopped', shortLabel: 'Stopped', role: 'failure' },
    { key: 'no_progress', label: 'No progress', shortLabel: 'Quiet', role: 'quiet' },
    { key: 'running', label: 'Running', shortLabel: 'Running', role: 'active' },
    { key: 'done', label: 'Done', shortLabel: 'Done', role: 'complete' },
  ],
} as const

const STAGES = ['Implement', 'Review gate', 'PR open', 'Reviewers', 'Merge']
const DOING = ['Implementing', 'In the review gate', 'Pull request open', 'Answering reviewers', 'Merging']
const MAX_BUILDS = 50
const QUIET_MS = 60 * 60 * 1000
const DONE_SHOWN_MS = 24 * 60 * 60 * 1000

function stageAfter(type: FactoryEvent['type'] | undefined): number {
  if (type === 'pr implemented' || type?.startsWith('gate ')) return 1
  if (type === 'pr opened') return 2
  if (type === 'review started' || type === 'review round' || type === 'pr closed') return 3
  if (type === 'pr waiting on owner' || type === 'pr merged') return 4
  return 0
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300)

function hoursAndMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
}

function named(design: string) {
  const words = design.replace(/^\d{3}-/, '').replaceAll('-', ' ')
  return { designNumber: design.slice(0, 3), designName: (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 120) || design }
}

function inFlight(repo: WatchedRepo, claim: Claim, events: LoggedEvent[], now: Date): Build {
  const run = events.filter((event) => event.runId === claim.runId)
  const reports = claim.prs.map((pr) => repo.report(pr.number))
  const unmerged = reports.findIndex((report) => report?.review?.state !== 'merged')
  const index = unmerged === -1 ? claim.prs.length - 1 : unmerged
  const report = reports[index]
  // A PR needing attention stays at the stage it stopped in, which the event before says.
  const latest = run.filter((event) => event.pr === claim.prs[index].number && event.type !== 'pr needs attention').at(-1)
  const stage = stageAfter(latest?.type)
  const lastEventAt = run.at(-1)?.at ?? claim.startedAt
  const quietFor = now.getTime() - Date.parse(lastEventAt)
  const [status, reason]: [Build['status'], string] =
    repo.exitCode !== null
      ? ['stopped', `factory build exited ${repo.exitCode}; paused until the watcher restarts. ${report?.review?.problems[0] ?? report?.gate?.problems[0] ?? report?.problems[0] ?? ''}`]
      : latest?.type === 'pr waiting on owner'
        ? ['needs_you', 'Reviews answered. Ready for you to merge.']
        : quietFor >= QUIET_MS
          ? ['no_progress', `${DOING[stage]}. Nothing new for ${hoursAndMinutes(quietFor)}.`]
          : ['running', `${DOING[stage]}.`]
  return {
    runId: claim.runId,
    repo: claim.repo,
    ...named(claim.design),
    status,
    stages: STAGES,
    currentStage: stage,
    reason: oneLine(reason),
    pr: { position: index + 1, total: claim.prs.length, number: report?.pullRequest?.number ?? null, url: report?.pullRequest?.url ?? null },
    lastEventAt,
  }
}

function finished(event: LoggedEvent, events: LoggedEvent[]): Build {
  const total = Math.max(1, ...events.filter((other) => other.runId === event.runId).map((other) => other.pr ?? 0))
  return {
    runId: event.runId,
    repo: event.repo,
    ...named(event.design),
    status: 'done',
    stages: STAGES,
    currentStage: STAGES.length - 1,
    reason: 'Every PR merged.',
    pr: { position: total, total, number: null, url: null },
    lastEventAt: event.at,
  }
}

export function snapshot(repos: WatchedRepo[], events: LoggedEvent[], now: Date): { builds: Build[]; counts: Counts } {
  const active = repos.flatMap((repo) => (repo.claim ? [inFlight(repo, repo.claim, events, now)] : []))
  const done = events
    .filter((event) => event.type === 'design finished' && now.getTime() - Date.parse(event.at) < DONE_SHOWN_MS)
    .reverse()
    .map((event) => finished(event, events))
  const counts = repos.reduce(
    (sum, repo) => ({ upNext: sum.upNext + repo.counts.upNext, planNotFinished: sum.planNotFinished + repo.counts.planNotFinished, done: sum.done + repo.counts.done }),
    { upNext: 0, planNotFinished: 0, done: 0 },
  )
  return { builds: [...active, ...done].slice(0, MAX_BUILDS), counts }
}

// Counts a repo's designs from its base view (the checkout of the base branch every build refreshes).
export function countDesigns(baseView: string, claimed: string | undefined): Counts {
  const waiting = designStatuses(baseView).filter((status) => status.design !== claimed)
  const doneDir = path.join(baseView, 'factory', 'done')
  return {
    upNext: waiting.filter((status) => status.buildable).length,
    planNotFinished: waiting.filter((status) => !status.buildable).length,
    done: fs.existsSync(doneDir) ? fs.readdirSync(doneDir).filter((name) => /^\d{3}-/.test(name)).length : 0,
  }
}
