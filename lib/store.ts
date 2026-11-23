import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { PlannedPr } from './types.ts'

export interface Claim {
  repo: string
  design: string
  base: string
  startedAt: string
  prs: PlannedPr[]
  // This attempt at building the design; a design given up and claimed again gets a new one.
  runId: string
}

// The `id` and `artifactId` are set by the store as it writes the line.
export interface FactoryEvent {
  id?: string
  runId: string
  artifactId?: string
  at: string
  repo: string
  design: string
  pr?: number
  type:
    | 'design claimed'
    | 'design abandoned'
    | 'design finished'
    | 'build refused for space'
    | 'pr started'
    | 'pr implemented'
    | 'pr needs attention'
    | 'gate started'
    | `gate ${GateReport['state']}`
    | 'pr opened'
    | 'review started'
    | 'review round'
    | 'pr waiting on owner'
    | `pr ${NonNullable<ReviewReport['state']>}`
}

export interface Implementation {
  status: 'done' | 'blocked'
  summary: string
  checks: Check[]
  blockers: string[]
}

export interface Check {
  command: string
  passed: boolean
}

export interface GateFinding {
  id: string
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'excess'
  where: string
  problem: string
}

export interface FixWave {
  summary: string
  dispositions: { id: string; action: 'fixed' | 'declined'; reason: string }[]
  checks: Check[]
  blockers: string[]
}

export interface GateRound {
  round: number
  verdict: 'clean' | 'not clean'
  excessAudited: boolean
  findings: GateFinding[]
  fix?: FixWave & { added: number; deleted: number }
}

export interface GateReport {
  state: 'clean' | 'stopped at round limit' | 'did not run' | 'fix failed'
  rounds: GateRound[]
  problems: string[]
}

export interface PullRequest {
  number: number
  url: string
}

export interface ReviewWave {
  summary: string
  replies: { id: string; action: 'fixed' | 'declined' | 'answered'; reply: string }[]
  checks: Check[]
  blockers: string[]
}

// `answered` holds the owner's top-level comments already replied to; threads show that on GitHub themselves.
export interface ReviewReport {
  state?: 'merged' | 'closed' | 'fix failed'
  rounds: (ReviewWave & { head: string; forBots: boolean })[]
  answered: string[]
  problems: string[]
}

export interface EvidenceFile {
  // Relative to the implementer's evidence folder.
  file: string
  kind: 'functional' | 'visual'
  caption: string
}

// The PR comment the factory posted the implementer's recordings in, and the address GitHub hosts each one at.
export interface PublishedEvidence {
  comment: string
  files: (EvidenceFile & { url: string })[]
}

export interface PrReport {
  state: 'implemented' | 'needs attention'
  number: number
  attempts: number
  branch: string
  worktree: string
  commits: string[]
  problems: string[]
  implementation: Implementation
  gate?: GateReport
  pullRequest?: PullRequest
  evidence?: PublishedEvidence
  review?: ReviewReport
}

// The only place that knows where factory state lives, so it can move off this disk later.
export interface Store {
  claimFor(repo: string): Claim | null
  claim(claim: Claim): void
  release(repo: string): void
  prReport(repo: string, number: number): PrReport | null
  savePrReport(repo: string, report: PrReport): void
  // With a report, also keeps a copy of it as this event's artifact, until marge has accepted it.
  record(event: FactoryEvent, report?: PrReport): void
  eventLog(): string
  artifact(id: string): object | null
  forgetArtifact(id: string): void
  // Byte offset into the event log just past the last line marge accepted.
  syncCursor(): number
  saveSyncCursor(offset: number): void
}

const MAX_ARTIFACT_BYTES = 256 * 1024

// A uuid-shaped id that is always the same for the same text, for history written before ids existed.
export function derivedUuid(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const legacyRunId = (repo: string, design: string, claimedAt: string) => derivedUuid(`run\n${repo}\n${design}\n${claimedAt}`)

function artifactBody(report: PrReport): object {
  const { worktree: _, ...body } = report
  if (Buffer.byteLength(JSON.stringify(body)) <= MAX_ARTIFACT_BYTES) return body
  return { number: report.number, state: report.state, omitted: 'The full report was over 256 KiB, the most marge keeps.' }
}

export function diskStore(home: string): Store {
  const buildDir = (repo: string) => path.join(home, 'builds', repo.replaceAll('/', '__'))
  const claimFile = (repo: string) => path.join(buildDir(repo), 'claim.json')
  const prFile = (repo: string, number: number) => path.join(buildDir(repo), `pr-${number}.json`)
  const artifactFile = (id: string) => path.join(home, 'artifacts', `${id}.json`)
  const eventsFile = path.join(home, 'events.jsonl')
  const cursorFile = path.join(home, 'sync.json')
  return {
    claimFor(repo) {
      const file = claimFile(repo)
      if (!fs.existsSync(file)) return null
      const claim = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { ...claim, runId: claim.runId ?? legacyRunId(claim.repo, claim.design, claim.startedAt) }
    },
    claim(claim) {
      const file = claimFile(claim.repo)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        fs.writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        throw new Error(`${claim.repo} already has a design in progress: ${this.claimFor(claim.repo)?.design}`)
      }
    },
    release(repo) {
      fs.rmSync(buildDir(repo), { recursive: true, force: true })
    },
    prReport(repo, number) {
      const file = prFile(repo, number)
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    },
    savePrReport(repo, report) {
      fs.writeFileSync(prFile(repo, report.number), `${JSON.stringify(report, null, 2)}\n`)
    },
    record(event, report) {
      const id = randomUUID()
      if (report) {
        fs.mkdirSync(path.dirname(artifactFile(id)), { recursive: true })
        fs.writeFileSync(artifactFile(id), JSON.stringify(artifactBody(report)))
      }
      fs.mkdirSync(home, { recursive: true })
      fs.appendFileSync(eventsFile, `${JSON.stringify({ id, ...event, ...(report && { artifactId: id }) })}\n`)
    },
    eventLog() {
      return fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : ''
    },
    artifact(id) {
      return fs.existsSync(artifactFile(id)) ? JSON.parse(fs.readFileSync(artifactFile(id), 'utf8')) : null
    },
    forgetArtifact(id) {
      fs.rmSync(artifactFile(id), { force: true })
    },
    syncCursor() {
      return fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, 'utf8')).offset : 0
    },
    saveSyncCursor(offset) {
      const temp = `${cursorFile}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ offset }))
      fs.renameSync(temp, cursorFile)
    },
  }
}
