import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { abandon, finish, repoIdFromRemote, startOrResume } from '../lib/build.ts'
import type { World } from '../lib/build.ts'
import { readDesign } from '../lib/design.ts'
import { recordApprovedPlan } from '../lib/readiness.ts'
import { buildDesign, buildNextPr } from '../lib/implement.ts'
import type { BreakFinding, ExcessFinding, PullRequestState, ReviewItem, Workshop } from '../lib/workshop.ts'
import { diskStore } from '../lib/store.ts'
import type { FixWave, Implementation, ReviewWave } from '../lib/store.ts'

function addDesign(repo: string, name: string, planned: boolean) {
  const dir = path.join(repo, 'designs', 'ready', name)
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'screenshots', 'a--default.png'), 'png')
  fs.writeFileSync(path.join(dir, 'Design.md'), '![a](screenshots/a--default.png)\n\n## Done when\n\n- [ ] first outcome\n')
  if (!planned) return
  recordApprovedPlan(repo, readDesign(repo, name.slice(0, 3)), {
    summary: 'summary',
    prs: [{ number: 1, title: 'feature: do the thing', goal: 'goal', changes: ['c'], tests: ['t'], dependsOn: [], screenshots: ['a--default.png'], doneWhen: [1], hard: false }],
  })
}

function setup(designs: [string, boolean][], branches: string[] = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-build-'))
  fs.mkdirSync(path.join(repo, 'designs', 'ready'), { recursive: true })
  for (const [name, planned] of designs) addDesign(repo, name, planned)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-'))
  const world: World = {
    store: diskStore(home),
    repoId: 'owner/app',
    remoteBranches: (prefix) => branches.filter((branch) => branch.startsWith(prefix)),
    now: () => '2026-11-17T00:00:00.000Z',
  }
  const events = () => fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).type)
  return { repo, world, events }
}

test('starts the lowest-numbered design and lists its PRs', () => {
  const { repo, world, events } = setup([['002-second', true], ['001-first', true]])
  const report = startOrResume(repo, world, 'develop')
  assert.equal(report.state, 'started')
  assert.equal(report.state === 'started' && report.design, '001-first')
  assert.equal(report.state === 'started' && report.prs.length, 1)
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

test('reports nothing to build when designs/ready is empty', () => {
  const { repo, world } = setup([])
  assert.deepEqual(startOrResume(repo, world, 'develop'), { state: 'nothing to build' })
})

test('abandoning frees the repo for the next build', () => {
  const { repo, world, events } = setup([['001-first', true]])
  startOrResume(repo, world, 'develop')
  assert.deepEqual(abandon(world), { state: 'abandoned', design: '001-first' })
  assert.equal(startOrResume(repo, world, 'develop').state, 'started')
  assert.deepEqual(events(), ['design claimed', 'design abandoned', 'design claimed'])
})

test('a second claim on the same repo is rejected', () => {
  const { world } = setup([])
  const claim = { repo: 'owner/app', design: '001-first', base: 'develop', startedAt: 'now', startedFrom: '/x' }
  world.store.claim(claim)
  assert.throws(() => world.store.claim({ ...claim, design: '002-second' }), /already has a design in progress: 001-first/)
})

test('the repository is identified the same way from either kind of address', () => {
  assert.equal(repoIdFromRemote('git@github.com:owner/app.git'), 'owner/app')
  assert.equal(repoIdFromRemote('https://github.com/owner/app'), 'owner/app')
})

const DONE: Implementation = { status: 'done', summary: 'built', checks: [{ command: 'make lint', passed: true }], blockers: [] }

async function buildPr(options: { result?: Implementation; uncommitted?: string[]; commits?: string[]; worktree?: string; whileImplementing?: (worktree: string) => void; merge?: 'merged' | 'conflicts'; breaks?: (BreakFinding[] | 'fails')[]; excess?: ExcessFinding[][]; fix?: Partial<FixWave>; lines?: { added: number; deleted: number }; github?: Partial<PullRequestState>[]; answer?: Partial<ReviewWave>; answerAction?: 'fixed' | 'declined' | 'answered' } = {}) {
  const { repo, world, events } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'feature/x')
  assert.equal(started.state, 'started')
  if (started.state !== 'started') throw new Error('not started')
  const prompts: string[] = []
  const merges: string[] = []
  const reviews: string[] = []
  const fixPrompts: string[] = []
  let audits = 0
  const opened: { branch: string; base: string; title: string; body: string }[] = []
  // Each look at GitHub sees the next state; the last one repeats. With none given, the owner has approved.
  const github = [...(options.github ?? [{ approved: true }])]
  const reviewPrompts: string[] = []
  const replies: { id: string; body: string; resolved: boolean }[] = []
  const did = { pushed: 0, reReviews: 0, merged: 0, waits: 0 }
  const steps: string[] = []
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
    openPullRequest: (_worktree, branch, base, title, body) => {
      steps.push('opened')
      opened.push({ branch, base, title, body })
      return { number: 7, url: 'https://github.com/owner/app/pull/7' }
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
    reply: (_number, item, body, resolved) => void replies.push({ id: item.id, body, resolved }),
    requestReview: () => void (did.reReviews += 1),
    merge: () => void (did.merged += 1),
    wait: async () => void (did.waits += 1),
  }
  const build = () => buildNextPr(started.prs, started.claim, world, workshop)
  return { repo, report: await build(), build, prompts, merges, events, world, reviews, fixPrompts, opened, audited: () => audits, reviewPrompts, replies, did, steps, design: () => buildDesign(started.prs, started.claim, world, workshop) }
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

test('a PR that comes through the gate clean is opened into the base branch under its plan title', async () => {
  const { report, opened } = await buildPr({ breaks: [[{ severity: 'P3', where: 'App.swift:1', problem: 'rare' }]], fix: { dispositions: [{ id: 'B1', action: 'declined', reason: 'not worth the complexity' }] } })
  assert.deepEqual('pullRequest' in report && report.pullRequest, { number: 7, url: 'https://github.com/owner/app/pull/7' })
  assert.deepEqual([opened[0].branch, opened[0].base, opened[0].title], ['factory/001-first/pr-1', 'feature/x', 'feature: do the thing'])
  assert.match(opened[0].body, /built[\s\S]*designs\/ready\/001-first[\s\S]*0 findings fixed, 1 declined[\s\S]*B1 declined: not worth the complexity/)
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
    whileImplementing: (worktree) => fs.appendFileSync(path.join(worktree, 'designs', 'ready', '001-first', 'Design.md'), 'changed\n'),
  })
  assert.deepEqual(report.state === 'needs attention' && report.problems, ['No commits were made.', 'The design folder or its plan was changed.'])
})

test('a base branch that does not hold the finished plan stops before any work', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-empty-'))
  fs.mkdirSync(path.join(empty, 'designs', 'ready'), { recursive: true })
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
const BOT_THREAD: ReviewItem = { id: 'T1', kind: 'thread', fromOwner: false, where: 'App.swift:9', text: 'greptile-apps: this breaks a repo rule' }
const OWNER_THREAD: ReviewItem = { id: 'T2', kind: 'thread', fromOwner: true, where: 'App.swift:3', text: 'briankeane: Why not in the other file?' }
const OWNER_COMMENT: ReviewItem = { id: 'comment-5', kind: 'comment', fromOwner: true, text: 'Rename the button please' }

test('an approved PR with passing checks is merged, and the design goes on until every PR is merged', async () => {
  const { report, did, design } = await buildPr()
  assert.equal(reviewState(report), 'merged')
  assert.equal(did.merged, 1)
  assert.deepEqual(await design(), { state: 'all PRs merged' })
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
  const { report, did, replies, reviewPrompts } = await buildPr({ github: [{ items: [BOT_THREAD], greptileScore: 0 }, { approved: true }] })
  assert.match(reviewPrompts[0], /\*\*R1\*\* \[bot\] `App.swift:9`\n  > greptile-apps: this breaks a repo rule/)
  assert.deepEqual(replies, [{ id: 'T1', body: 'reply to R1', resolved: true }])
  assert.deepEqual(did, { pushed: 1, reReviews: 1, merged: 1, waits: 0 })
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

test('a review fix that leaves a check failing is not pushed or posted, and the next build tries again', async () => {
  const { report, did, replies, events, build, reviewPrompts } = await buildPr({ github: [{ items: [BOT_THREAD] }], answer: { checks: [{ command: 'make lint', passed: false }] } })
  assert.equal(reviewState(report), 'fix failed')
  assert.deepEqual('review' in report && report.review?.problems, ['Check failed: make lint'])
  assert.deepEqual([did.pushed, replies.length], [0, 0])
  assert.equal(events().at(-1), 'pr needs attention')
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
  fs.mkdirSync(path.join(repo, 'designs', 'done'))
  fs.renameSync(path.join(repo, 'designs', 'ready', '001-first'), path.join(repo, 'designs', 'done', '001-first'))
  assert.equal(readDesign(repo, '001').dir, path.join('designs', 'done', '001-first'))
})

test('finishing a design frees the repo and forgets its PRs, so the next design starts clean', async () => {
  const { world, events } = await buildPr()
  finish(world)
  assert.equal(world.store.claimFor('owner/app'), null)
  assert.equal(world.store.prReport('owner/app', 1), null)
  assert.equal(events().at(-1), 'design finished')
})
