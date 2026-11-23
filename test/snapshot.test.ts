import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readDesign } from '../lib/design.ts'
import { recordApprovedPlan } from '../lib/readiness.ts'
import { CATALOG, countDesigns, snapshot } from '../lib/snapshot.ts'
import type { LoggedEvent, WatchedRepo } from '../lib/snapshot.ts'
import type { Claim, PrReport } from '../lib/store.ts'
import type { PlannedPr } from '../lib/types.ts'

const RUN = '98093cbb-16c0-43a9-b026-cc9b1d91c47a'
const NOW = new Date('2026-11-21T18:40:00.000Z')
const NO_COUNTS = { upNext: 0, planNotFinished: 0, done: 0 }

const planned = (number: number) => ({ number, title: `PR ${number}` }) as PlannedPr

const CLAIM: Claim = { repo: 'playola-radio/playola', design: '014-recorded-shows', base: 'develop', startedAt: '2026-11-21T18:00:00.000Z', prs: [planned(1), planned(2)], runId: RUN }

let ids = 0
function event(type: LoggedEvent['type'], at: string, pr?: number, runId = RUN): LoggedEvent {
  ids += 1
  return { id: `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`, runId, at, repo: CLAIM.repo, design: CLAIM.design, type, ...(pr && { pr }) }
}

function report(number: number, extra: Partial<PrReport> = {}): PrReport {
  return { state: 'implemented', number, attempts: 1, branch: `b${number}`, worktree: '/w', commits: [], problems: [], implementation: { status: 'done', summary: '', checks: [], blockers: [] }, ...extra }
}

function watched(extra: Partial<WatchedRepo> = {}, reports: Record<number, PrReport> = {}): WatchedRepo {
  return { repo: CLAIM.repo, claim: CLAIM, report: (number) => reports[number] ?? null, exitCode: null, counts: NO_COUNTS, ...extra }
}

const MERGED_1 = report(1, { pullRequest: { number: 811, url: 'https://github.com/playola-radio/playola/pull/811' }, review: { state: 'merged', rounds: [], answered: [], problems: [] } })
const OPEN_2 = report(2, { pullRequest: { number: 812, url: 'https://github.com/playola-radio/playola/pull/812' } })

test('the status list is the five statuses in the order the page sorts them', () => {
  assert.deepEqual(CATALOG.statuses.map((status) => [status.key, status.label, status.shortLabel, status.role]), [
    ['needs_you', 'Needs you', 'You', 'attention'],
    ['stopped', 'Stopped', 'Stopped', 'failure'],
    ['no_progress', 'No progress', 'Quiet', 'quiet'],
    ['running', 'Running', 'Running', 'active'],
    ['done', 'Done', 'Done', 'complete'],
  ])
})

test('a build implementing its first PR is running at the first stage', () => {
  const events = [event('design claimed', '2026-11-21T18:00:00.000Z'), event('pr started', '2026-11-21T18:01:00.000Z', 1)]
  const [build] = snapshot([watched()], events, NOW).builds
  assert.deepEqual(build, {
    runId: RUN,
    repo: 'playola-radio/playola',
    designNumber: '014',
    designName: 'Recorded shows',
    status: 'running',
    stages: ['Implement', 'Review gate', 'PR open', 'Reviewers', 'Merge'],
    currentStage: 0,
    reason: 'Implementing.',
    pr: { position: 1, total: 2, number: null, url: null },
    lastEventAt: '2026-11-21T18:01:00.000Z',
  })
})

test('the current PR is the first one not merged, and its pull request is linked', () => {
  const events = [event('pr merged', '2026-11-21T18:10:00.000Z', 1), event('pr opened', '2026-11-21T18:30:00.000Z', 2)]
  const [build] = snapshot([watched({}, { 1: MERGED_1, 2: OPEN_2 })], events, NOW).builds
  assert.equal(build.currentStage, 2)
  assert.deepEqual(build.pr, { position: 2, total: 2, number: 812, url: 'https://github.com/playola-radio/playola/pull/812' })
})

test('a PR whose reviews are all answered needs the owner', () => {
  const events = [event('pr merged', '2026-11-21T18:10:00.000Z', 1), event('pr waiting on owner', '2026-11-21T18:34:04.801Z', 2)]
  const [build] = snapshot([watched({}, { 1: MERGED_1, 2: OPEN_2 })], events, NOW).builds
  assert.deepEqual([build.status, build.currentStage, build.reason], ['needs_you', 4, 'Reviews answered. Ready for you to merge.'])
})

test('a PR the bot starts reviewing again no longer needs the owner', () => {
  const events = [event('pr waiting on owner', '2026-11-21T18:34:00.000Z', 2), event('review started', '2026-11-21T18:35:00.000Z', 2)]
  const [build] = snapshot([watched({}, { 1: MERGED_1, 2: OPEN_2 })], events, NOW).builds
  assert.deepEqual([build.status, build.currentStage], ['running', 3])
})

test('a build with nothing new for over an hour shows no progress and for how long', () => {
  const events = [event('pr started', '2026-11-21T17:30:00.000Z', 1)]
  const [build] = snapshot([watched()], events, NOW).builds
  assert.deepEqual([build.status, build.reason], ['no_progress', 'Implementing. Nothing new for 1 h 10 min.'])
})

test('a whole number of hours reads without minutes', () => {
  const events = [event('pr started', '2026-11-21T16:40:00.000Z', 1)]
  assert.equal(snapshot([watched()], events, NOW).builds[0].reason, 'Implementing. Nothing new for 2 h.')
})

test('a repo the watcher paused is stopped, with the exit code and the first problem, even while waiting on the owner', () => {
  const events = [event('pr needs attention', '2026-11-21T18:30:00.000Z', 1), event('pr waiting on owner', '2026-11-21T18:31:00.000Z', 1)]
  const stuck = report(1, { state: 'needs attention', problems: ['Check failed: npm test', 'Blocked: no access'] })
  const [build] = snapshot([watched({ exitCode: 2 }, { 1: stuck })], events, NOW).builds
  assert.deepEqual([build.status, build.reason], ['stopped', 'factory build exited 2; paused until the watcher restarts. Check failed: npm test'])
})

test('a reason is one line of at most 300 characters', () => {
  const stuck = report(1, { problems: [`line one\nline two ${'x'.repeat(400)}`] })
  const { reason } = snapshot([watched({ exitCode: 1 }, { 1: stuck })], [], NOW).builds[0]
  assert.equal(reason.length, 300)
  assert.doesNotMatch(reason, /\n/)
})

test('a paused repo with nothing claimed has no row', () => {
  assert.deepEqual(snapshot([watched({ claim: null, exitCode: 1 })], [], NOW).builds, [])
})

test('a design finished in the last day stays on the page as done, with every PR counted', () => {
  const other = '3f0e2a51-7b8c-4d2e-9a61-0c5d8e7f1b24'
  const events = [
    event('pr merged', '2026-11-20T20:00:00.000Z', 3, other),
    event('design finished', '2026-11-20T20:00:01.000Z', undefined, other),
    event('design finished', '2026-11-20T18:00:00.000Z', undefined, '11111111-2222-4333-8444-555555555555'),
  ]
  const { builds } = snapshot([watched({ claim: null })], events, NOW)
  assert.deepEqual(builds, [{
    runId: other,
    repo: 'playola-radio/playola',
    designNumber: '014',
    designName: 'Recorded shows',
    status: 'done',
    stages: ['Implement', 'Review gate', 'PR open', 'Reviewers', 'Merge'],
    currentStage: 4,
    reason: 'Every PR merged.',
    pr: { position: 3, total: 3, number: null, url: null },
    lastEventAt: '2026-11-20T20:00:01.000Z',
  }])
})

test('the design counts are added up across repos', () => {
  const repos = [watched({ counts: { upNext: 1, planNotFinished: 2, done: 3 } }), watched({ claim: null, counts: { upNext: 4, planNotFinished: 0, done: 5 } })]
  assert.deepEqual(snapshot(repos, [], NOW).counts, { upNext: 5, planNotFinished: 2, done: 8 })
})

test("a repo's designs are counted from its base view, leaving out the one being built", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-counts-'))
  for (const name of ['001-first', '002-second', '003-third']) {
    const dir = path.join(repo, 'factory', 'ready', name)
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'screenshots', 'a--default.png'), 'png')
    fs.writeFileSync(path.join(dir, 'Design.md'), '![a](screenshots/a--default.png)\n\n## Done when\n\n- [ ] it works\n')
  }
  const pr = { number: 1, title: 'feature: it', goal: 'g', changes: ['c'], tests: ['t'], dependsOn: [], screenshots: ['a--default.png'], doneWhen: [1], hard: false }
  for (const number of ['001', '002']) recordApprovedPlan(repo, readDesign(repo, number), { summary: 's', prs: [pr] })
  fs.mkdirSync(path.join(repo, 'factory', 'done', '000-zero'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'factory', 'done', 'README.md'), 'not a design')
  assert.deepEqual(countDesigns(repo, '001-first'), { upNext: 1, planNotFinished: 1, done: 1 })
})

test('a repo with no base view yet counts nothing', () => {
  assert.deepEqual(countDesigns(path.join(os.tmpdir(), 'factory-no-such-view'), undefined), NO_COUNTS)
})
