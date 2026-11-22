import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { abandon, acquireLock, finish, LowDiskError, repoIdFromRemote, startOrResume } from '../lib/build.ts'
import type { World } from '../lib/build.ts'
import { readDesign } from '../lib/design.ts'
import { runGate } from '../lib/gate.ts'
import { watchPr } from '../lib/review.ts'
import { recordApprovedPlan } from '../lib/readiness.ts'
import { buildDesign, buildNextPr } from '../lib/implement.ts'
import { realWorkshop } from '../lib/workshop.ts'
import type { BreakFinding, ExcessFinding, MergedPullRequest, PullRequestState, ReviewItem, Workshop } from '../lib/workshop.ts'
import { diskStore } from '../lib/store.ts'
import type { Claim, FixWave, Implementation, PrReport, PublishedEvidence, ReviewWave } from '../lib/store.ts'
import type { PlannedPr } from '../lib/types.ts'

const GB = 1024 ** 3

// A workshop that fails any call, to prove a disk-space guard refuses before it reaches any agent step.
const neverUsed = new Proxy({}, { get: () => () => { throw new Error('the workshop was used despite a full disk') } }) as Workshop

// Pins the free-space floor for a test so an inherited FACTORY_MIN_FREE_GB cannot change its result.
function pinFloor(t: import('node:test').TestContext, gb: string) {
  const previous = process.env.FACTORY_MIN_FREE_GB
  process.env.FACTORY_MIN_FREE_GB = gb
  t.after(() => {
    if (previous === undefined) delete process.env.FACTORY_MIN_FREE_GB
    else process.env.FACTORY_MIN_FREE_GB = previous
  })
}

const ONE_PR: PlannedPr[] = [{ number: 1, title: 'feature: do the thing', goal: 'goal', changes: ['c'], tests: ['t'], dependsOn: [], screenshots: ['a--default.png'], doneWhen: [1], hard: false }]

// A two-PR plan over a design with two checklist items and two screenshots, one assigned to each PR.
const TWO_PRS: DesignOptions = {
  screenshots: ['a--default.png', 'b--default.png'],
  doneWhen: ['first outcome', 'second outcome'],
  prs: [
    { number: 1, title: 'feature: do the thing', goal: 'goal', changes: ['c'], tests: ['t'], dependsOn: [], screenshots: ['a--default.png'], doneWhen: [1], hard: false },
    { number: 2, title: 'feature: do the next thing', goal: 'goal', changes: ['c'], tests: ['t'], dependsOn: [1], screenshots: ['b--default.png'], doneWhen: [2], hard: false },
  ],
}

interface DesignOptions {
  screenshots?: string[]
  doneWhen?: string[]
  prs?: PlannedPr[]
}

function addDesign(repo: string, name: string, planned: boolean, design: DesignOptions = {}) {
  const screenshots = design.screenshots ?? ['a--default.png']
  const doneWhen = design.doneWhen ?? ['first outcome']
  const dir = path.join(repo, 'factory', 'ready', name)
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  for (const shot of screenshots) fs.writeFileSync(path.join(dir, 'screenshots', shot), 'png')
  const images = screenshots.map((shot) => `![${shot}](screenshots/${shot})`).join('\n')
  const checklist = doneWhen.map((item) => `- [ ] ${item}`).join('\n')
  fs.writeFileSync(path.join(dir, 'Design.md'), `${images}\n\n## Done when\n\n${checklist}\n`)
  if (!planned) return
  recordApprovedPlan(repo, readDesign(repo, name.slice(0, 3)), { summary: 'summary', prs: design.prs ?? ONE_PR })
}

function setup(designs: [string, boolean][], branches: string[] = [], design: DesignOptions = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-build-'))
  fs.mkdirSync(path.join(repo, 'factory', 'ready'), { recursive: true })
  for (const [name, planned] of designs) addDesign(repo, name, planned, design)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-'))
  const world: World = {
    store: diskStore(home),
    repoId: 'owner/app',
    remoteBranches: (prefix) => branches.filter((branch) => branch.startsWith(prefix)),
    now: () => '2026-11-17T00:00:00.000Z',
    freeSpace: () => Number.POSITIVE_INFINITY,
  }
  const events = () => fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).type)
  return { repo, world, events }
}

test('starts the lowest-numbered design and lists its PRs', () => {
  const { repo, world, events } = setup([['002-second', true], ['001-first', true]])
  const report = startOrResume(repo, world, 'develop')
  assert.equal(report.state, 'started')
  assert.equal(report.state === 'started' && report.design, '001-first')
  assert.equal(report.state === 'started' && report.claim.prs.length, 1)
  assert.deepEqual(events(), ['design claimed'])
})

test('running it again reports the same design instead of starting another', () => {
  const { repo, world, events } = setup([['001-first', true], ['002-second', true]])
  startOrResume(repo, world, 'develop')
  const again = startOrResume(path.join(repo, '.'), { ...world }, 'develop')
  assert.equal(again.state, 'already in progress')
  assert.equal(again.state === 'already in progress' && again.design, '001-first')
  assert.deepEqual(events(), ['design claimed'])
})

test('does not skip past a design that has no finished plan', () => {
  const { repo, world } = setup([['001-first', false], ['002-second', true]])
  const report = startOrResume(repo, world, 'develop')
  assert.equal(report.state, 'not buildable')
  assert.equal(report.state === 'not buildable' && report.design, '001-first')
  assert.equal(world.store.claimFor('owner/app'), null)
})

test('refuses when GitHub already has factory branches for the design', () => {
  const { repo, world } = setup([['001-first', true]], ['factory/001-first/pr-1'])
  const report = startOrResume(repo, world, 'develop')
  assert.equal(report.state, 'refused')
  assert.equal(world.store.claimFor('owner/app'), null)
})

test('reports nothing to build when factory/ready is empty', () => {
  const { repo, world } = setup([])
  assert.deepEqual(startOrResume(repo, world, 'develop'), { state: 'nothing to build' })
})

test('refuses to claim a design when the disk is nearly full', (t) => {
  pinFloor(t, '20')
  const { repo, world, events } = setup([['001-first', true]])
  world.freeSpace = () => 2 * GB
  assert.throws(() => startOrResume(repo, world, 'develop'), LowDiskError)
  assert.equal(world.store.claimFor('owner/app'), null)
  assert.deepEqual(events(), ['build refused for space'])
})

test('a full disk does not stop a build that has nothing to build', () => {
  const { repo, world } = setup([])
  world.freeSpace = () => 1 * GB
  assert.deepEqual(startOrResume(repo, world, 'develop'), { state: 'nothing to build' })
})

test('abandoning frees the repo for the next build', () => {
  const { repo, world, events } = setup([['001-first', true]])
  startOrResume(repo, world, 'develop')
  assert.deepEqual(abandon(world), { state: 'abandoned', design: '001-first', deleteBeforeBuildingAgain: [] })
  assert.equal(startOrResume(repo, world, 'develop').state, 'started')
  assert.deepEqual(events(), ['design claimed', 'design abandoned', 'design claimed'])
})

test('abandoning names the branches left on GitHub', () => {
  const { repo, world } = setup([['001-first', true]])
  startOrResume(repo, world, 'develop')
  const report = abandon({ ...world, remoteBranches: () => ['factory/001-first/pr-1'] })
  assert.deepEqual(report, { state: 'abandoned', design: '001-first', deleteBeforeBuildingAgain: ['factory/001-first/pr-1'] })
})

test('a build is not resumed once its plan has changed', () => {
  const { repo, world } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'develop')
  assert.equal(started.state, 'started')
  world.store.release('owner/app')
  world.store.claim({ ...(started as { claim: Claim }).claim, prs: [] })
  const again = startOrResume(repo, world, 'develop')
  assert.match(again.state === 'refused' ? again.reasons[0] : '', /plan changed after this build started/)
})

test('a second claim on the same repo is rejected', () => {
  const { world } = setup([])
  const claim = { repo: 'owner/app', design: '001-first', base: 'develop', startedAt: 'now', prs: [] }
  world.store.claim(claim)
  assert.throws(() => world.store.claim({ ...claim, design: '002-second' }), /already has a design in progress: 001-first/)
})

test('the repository is identified the same way from either kind of address', () => {
  assert.equal(repoIdFromRemote('git@github.com:owner/app.git'), 'owner/app')
  assert.equal(repoIdFromRemote('https://github.com/owner/app'), 'owner/app')
})

function workshopWithGitHubResponse(response: object) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gh-'))
  const gh = path.join(bin, 'gh')
  fs.writeFileSync(gh, `#!/usr/bin/env node
if (process.argv[2] === 'auth') process.stdout.write('token')
else process.stdout.write(process.env.FACTORY_GH_RESPONSE)
`)
  fs.chmodSync(gh, 0o755)
  const previousPath = process.env.PATH
  const previousResponse = process.env.FACTORY_GH_RESPONSE
  process.env.PATH = `${bin}:${previousPath}`
  process.env.FACTORY_GH_RESPONSE = JSON.stringify(response)
  const workshop = realWorkshop('/tmp/repo', 'owner/app', '/tmp/worktrees', '/tmp/runs', 'model')
  return {
    workshop,
    restore() {
      process.env.PATH = previousPath
      if (previousResponse === undefined) delete process.env.FACTORY_GH_RESPONSE
      else process.env.FACTORY_GH_RESPONSE = previousResponse
    },
  }
}

function githubResponse(overrides: Record<string, unknown> = {}) {
  return { data: { repository: { pullRequest: {
    state: 'OPEN', headRefOid: 'abc', mergeable: 'MERGEABLE',
    reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
    ...overrides,
  } } } }
}

test('startup failures and stale checks fail the pull request', { concurrency: false }, () => {
  const { workshop, restore } = workshopWithGitHubResponse(githubResponse({
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { name: 'boot', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
      { name: 'old', status: 'COMPLETED', conclusion: 'STALE' },
    ] } } } }] },
  }))
  try {
    const state = workshop.pullRequestState(8)
    assert.equal(state.checks, 'failed')
    assert.deepEqual(state.failedChecks, ['boot', 'old'])
  } finally {
    restore()
  }
})

test('owner reviews and comments keep their globally unique IDs', { concurrency: false }, () => {
  const owner = { login: 'briankeane' }
  const { workshop, restore } = workshopWithGitHubResponse(githubResponse({
    reviews: { nodes: [{ id: 'review-id', databaseId: 5, author: owner, state: 'COMMENTED', body: 'review', commit: { oid: 'abc' } }] },
    comments: { nodes: [{ id: 'comment-id', databaseId: 5, author: owner, body: 'comment' }] },
  }))
  try {
    assert.deepEqual(workshop.pullRequestState(8).items.map((item) => item.id), ['comment-id', 'review-id'])
  } finally {
    restore()
  }
})

test('install preserves an existing factory command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-install-'))
  const command = path.join(home, '.local', 'bin', 'factory')
  fs.mkdirSync(path.dirname(command), { recursive: true })
  fs.writeFileSync(command, 'mine')
  const output = execFileSync('bash', [path.resolve(import.meta.dirname, '..', 'install.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home } })
  assert.equal(fs.readFileSync(command, 'utf8'), 'mine')
  assert.match(output, /SKIP \(not a symlink\).*factory/)
})

test('uninstall removes the factory command linked into this repository', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-uninstall-'))
  const command = path.join(home, '.local', 'bin', 'factory')
  fs.mkdirSync(path.dirname(command), { recursive: true })
  fs.symlinkSync(path.resolve(import.meta.dirname, '..', 'bin', 'factory.ts'), command)
  execFileSync('bash', [path.resolve(import.meta.dirname, '..', 'uninstall.sh')], { env: { ...process.env, HOME: home } })
  assert.equal(fs.existsSync(command), false)
})

const DONE: Implementation = { status: 'done', summary: 'built', checks: [{ command: 'make lint', passed: true }], blockers: [] }

async function buildPr(options: { result?: Implementation; uncommitted?: string[]; commits?: string[]; worktree?: string; whileImplementing?: (worktree: string) => void; merge?: 'merged' | 'conflicts'; breaks?: (BreakFinding[] | 'fails')[]; excess?: ExcessFinding[][]; fix?: Partial<FixWave>; lines?: { added: number; deleted: number }; github?: Partial<PullRequestState>[]; answer?: Partial<ReviewWave>; answerAction?: 'fixed' | 'declined' | 'answered'; reRecords?: boolean; evidence?: (PublishedEvidence | null)[]; design?: DesignOptions; merged?: Record<string, MergedPullRequest | null> } = {}) {
  const { repo, world, events } = setup([['001-first', true]], [], options.design)
  const started = startOrResume(repo, world, 'feature/x')
  assert.equal(started.state, 'started')
  if (started.state !== 'started') throw new Error('not started')
  const prompts: string[] = []
  const merges: string[] = []
  const reviews: string[] = []
  const fixPrompts: string[] = []
  let audits = 0
  const opened: { branch: string; base: string; title: string; body: string }[] = []
  const mergedLookups: string[] = []
  // Each look at GitHub sees the next state; the last one repeats. With none given, the owner has approved.
  const github = [...(options.github ?? [{ approved: true }])]
  const reviewPrompts: string[] = []
  const replies: { id: string; body: string; resolved: boolean }[] = []
  const did = { pushed: 0, reReviews: 0, merged: 0, mergedHeads: [] as (string | undefined)[], waits: 0, evidencePosts: 0, discarded: null as null | { worktree: string; branch: string; base: string } }
  const steps: string[] = []
  // Each publish finds the next recording; with none left, the PR has no evidence.
  const evidence = [...(options.evidence ?? [])]
  let head = 'abc'
  const workshop: Workshop = {
    prepareWorktree: () => options.worktree ?? repo,
    mergeBase: (_worktree, base) => {
      merges.push(base)
      return options.merge ?? 'merged'
    },
    implement: async (worktree, prompt) => {
      prompts.push(prompt)
      options.whileImplementing?.(worktree)
      return options.result ?? DONE
    },
    breakIt: async (_worktree, prompt) => {
      const round = reviews.push(prompt)
      const findings = options.breaks?.[round - 1] ?? []
      if (findings === 'fails') throw new Error('codex died')
      return { findings }
    },
    auditExcess: async () => {
      audits += 1
      return { findings: options.excess?.[audits - 1] ?? [] }
    },
    fix: async (_worktree, prompt) => {
      fixPrompts.push(prompt)
      const ids = [...prompt.matchAll(/\*\*([BE]\d+)\*\*/g)].map((match) => match[1])
      return { summary: 'fixed', dispositions: ids.map((id) => ({ id, action: 'fixed' as const, reason: '' })), checks: [], blockers: [], ...options.fix }
    },
    head: () => head,
    linesChanged: () => options.lines ?? { added: 5, deleted: 5 },
    commitMessages: () => options.commits ?? ['add the thing'],
    uncommittedFiles: () => options.uncommitted ?? [],
    markDesignBuilt: () => steps.push('design marked built') === 1,
    designAwaitingDone: (design) => fs.existsSync(path.join(repo, 'factory', 'ready', design)),
    openPullRequest: (_worktree, branch, base, title, body) => {
      steps.push('opened')
      opened.push({ branch, base, title, body })
      return { number: 7, url: 'https://github.com/owner/app/pull/7' }
    },
    mergedPullRequest: (branch) => {
      mergedLookups.push(branch)
      return options.merged?.[branch] ?? null
    },
    evidenceStamp: () => (options.reRecords ? String(reviewPrompts.length) : 'same'),
    publishEvidence: () => {
      did.evidencePosts += 1
      steps.push('evidence published')
      return evidence.shift() ?? null
    },
    pullRequestState: () => ({ state: 'open', head, approved: false, conflicts: false, checks: 'passed', failedChecks: [], greptileScore: null, items: [], ...(github.length > 1 ? github.shift() : github[0]) }),
    answerReview: async (_worktree, prompt) => {
      reviewPrompts.push(prompt)
      const action = options.answerAction ?? 'fixed'
      if (action === 'fixed') head = `fix-${reviewPrompts.length}`
      const ids = [...prompt.matchAll(/\*\*(R\d+)\*\*/g)].map((match) => match[1])
      return { summary: 'answered', replies: ids.map((id) => ({ id, action, reply: `reply to ${id}` })), checks: [], blockers: [], ...options.answer }
    },
    push: () => void (did.pushed += 1),
    acknowledge: (item) => void steps.push(`eyes on ${item.id}`),
    reply: (_number, item, body, resolved) => void replies.push({ id: item.id, body, resolved }),
    requestReview: () => void (did.reReviews += 1),
    merge: (_number, observedHead?: string) => {
      did.merged += 1
      did.mergedHeads.push(observedHead)
    },
    discardWorktree: (worktree, branch, base) => {
      did.discarded = { worktree, branch, base }
      steps.push('discarded')
    },
    wait: async () => void (did.waits += 1),
  }
  const build = () => buildNextPr(started.claim.prs, started.claim, world, workshop)
  return { repo, report: await build(), build, prompts, merges, events, world, workshop, mergedLookups, reviews, fixPrompts, opened, audited: () => audits, reviewPrompts, replies, did, steps, design: () => buildDesign(started.claim.prs, started.claim, world, workshop) }
}

test('the first PR is implemented on its own branch from the plan section', async () => {
  const { report, prompts, events } = await buildPr()
  assert.equal(report.state, 'implemented')
  assert.equal(report.state === 'implemented' && report.branch, 'factory/001-first/pr-1')
  assert.match(prompts[0], /PR 1, "feature: do the thing"/)
  assert.match(prompts[0], /cut from `feature\/x`/)
  assert.deepEqual(events(), ['design claimed', 'pr started', 'pr implemented', 'gate started', 'gate clean', 'pr opened', 'pr merged'])
})

test('once every PR is merged nothing more is run', async () => {
  const { build, prompts, reviews, opened } = await buildPr()
  assert.deepEqual(await build(), { state: 'all PRs merged' })
  assert.deepEqual([prompts.length, reviews.length, opened.length], [1, 1, 1])
})

// The merged PR carries the title the factory opened it under — PR 1's planned title in the two-PR plan.
const MERGED_1: MergedPullRequest = { number: 16, url: 'https://github.com/owner/app/pull/16', title: 'feature: do the thing' }

test('a PR already merged on GitHub with no local record is skipped for the next one', async () => {
  const { report, prompts, world, mergedLookups } = await buildPr({ design: TWO_PRS, merged: { 'factory/001-first/pr-1': MERGED_1 } })
  assert.equal('branch' in report && report.branch, 'factory/001-first/pr-2')
  assert.match(prompts[0], /PR 2, "feature: do the next thing"/)
  // The implementer only ran for PR 2; PR 1 was never rebuilt.
  assert.equal(prompts.length, 1)
  // GitHub was asked about PR 1's deleted branch, and the merge was written back so the store now knows it.
  assert.ok(mergedLookups.includes('factory/001-first/pr-1'))
  const recorded = world.store.prReport('owner/app', 1)
  assert.equal(recorded?.review?.state, 'merged')
  assert.equal(recorded?.pullRequest?.number, 16)
})

test('rebuilding an abandoned partially-merged design skips the PR already merged on GitHub', async () => {
  const merged: Record<string, MergedPullRequest | null> = {}
  const { repo, report, world, workshop } = await buildPr({ design: TWO_PRS, merged })
  // PR 1 was built and merged in this first pass.
  assert.equal('branch' in report && report.branch, 'factory/001-first/pr-1')
  assert.equal('review' in report && report.review?.state, 'merged')
  // The owner rewrote the plan and abandoned the design, wiping the store; PR 1 stays merged on GitHub, branch gone.
  assert.equal(abandon(world).state, 'abandoned')
  merged['factory/001-first/pr-1'] = MERGED_1
  // Rebuilding re-claims the design with an empty store, then advances past the merged PR 1 to PR 2.
  const again = startOrResume(repo, world, 'feature/x')
  assert.equal(again.state, 'started')
  if (again.state !== 'started') throw new Error('not started')
  const next = await buildNextPr(again.claim.prs, again.claim, world, workshop)
  assert.equal('branch' in next && next.branch, 'factory/001-first/pr-2')
  assert.equal(world.store.prReport('owner/app', 1)?.review?.state, 'merged')
})

test('a PR the store already records as merged is not re-checked against GitHub', async () => {
  const { build, mergedLookups } = await buildPr()
  const before = mergedLookups.length
  assert.deepEqual(await build(), { state: 'all PRs merged' })
  // Selecting past a store-merged PR reads the store, adding no GitHub lookup.
  assert.equal(mergedLookups.length, before)
})

test('a merged PR whose title no longer matches the rewritten plan stops for the owner', async () => {
  // PR 1's branch is merged on GitHub under an old title; the plan was rewritten so PR 1 is now different work.
  const stale: MergedPullRequest = { number: 16, url: 'https://github.com/owner/app/pull/16', title: 'feature: the old plan 1' }
  const { report, prompts } = await buildPr({ design: TWO_PRS, merged: { 'factory/001-first/pr-1': stale } })
  assert.equal(report.state, 'stopped')
  assert.match(report.state === 'stopped' ? report.reason : '', /was rewritten after that PR merged/)
  // Nothing was built, and PR 1 was not silently recorded as done.
  assert.equal(prompts.length, 0)
})

test('an already-merged last PR stops for the owner instead of looping on a design never moved to done', async () => {
  // Both PRs of a (shortened) plan are already merged on GitHub, so the design was never moved to factory/done.
  const merged = {
    'factory/001-first/pr-1': { number: 16, url: 'https://github.com/owner/app/pull/16', title: 'feature: do the thing' },
    'factory/001-first/pr-2': { number: 17, url: 'https://github.com/owner/app/pull/17', title: 'feature: do the next thing' },
  }
  const { report, design } = await buildPr({ design: TWO_PRS, merged })
  assert.equal(report.state, 'stopped')
  assert.match(report.state === 'stopped' ? report.reason : '', /still in factory\/ready/)
  // The design loop sees a stop, not 'all PRs merged', so it will not finish-and-reclaim forever.
  assert.equal((await design()).state, 'stopped')
})

test('once the owner moves a fully-merged design to factory/done, the recovery finishes instead of looping', async () => {
  const merged = {
    'factory/001-first/pr-1': { number: 16, url: 'https://github.com/owner/app/pull/16', title: 'feature: do the thing' },
    'factory/001-first/pr-2': { number: 17, url: 'https://github.com/owner/app/pull/17', title: 'feature: do the next thing' },
  }
  const { repo, report, build } = await buildPr({ design: TWO_PRS, merged })
  // While the design is still in factory/ready the recovery stops for the owner.
  assert.equal(report.state, 'stopped')
  // The owner moves it to factory/done on the base, as the stop asked.
  fs.mkdirSync(path.join(repo, 'factory', 'done'), { recursive: true })
  fs.renameSync(path.join(repo, 'factory', 'ready', '001-first'), path.join(repo, 'factory', 'done', '001-first'))
  // Resuming the saved claim now finishes cleanly instead of hitting the same stop forever.
  assert.deepEqual(await build(), { state: 'all PRs merged' })
})

test('a PR that comes through the gate clean is opened into the base branch under its plan title', async () => {
  const { report, opened } = await buildPr({ breaks: [[{ severity: 'P3', where: 'App.swift:1', problem: 'rare' }]], fix: { dispositions: [{ id: 'B1', action: 'declined', reason: 'not worth the complexity' }] } })
  assert.deepEqual('pullRequest' in report && report.pullRequest, { number: 7, url: 'https://github.com/owner/app/pull/7' })
  assert.deepEqual([opened[0].branch, opened[0].base, opened[0].title], ['factory/001-first/pr-1', 'feature/x', 'feature: do the thing'])
  assert.match(opened[0].body, /built[\s\S]*factory\/ready\/001-first[\s\S]*0 findings fixed, 1 declined[\s\S]*B1 declined: not worth the complexity/)
})

test('a PR the gate did not pass is not opened', async () => {
  const p1 = [{ severity: 'P1' as const, where: 'App.swift:1', problem: 'crash' }]
  const { opened } = await buildPr({ breaks: [p1, p1, p1] })
  assert.deepEqual(opened, [])
})

test('a PR that passed the gate but was never opened is opened without being built or reviewed again', async () => {
  const { build, world, report, prompts, reviews, opened } = await buildPr()
  if (!('gate' in report)) throw new Error('not gated')
  const { pullRequest: _, review: __, ...unopened } = report
  world.store.savePrReport('owner/app', unopened)
  const again = await build()
  assert.equal('pullRequest' in again && again.pullRequest?.number, 7)
  assert.deepEqual([prompts.length, reviews.length, opened.length], [1, 1, 2])
})

const BLOCKED: Implementation = { status: 'blocked', summary: 'built all but the recording', checks: [{ command: 'make lint', passed: false }], blockers: ['no simulator login'] }

test('work the implementer left unfinished needs attention', async () => {
  const { report, prompts, merges } = await buildPr({ result: BLOCKED, uncommitted: [' M App.swift'], commits: ['wip\n\nCo-Authored-By: x'] })
  assert.equal(report.state, 'needs attention')
  assert.deepEqual(report.state === 'needs attention' && [report.attempts, report.problems], [1, [
    'Blocked: no simulator login',
    'Check failed: make lint',
    'A commit message has a Co-Authored-By line.',
    'Uncommitted changes:  M App.swift',
  ]])
  assert.match(prompts[0], /fresh checkout/)
  assert.deepEqual(merges, [])
})

test('building again finishes a PR that needs attention instead of starting it over', async () => {
  const { build, prompts, merges } = await buildPr({ result: BLOCKED })
  const second = await build()
  assert.equal(second.state === 'needs attention' && second.attempts, 2)
  assert.deepEqual(merges, ['feature/x'])
  assert.match(prompts[1], /already committed/)
  assert.match(prompts[1], /Blocked: no simulator login/)
  assert.match(prompts[1], /built all but the recording/)
  assert.match(prompts[1], /merged in cleanly/)
})

test('conflicts with the base branch are handed to the implementer to resolve', async () => {
  const { build, prompts } = await buildPr({ result: BLOCKED, merge: 'conflicts' })
  await build()
  assert.match(prompts[1], /left conflicts/)
})

test('after three attempts a PR is left for the owner', async () => {
  const { build, prompts, events } = await buildPr({ result: BLOCKED })
  await build()
  await build()
  const fourth = await build()
  assert.equal(fourth.state, 'stopped')
  assert.match(fourth.state === 'stopped' ? fourth.reason : '', /after 3 attempts/)
  assert.equal(prompts.length, 3)
  assert.equal(events().filter((type) => type === 'pr started').length, 3)
})

test('an implementer that makes no commits or edits the design needs attention', async () => {
  const { report } = await buildPr({
    commits: [],
    whileImplementing: (worktree) => fs.appendFileSync(path.join(worktree, 'factory', 'ready', '001-first', 'Design.md'), 'changed\n'),
  })
  assert.deepEqual(report.state === 'needs attention' && report.problems, ['No commits were made.', 'The design folder or its plan was changed.'])
})

test('a base branch that does not hold the finished plan stops before any work', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-empty-'))
  fs.mkdirSync(path.join(empty, 'factory', 'ready'), { recursive: true })
  await assert.rejects(buildPr({ worktree: empty }), /does not hold the finished plan for 001-first/)
})

const P1: BreakFinding = { severity: 'P1', where: 'App.swift:10', problem: 'crashes on an empty list' }
const P3: BreakFinding = { severity: 'P3', where: 'App.swift:20', problem: 'label is cut off' }
const EXTRA: ExcessFinding = { where: 'App.swift:30', delete: 'the unused cache.', breaks: 'nothing' }
const gateOf = (report: Awaited<ReturnType<typeof buildPr>>['report']) => {
  if (!('gate' in report) || !report.gate) throw new Error('no gate ran')
  return report.gate
}

test('a PR with no findings is clean after one round and no fix', async () => {
  const { report, fixPrompts } = await buildPr()
  assert.deepEqual([gateOf(report).state, gateOf(report).rounds.length, fixPrompts.length], ['clean', 1, 0])
})

test('minor findings get one small fix wave and no second review', async () => {
  const { report, reviews, fixPrompts } = await buildPr({ breaks: [[P3]], excess: [[EXTRA]] })
  assert.deepEqual([gateOf(report).state, reviews.length], ['clean', 1])
  assert.match(fixPrompts[0], /\*\*B1\*\* \[P3\] `App.swift:20`: label is cut off/)
  assert.match(fixPrompts[0], /\*\*E1\*\* \[excess\] `App.swift:30`: Delete: the unused cache. What breaks if deleted: nothing/)
})

test('a critical finding is fixed and the code is reviewed again', async () => {
  const { report, reviews, audited } = await buildPr({ breaks: [[P1], []] })
  assert.deepEqual([gateOf(report).state, gateOf(report).rounds.map((round) => round.verdict), reviews.length], ['clean', ['not clean', 'clean'], 2])
  assert.equal(audited(), 1)
})

test('excess is audited again only when the fixes added more than they removed', async () => {
  const { audited } = await buildPr({ breaks: [[P1], []], lines: { added: 40, deleted: 2 } })
  assert.equal(audited(), 2)
})

test('a large fix wave is reviewed again even when nothing critical was found', async () => {
  const { report, reviews } = await buildPr({ breaks: [[P3], []], lines: { added: 10, deleted: 90 } })
  assert.deepEqual([gateOf(report).state, reviews.length], ['clean', 2])
})

test('a critical finding still there in the third round stops the gate for the owner', async () => {
  const { report, build, fixPrompts, events } = await buildPr({ breaks: [[P1], [P1], [P1]] })
  assert.deepEqual([gateOf(report).state, fixPrompts.length], ['stopped at round limit', 2])
  assert.equal(events().at(-1), 'gate stopped at round limit')
  const again = await build()
  assert.match(again.state === 'stopped' ? again.reason : '', /ended "stopped at round limit": \[P1\] App.swift:10: crashes on an empty list/)
})

test('a review pass that fails twice is never reported as clean, and the next build runs the gate again', async () => {
  const { report, build, prompts } = await buildPr({ breaks: ['fails', 'fails', []] })
  assert.equal(gateOf(report).state, 'did not run')
  assert.match(gateOf(report).problems[0], /break-it pass failed twice in round 1: codex died/)
  assert.equal(gateOf(await build()).state, 'clean')
  assert.equal(prompts.length, 1)
})

test('a review pass that fails once is tried again', async () => {
  const { report } = await buildPr({ breaks: ['fails', []] })
  assert.equal(gateOf(report).state, 'clean')
})

test('a fix wave that leaves a check failing or a finding unsettled fails the gate', async () => {
  const { report } = await buildPr({ breaks: [[P1]], fix: { dispositions: [], checks: [{ command: 'make test', passed: false }] } })
  assert.deepEqual([gateOf(report).state, gateOf(report).problems], ['fix failed', ['Check failed: make test', 'Finding B1 was neither fixed nor declined.']])
})

test('a PR implemented before the gate existed goes through the gate without being built again', async () => {
  const { build, world, prompts } = await buildPr()
  const saved = world.store.prReport('owner/app', 1)!
  delete saved.gate
  delete saved.pullRequest
  delete saved.review
  world.store.savePrReport('owner/app', saved)
  assert.equal(gateOf(await build()).state, 'clean')
  assert.equal(prompts.length, 1)
})

const reviewState = (report: Awaited<ReturnType<typeof buildNextPr>>) => ('review' in report ? report.review?.state : undefined)
const BOT_THREAD: ReviewItem = { id: 'T1', kind: 'thread', latest: 'c1', fromOwner: false, where: 'App.swift:9', text: 'greptile-apps: this breaks a repo rule' }
const OWNER_THREAD: ReviewItem = { id: 'T2', kind: 'thread', latest: 'c1', fromOwner: true, where: 'App.swift:3', text: 'briankeane: Why not in the other file?' }
const OWNER_COMMENT: ReviewItem = { id: 'comment-5', kind: 'comment', latest: 'c1', fromOwner: true, text: 'Rename the button please' }

test('an approved PR with passing checks is merged, and the design goes on until every PR is merged', async () => {
  const { report, did, design, world } = await buildPr()
  assert.equal(reviewState(report), 'merged')
  assert.equal(world.store.prReport('owner/app', 1)?.evidence, undefined)
  assert.equal(did.merged, 1)
  assert.deepEqual(await design(), { state: 'all PRs merged' })
})

test("a merged PR's worktree is discarded", async () => {
  const { repo, did } = await buildPr()
  assert.deepEqual(did.discarded, { worktree: repo, branch: 'factory/001-first/pr-1', base: 'feature/x' })
})

test('a PR closed without merging leaves its worktree alone', async () => {
  const { did } = await buildPr({ github: [{ state: 'closed' }] })
  assert.equal(did.discarded, null)
})

test('a PR already merged on GitHub still has its worktree discarded', async () => {
  const { repo, did } = await buildPr({ github: [{ state: 'merged' }] })
  assert.deepEqual(did.discarded, { worktree: repo, branch: 'factory/001-first/pr-1', base: 'feature/x' })
})

test("a merged PR's worktree is discarded only after the owner's open question is answered", async () => {
  const { steps } = await buildPr({ github: [{ approved: true, items: [OWNER_THREAD] }], answerAction: 'answered' })
  assert.ok(steps.indexOf(`eyes on ${OWNER_THREAD.id}`) < steps.indexOf('discarded'))
  assert.notEqual(steps.indexOf('discarded'), -1)
})

test('an approved PR is merged only at the head that was observed', async () => {
  const { did } = await buildPr({ github: [{ approved: true }] })
  assert.deepEqual(did.mergedHeads, ['abc'])
})

test('a PR the owner has not approved is never merged', async () => {
  const { report, did, events } = await buildPr({ github: [{}, {}, { state: 'closed' }] })
  assert.equal(did.merged, 0)
  assert.equal(did.waits, 2)
  assert.equal(reviewState(report), 'closed')
  assert.deepEqual(events().slice(-2), ['pr waiting on owner', 'pr closed'])
})

test('an approved PR waits for its checks before merging', async () => {
  const { did } = await buildPr({ github: [{ approved: true, checks: 'pending' }, { approved: true }] })
  assert.deepEqual([did.waits, did.merged], [1, 1])
})

test('an approved PR with a failing check gets the check fixed instead of being merged', async () => {
  const { did, reviewPrompts } = await buildPr({ github: [{ approved: true, checks: 'failed', failedChecks: ['swiftlint_check'] }, { state: 'closed' }] })
  assert.equal(did.merged, 0)
  assert.match(reviewPrompts[0], /Checks failing on the pull request:\*\* swiftlint_check/)
})

test("a bot's finding is fixed, pushed, answered in its thread, resolved, and reviewed again when the score was low", async () => {
  const { repo, report, did, replies, reviewPrompts } = await buildPr({ github: [{ items: [BOT_THREAD], greptileScore: 0 }, { approved: true }] })
  assert.match(reviewPrompts[0], /\*\*R1\*\* \[bot\] `App.swift:9`\n  > greptile-apps: this breaks a repo rule/)
  assert.deepEqual(replies, [{ id: 'T1', body: 'reply to R1', resolved: true }])
  assert.deepEqual(did, { pushed: 1, reReviews: 1, merged: 1, mergedHeads: ['fix-1'], waits: 0, evidencePosts: 1, discarded: { worktree: repo, branch: 'factory/001-first/pr-1', base: 'feature/x' } })
  assert.equal(reviewState(report), 'merged')
})

test('no second review is asked for when the score was four or more', async () => {
  const { did } = await buildPr({ github: [{ items: [BOT_THREAD], greptileScore: 4 }, { approved: true }] })
  assert.deepEqual([did.pushed, did.reReviews], [1, 0])
})

test("the owner's question is answered in the thread with no push, and the thread is left for the owner", async () => {
  const { did, replies } = await buildPr({ github: [{ items: [OWNER_THREAD], greptileScore: 0 }, { state: 'closed' }], answerAction: 'answered' })
  assert.deepEqual(replies, [{ id: 'T2', body: 'reply to R1', resolved: false }])
  assert.deepEqual([did.pushed, did.reReviews], [0, 0])
})

test("a thread the owner opened is never resolved, even when the change was made", async () => {
  const { replies } = await buildPr({ github: [{ items: [OWNER_THREAD] }, { state: 'closed' }] })
  assert.equal(replies[0].resolved, false)
})

test("the owner's comment on the PR is answered once", async () => {
  const { replies, reviewPrompts } = await buildPr({ github: [{ items: [OWNER_COMMENT] }, { items: [OWNER_COMMENT] }, { state: 'closed' }] })
  assert.equal(reviewPrompts.length, 1)
  assert.equal(replies.length, 1)
})

test('after three rounds bots are no longer answered, but the owner still is', async () => {
  const bots = { items: [BOT_THREAD] }
  const { reviewPrompts } = await buildPr({ github: [bots, bots, bots, bots, { items: [BOT_THREAD, OWNER_THREAD] }, { state: 'closed' }] })
  assert.equal(reviewPrompts.length, 4)
  assert.doesNotMatch(reviewPrompts[3], /greptile-apps/)
  assert.match(reviewPrompts[3], /\[owner\]/)
})

test("answering the owner does not use up the rounds bots get", async () => {
  const owner = { items: [OWNER_THREAD] }
  const { reviewPrompts } = await buildPr({ github: [owner, owner, owner, { items: [BOT_THREAD] }, { state: 'closed' }], answerAction: 'answered' })
  assert.match(reviewPrompts[3], /greptile-apps/)
})

test('a review fix that leaves a check failing is not pushed or posted, and the next build tries again', async () => {
  const { report, did, replies, events, build, reviewPrompts } = await buildPr({ github: [{ items: [BOT_THREAD] }], answer: { checks: [{ command: 'make lint', passed: false }] } })
  assert.equal(reviewState(report), 'fix failed')
  assert.deepEqual('review' in report && report.review?.problems, ['Check failed: make lint'])
  assert.deepEqual([did.pushed, replies.length], [0, 0])
  assert.equal(events().at(-1), 'pr needs attention')
  await build()
  assert.equal(reviewPrompts.length, 2)
})

test('a failed check repair is retried on the same GitHub commit', async () => {
  const failed = { head: 'abc', checks: 'failed' as const, failedChecks: ['make lint'] }
  const { build, reviewPrompts } = await buildPr({ github: [failed, failed, { state: 'closed' }], answer: { checks: [{ command: 'make lint', passed: false }] } })
  await build()
  assert.equal(reviewPrompts.length, 2)
})

test('a PR that was closed without merging stops the design', async () => {
  const { build, design } = await buildPr({ github: [{ state: 'closed' }] })
  assert.equal((await build()).state, 'stopped')
  assert.equal((await design()).state, 'stopped')
})

test("an approval merges straight away, and the owner's open question is still answered", async () => {
  const { did, replies, reviewPrompts } = await buildPr({ github: [{ approved: true, items: [OWNER_THREAD, BOT_THREAD] }], answerAction: 'answered' })
  assert.equal(did.merged, 1)
  assert.match(reviewPrompts[0], /already been merged/)
  assert.doesNotMatch(reviewPrompts[0], /greptile-apps/)
  assert.deepEqual(replies, [{ id: 'T2', body: 'reply to R1', resolved: false }])
})

test('a base branch that moved on without conflicts is merged in and pushed with no agent', async () => {
  const { did, merges, reviewPrompts } = await buildPr({ github: [{ conflicts: true }, { approved: true }] })
  assert.deepEqual([merges.length, did.pushed, reviewPrompts.length, did.merged], [1, 1, 0, 1])
})

test('conflicts with the base branch are resolved by the implementer and pushed, and an approval never merges over them', async () => {
  const { did, reviewPrompts } = await buildPr({ github: [{ conflicts: true, approved: true }, { approved: true }], merge: 'conflicts' })
  assert.match(reviewPrompts[0], /`feature\/x` was merged into this branch and left conflicts/)
  assert.deepEqual([did.pushed, did.merged], [1, 1])
})

test("the design's last PR moves the design to done before it is opened", async () => {
  const { steps } = await buildPr()
  assert.deepEqual(steps.slice(0, 2), ['design marked built', 'opened'])
})

test('a design is still found once it has been moved to done', async () => {
  const { repo } = setup([['001-first', true]])
  fs.mkdirSync(path.join(repo, 'factory', 'done'))
  fs.renameSync(path.join(repo, 'factory', 'ready', '001-first'), path.join(repo, 'factory', 'done', '001-first'))
  assert.equal(readDesign(repo, '001').dir, path.join('factory', 'done', '001-first'))
})

test('finishing a design frees the repo and forgets its PRs, so the next design starts clean', async () => {
  const { world, events } = await buildPr()
  finish(world)
  assert.equal(world.store.claimFor('owner/app'), null)
  assert.equal(world.store.prReport('owner/app', 1), null)
  assert.equal(events().at(-1), 'design finished')
})

test('evidence recorded again during a fix is posted to the PR after the push', async () => {
  const { did } = await buildPr({ github: [{ items: [OWNER_THREAD] }, { approved: true }], reRecords: true })
  assert.deepEqual([did.pushed, did.evidencePosts], [1, 2])
})

test('a round that only records the demo the owner asked for still posts it', async () => {
  const { did } = await buildPr({ github: [{ items: [OWNER_THREAD] }, { approved: true }], reRecords: true, answerAction: 'answered' })
  assert.deepEqual([did.pushed, did.evidencePosts], [0, 2])
})

test('a fix that records nothing new posts no evidence', async () => {
  const { did } = await buildPr({ github: [{ items: [OWNER_THREAD] }, { approved: true }] })
  assert.deepEqual([did.pushed, did.evidencePosts], [1, 1])
})

const RECORDING: PublishedEvidence = {
  comment: 'https://github.com/owner/app/pull/7#issuecomment-1',
  files: [{ file: 'demo.mp4', kind: 'functional', caption: 'Saving a show', url: 'https://github.com/user-attachments/assets/v1' }],
}

test("evidence is posted once the PR is open, kept in the PR's report, and posted before the worktree is discarded", async () => {
  const { world, steps } = await buildPr({ evidence: [RECORDING] })
  assert.deepEqual(steps.filter((step) => ['opened', 'evidence published', 'discarded'].includes(step)), ['opened', 'evidence published', 'discarded'])
  assert.deepEqual(world.store.prReport('owner/app', 1)?.evidence, RECORDING)
})

test('evidence recorded again during a fix replaces the addresses kept in the report', async () => {
  const again = { ...RECORDING, comment: 'https://github.com/owner/app/pull/7#issuecomment-2' }
  const { report } = await buildPr({ github: [{ items: [OWNER_THREAD] }, { approved: true }], reRecords: true, evidence: [RECORDING, again] })
  assert.deepEqual((report as PrReport).evidence, again)
})

test("the owner's comment gets an eyes reaction before work on it starts, and a bot's does not", async () => {
  const { steps } = await buildPr({ github: [{ items: [OWNER_THREAD, BOT_THREAD] }, { approved: true }] })
  assert.deepEqual(steps.filter((step) => step.startsWith('eyes')), [`eyes on ${OWNER_THREAD.id}`])
})

test('refuses before implementing a PR when the disk is nearly full', async (t) => {
  pinFloor(t, '20')
  const { repo, world, events } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'develop')
  if (started.state !== 'started') throw new Error('not started')
  world.freeSpace = () => 2 * GB
  await assert.rejects(buildNextPr(started.claim.prs, started.claim, world, neverUsed), LowDiskError)
  assert.deepEqual(events(), ['design claimed', 'build refused for space'])
})

test('refuses before a gate round when the disk is nearly full', async (t) => {
  pinFloor(t, '20')
  const { repo, world, events } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'develop')
  if (started.state !== 'started') throw new Error('not started')
  world.freeSpace = () => 2 * GB
  const report = { state: 'implemented', number: 1, attempts: 1, branch: 'factory/001-first/pr-1', worktree: repo, commits: [], problems: [], implementation: DONE } as PrReport
  await assert.rejects(runGate(started.claim.prs[0], started.claim, report, world, neverUsed), LowDiskError)
  assert.deepEqual(events(), ['design claimed', 'gate started', 'build refused for space'])
})

test('refuses before a review round when the disk is nearly full', async (t) => {
  pinFloor(t, '20')
  const { repo, world, events } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'develop')
  if (started.state !== 'started') throw new Error('not started')
  world.freeSpace = () => 2 * GB
  let answered = false
  const workshop = {
    pullRequestState: () => ({ state: 'open', head: 'abc', approved: false, conflicts: false, checks: 'passed', failedChecks: [], greptileScore: null, items: [{ id: 'c1', kind: 'comment', latest: 'c1', fromOwner: false, text: 'please change' }] }),
    evidenceStamp: () => 'same',
    answerReview: async () => { answered = true; return { summary: '', replies: [], checks: [], blockers: [] } },
  } as unknown as Workshop
  const report = { state: 'implemented', number: 1, attempts: 1, branch: 'factory/001-first/pr-1', worktree: repo, commits: [], problems: [], implementation: DONE, pullRequest: { number: 7, url: 'https://example/7' } } as PrReport
  await assert.rejects(watchPr(started.claim.prs[0], started.claim, report, world, workshop), LowDiskError)
  assert.equal(answered, false)
  assert.deepEqual(events(), ['design claimed', 'build refused for space'])
})

test('a nearly full disk does not stop an approved PR from merging and answering its owner questions', async (t) => {
  pinFloor(t, '20')
  const { repo, world } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'develop')
  if (started.state !== 'started') throw new Error('not started')
  world.freeSpace = () => 2 * GB
  let merged = false
  let answered = false
  const workshop = {
    pullRequestState: () => ({ state: 'open', head: 'abc', approved: true, conflicts: false, checks: 'passed', failedChecks: [], greptileScore: null, items: [{ id: 'q1', kind: 'comment', latest: 'q1', fromOwner: true, text: 'why this way?' }] }),
    acknowledge: () => {},
    merge: () => { merged = true },
    answerReview: async () => { answered = true; return { summary: '', replies: [{ id: 'R1', action: 'answered' as const, reply: 'because' }], checks: [], blockers: [] } },
    reply: () => {},
    discardWorktree: () => {},
    evidenceStamp: () => 'same',
  } as unknown as Workshop
  const report = { state: 'implemented', number: 1, attempts: 1, branch: 'factory/001-first/pr-1', worktree: repo, commits: [], problems: [], implementation: DONE, pullRequest: { number: 7, url: 'https://example/7' } } as PrReport
  const result = await watchPr(started.claim.prs[0], started.claim, report, world, workshop)
  assert.equal(result.review?.state, 'merged')
  assert.deepEqual([merged, answered], [true, true])
})

test('the build command runs the whole startup path and exits 0 when there is nothing to build', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-'))
  const origin = path.join(tmp, 'owner', 'app.git')
  fs.mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '--bare', origin])
  const clone = path.join(tmp, 'clone')
  execFileSync('git', ['clone', origin, clone])
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example' }
  fs.writeFileSync(path.join(clone, 'README.md'), 'hi')
  execFileSync('git', ['-C', clone, 'checkout', '-b', 'develop'])
  execFileSync('git', ['-C', clone, 'add', '-A'])
  execFileSync('git', ['-C', clone, 'commit', '-m', 'init'], { env: gitEnv })
  execFileSync('git', ['-C', clone, 'push', '-u', 'origin', 'develop'])
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-'))
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'factory.ts')
  // execFileSync throws unless the command exits 0, so a clean return is the exit-0 assertion.
  const out = execFileSync('node', [bin, 'build', clone, '--base', 'develop'], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: home } })
  assert.match(out, /nothing to build/)
  assert.equal(fs.existsSync(path.join(home, 'worktrees', 'owner__app', 'build.pid')), false)
})

test('acquireLock writes this process as the owner when no build holds the lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-'))
  const lock = path.join(dir, 'build.pid')
  acquireLock(lock, 'owner/app', () => true)
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid))
})

test('acquireLock refuses rather than overwrite a live build lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-'))
  const lock = path.join(dir, 'build.pid')
  fs.writeFileSync(lock, '424242')
  assert.throws(() => acquireLock(lock, 'owner/app', (pid) => pid === 424242), /already running on owner\/app \(process 424242\)/)
  assert.equal(fs.readFileSync(lock, 'utf8'), '424242')
})

test('acquireLock takes over a stale lock whose process is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-'))
  const lock = path.join(dir, 'build.pid')
  fs.writeFileSync(lock, '424242')
  acquireLock(lock, 'owner/app', () => false)
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid))
})
