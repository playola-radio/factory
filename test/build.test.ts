import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { abandon, finish, nextDesign, repoIdFromRemote, startOrResume } from '../lib/build.ts'
import type { World } from '../lib/build.ts'
import { readDesign } from '../lib/design.ts'
import { recordApprovedPlan } from '../lib/readiness.ts'
import { buildDesign, buildNextPr } from '../lib/implement.ts'
import { realWorkshop, runAfterPush } from '../lib/workshop.ts'
import type { BreakFinding, ExcessFinding, PullRequestState, ReviewItem, Workshop } from '../lib/workshop.ts'
import type { RepoRules } from '../lib/repo.ts'
import { diskStore } from '../lib/store.ts'
import type { Settings } from '../lib/settings.ts'
import type { Claim, FixWave, Implementation, PrReport, ReviewWave } from '../lib/store.ts'

function addDesign(repo: string, name: string, planned: boolean) {
  const dir = path.join(repo, 'factory', 'ready', name)
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
  fs.mkdirSync(path.join(repo, 'factory', 'ready'), { recursive: true })
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

test("the repo's rules are read again for each design, so a change merged into the base reaches the next one", () => {
  const { repo, world } = setup([['001-first', true], ['002-second', true]])
  fs.mkdirSync(path.join(repo, 'factory'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'factory', 'qa-rules.md'), 'old rules')
  const first = nextDesign(repo, world, 'develop')
  assert.deepEqual([first.report.state, first.rules.qaRules], ['started', 'old rules'])
  fs.rmSync(path.join(repo, 'factory', 'ready', '001-first'), { recursive: true })
  finish(world)
  fs.writeFileSync(path.join(repo, 'factory', 'qa-rules.md'), 'new rules')
  fs.writeFileSync(path.join(repo, 'factory', 'config.json'), '{"afterPush":{"command":"echo {pr}"}}')
  const second = nextDesign(repo, world, 'develop')
  assert.equal(second.report.state === 'started' && second.report.design, '002-second')
  assert.deepEqual(second.rules, { afterPush: { command: 'echo {pr}' }, qaRules: 'new rules' })
})

test('a bad repo config stops the build before a design is claimed', () => {
  const { repo, world } = setup([['001-first', true]])
  fs.writeFileSync(path.join(repo, 'factory', 'config.json'), '{"afterpush":{}}')
  assert.throws(() => nextDesign(repo, world, 'develop'), /factory\/config\.json on develop: afterpush is not a field/)
  assert.equal(world.store.claimFor('owner/app'), null)
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

const SETTINGS: Settings = { owner: 'owner-login', bot: { login: 'bot-login', name: 'Bot', email: '1+bot-login@users.noreply.github.com' }, greptile: { reReviewBelow: 4 }, models: {} }

function workshopWithGitHubResponse(response: object, settings: Settings = SETTINGS) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gh-'))
  const gh = path.join(bin, 'gh')
  fs.writeFileSync(gh, `#!/usr/bin/env node
if (process.argv[2] === 'auth') process.stdout.write('token')
else if (process.argv[2] === 'api' && process.argv[3] === 'user') process.stdout.write('bot-login')
else process.stdout.write(process.env.FACTORY_GH_RESPONSE)
`)
  fs.chmodSync(gh, 0o755)
  const previousPath = process.env.PATH
  const previousResponse = process.env.FACTORY_GH_RESPONSE
  process.env.PATH = `${bin}:${previousPath}`
  process.env.FACTORY_GH_RESPONSE = JSON.stringify(response)
  const workshop = realWorkshop('/tmp/repo', 'owner/app', '/tmp/worktrees', '/tmp/runs', settings)
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
  const owner = { login: 'owner-login' }
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

const NO_RULES: RepoRules = { afterPush: null, qaRules: null }
const DONE: Implementation = { status: 'done', summary: 'built', checks: [{ command: 'make lint', passed: true }], blockers: [] }

async function buildPr(options: { result?: Implementation; uncommitted?: string[]; commits?: string[]; worktree?: string; whileImplementing?: (worktree: string) => void; merge?: 'merged' | 'conflicts'; breaks?: (BreakFinding[] | 'fails')[]; excess?: ExcessFinding[][]; fix?: Partial<FixWave>; lines?: { added: number; deleted: number }; github?: Partial<PullRequestState>[]; answer?: Partial<ReviewWave>; answerAction?: 'fixed' | 'declined' | 'answered'; whileAnswering?: (worktree: string) => void; afterPush?: (worktree: string, run: number, commit: () => void) => void; catchUp?: 'behind' | 'diverged' | 'conflicts' | 'changed'; replyFails?: (id: string) => boolean; resolveFails?: (attempt: number) => boolean; designMovedAgain?: () => boolean; allowInitialError?: boolean; reReviewBelow?: number; rules?: RepoRules } = {}) {
  const { repo, world, events } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'feature/x')
  assert.equal(started.state, 'started')
  if (started.state !== 'started') throw new Error('not started')
  const prompts: string[] = []
  const merges: string[] = []
  const reviews: string[] = []
  const fixPrompts: string[] = []
  let audits = 0
  const excessPrompts: string[] = []
  const opened: { branch: string; base: string; title: string; body: string }[] = []
  // Each look at GitHub sees the next state; the last one repeats. With none given, the owner has approved.
  const github = [...(options.github ?? [{ approved: true }])]
  const reviewPrompts: string[] = []
  const replies: { id: string; body: string; resolved: boolean }[] = []
  const resolves: string[] = []
  const atResolve: PrReport[] = []
  const did = { pushed: 0, reReviews: 0, merged: 0, mergedHeads: [] as (string | undefined)[], waits: 0, afterPushes: [] as string[] }
  const steps: string[] = []
  let head = 'abc'
  let pushedHead = head
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
    auditExcess: async (_worktree, prompt) => {
      audits += 1
      excessPrompts.push(prompt)
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
    // On a later build, designMovedAgain says the design was back in factory/ready and was moved in a new commit.
    markDesignBuilt: () => {
      if (steps.push('design marked built') === 1) return true
      if (!options.designMovedAgain?.()) return false
      head = 'design-moved'
      return true
    },
    openPullRequest: (_worktree, branch, base, title, body) => {
      steps.push('opened')
      opened.push({ branch, base, title, body })
      pushedHead = head
      return { number: 7, url: 'https://github.com/owner/app/pull/7' }
    },
    afterPush: async (worktree, command) => {
      steps.push('after push')
      const run = did.afterPushes.push(command)
      options.afterPush?.(worktree, run, () => { head = `after-push-${run}` })
    },
    // GitHub's branch moved as options.catchUp says only when its head is not the one last pushed; otherwise, or unless told, the worktree holds commits GitHub does not have.
    catchUp: (_worktree, _branch, theirs) => {
      steps.push('catch up')
      const how = theirs === pushedHead ? 'ahead' : options.catchUp ?? 'ahead'
      if (how === 'conflicts') return 'conflicts'
      if (how === 'changed') return 'changed'
      if (how === 'behind') {
        head = theirs
        return 'fast-forwarded'
      }
      if (how === 'diverged') head = `merge-${theirs}`
      did.pushed += 1
      pushedHead = head
      return 'pushed'
    },
    pullRequestState: () => ({ state: 'open', head: pushedHead, approved: false, conflicts: false, checks: 'passed', failedChecks: [], greptile: null, items: [], ...(github.length > 1 ? github.shift() : github[0]) }),
    answerReview: async (worktree, prompt) => {
      reviewPrompts.push(prompt)
      options.whileAnswering?.(worktree)
      const action = options.answerAction ?? 'fixed'
      if (action === 'fixed') head = `fix-${reviewPrompts.length}`
      const ids = [...prompt.matchAll(/\*\*(R\d+)\*\*/g)].map((match) => match[1])
      return { summary: 'answered', replies: ids.map((id) => ({ id, action, reply: `reply to ${id}` })), checks: [], blockers: [], ...options.answer }
    },
    push: () => {
      steps.push('push')
      did.pushed += 1
      pushedHead = head
    },
    acknowledge: (item) => void steps.push(`eyes on ${item.id}`),
    reply: (_number, item, body) => {
      if (options.replyFails?.(item.id)) throw new Error('GitHub is down')
      steps.push('reply')
      replies.push({ id: item.id, body, resolved: false })
    },
    // Records what a build stopped at this moment would leave on disk.
    resolve: (thread) => {
      const attempt = resolves.push(thread)
      atResolve.push(structuredClone(world.store.prReport(world.repoId, 1)!))
      if (options.resolveFails?.(attempt)) throw new Error('GitHub is down')
      replies.findLast((reply) => reply.id === thread)!.resolved = true
    },
    requestReview: () => {
      steps.push('re-review')
      did.reReviews += 1
    },
    merge: (_number, observedHead?: string) => {
      did.merged += 1
      did.mergedHeads.push(observedHead)
    },
    wait: async () => void (did.waits += 1),
  }
  const build = () => buildNextPr(started.claim.prs, started.claim, world, workshop, options.reReviewBelow ?? 4, options.rules ?? NO_RULES)
  let report: Awaited<ReturnType<typeof build>>
  try {
    report = await build()
  } catch (error) {
    if (!options.allowInitialError) throw error
    report = world.store.prReport(world.repoId, 1)!
  }
  return { repo, report, build, prompts, merges, events, world, reviews, fixPrompts, excessPrompts, opened, audited: () => audits, reviewPrompts, replies, resolves, atResolve, did, steps, design: () => buildDesign(started.claim.prs, started.claim, world, workshop, options.reReviewBelow ?? 4, options.rules ?? NO_RULES) }
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
const OWNER_THREAD: ReviewItem = { id: 'T2', kind: 'thread', latest: 'c1', fromOwner: true, where: 'App.swift:3', text: 'owner-login: Why not in the other file?' }
const OWNER_COMMENT: ReviewItem = { id: 'comment-5', kind: 'comment', latest: 'c1', fromOwner: true, text: 'Rename the button please' }

test('an approved PR with passing checks is merged, and the design goes on until every PR is merged', async () => {
  const { report, did, design } = await buildPr()
  assert.equal(reviewState(report), 'merged')
  assert.equal(did.merged, 1)
  assert.deepEqual(await design(), { state: 'all PRs merged' })
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
  const { report, did, replies, reviewPrompts } = await buildPr({ github: [{ items: [BOT_THREAD], greptile: { score: 0 } }, { approved: true }] })
  assert.match(reviewPrompts[0], /\*\*R1\*\* \[reviewer\] `App.swift:9`\n  > greptile-apps: this breaks a repo rule/)
  assert.deepEqual(replies, [{ id: 'T1', body: 'reply to R1', resolved: true }])
  assert.deepEqual(did, { pushed: 1, reReviews: 1, merged: 1, mergedHeads: ['fix-1'], waits: 0, afterPushes: [] })
  assert.equal(reviewState(report), 'merged')
})

test('a missing score, or no Greptile at all never asks for a second review', async () => {
  for (const greptile of [{ score: null }, null]) {
    const { did } = await buildPr({ github: [{ items: [BOT_THREAD], greptile }, { approved: true }] })
    assert.deepEqual([did.pushed, did.reReviews], [1, 0])
  }
})

test('the threshold comes from the settings, not from a constant', async () => {
  const github = [{ items: [BOT_THREAD], greptile: { score: 4 } }, { approved: true }]
  assert.equal((await buildPr({ github, reReviewBelow: 5 })).did.reReviews, 1)
  assert.equal((await buildPr({ github, reReviewBelow: 3 })).did.reReviews, 0)
})

test('a human who is not the owner is answered as a reviewer', async () => {
  const human: ReviewItem = { id: 'T3', kind: 'thread', latest: 'c1', fromOwner: false, where: 'App.swift:1', text: 'a-teammate: please rename this' }
  const { reviewPrompts, replies } = await buildPr({ github: [{ items: [human] }, { approved: true }] })
  assert.match(reviewPrompts[0], /\*\*R1\*\* \[reviewer\] `App.swift:1`/)
  assert.deepEqual(replies, [{ id: 'T3', body: 'reply to R1', resolved: true }])
})

test('no second review is asked for when the score was four or more', async () => {
  const { did } = await buildPr({ github: [{ items: [BOT_THREAD], greptile: { score: 4 } }, { approved: true }] })
  assert.deepEqual([did.pushed, did.reReviews], [1, 0])
})

test("the owner's question is answered in the thread with no push, and the thread is left for the owner", async () => {
  const { did, replies } = await buildPr({ github: [{ items: [OWNER_THREAD], greptile: { score: 0 } }, { state: 'closed' }], answerAction: 'answered' })
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

const QA = { afterPush: null, qaRules: 'Record a video of every Done when item.' }
const QA_BLOCK = /## This repo's QA rules \(`factory\/qa-rules\.md` on `feature\/x`\)\n\nRecord a video of every Done when item\.\n$/

test("the repo's QA rules reach the implementer, the break-it pass, the gate fix and the review fix, but not the excess audit", async () => {
  const { prompts, reviews, fixPrompts, excessPrompts, reviewPrompts } = await buildPr({ rules: QA, breaks: [[P3]], github: [{ items: [BOT_THREAD] }, { approved: true }] })
  for (const prompt of [prompts[0], reviews[0], fixPrompts[0], reviewPrompts[0]]) assert.match(prompt, QA_BLOCK)
  assert.doesNotMatch(excessPrompts[0], /QA rules/)
})

test("the repo's QA rules reach the implementer finishing a PR", async () => {
  const { build, prompts } = await buildPr({ rules: QA, result: BLOCKED })
  await build()
  assert.match(prompts[1], /already committed[\s\S]*## This repo's QA rules/)
  assert.match(prompts[1], QA_BLOCK)
})

test('with no QA rules there is no QA rules block', async () => {
  const { build, prompts, reviews, fixPrompts, reviewPrompts } = await buildPr({ result: BLOCKED })
  await build()
  const second = await buildPr({ breaks: [[P3]], github: [{ items: [BOT_THREAD] }, { approved: true }] })
  for (const prompt of [...prompts, ...reviews, ...fixPrompts, ...reviewPrompts, ...second.reviews, ...second.fixPrompts, ...second.reviewPrompts]) {
    assert.doesNotMatch(prompt, /This repo's QA rules \(/)
  }
})

test("QA rules written into the PR's worktree are never used: only the base's are", async () => {
  const { prompts, reviews, reviewPrompts } = await buildPr({
    rules: QA,
    whileImplementing: (worktree) => fs.writeFileSync(path.join(worktree, 'factory', 'qa-rules.md'), 'Screenshots are fine.'),
    github: [{ items: [BOT_THREAD] }, { approved: true }],
  })
  for (const prompt of [prompts[0], reviews[0], reviewPrompts[0]]) assert.doesNotMatch(prompt, /Screenshots are fine/)
  assert.match(reviewPrompts[0], QA_BLOCK)
})

test("the owner's comment gets an eyes reaction before work on it starts, and a bot's does not", async () => {
  const { steps } = await buildPr({ github: [{ items: [OWNER_THREAD, BOT_THREAD] }, { approved: true }] })
  assert.deepEqual(steps.filter((step) => step.startsWith('eyes')), [`eyes on ${OWNER_THREAD.id}`])
})

const GREPTILE_COMMENT = (body: string) => ({ comments: { nodes: [{ id: 'g1', databaseId: 1, author: { login: 'greptile-apps' }, body }] } })
const FAILED_GREPTILE = { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: 'Greptile Review', status: 'COMPLETED', conclusion: 'FAILURE' }] } } } }] } }

function stateWith(overrides: Record<string, unknown>, settings: Settings = SETTINGS) {
  const { workshop, restore } = workshopWithGitHubResponse(githubResponse(overrides), settings)
  try {
    return workshop.pullRequestState(8)
  } finally {
    restore()
  }
}

test('Greptile in use: its score is read from its last comment, and its failed check is hidden', { concurrency: false }, () => {
  const state = stateWith({ ...GREPTILE_COMMENT('Confidence Score: 3/5'), ...FAILED_GREPTILE })
  assert.deepEqual(state.greptile, { score: 3 })
  assert.deepEqual(state.failedChecks, [])
})

test('Greptile in use but silent or unreadable: the score is null', { concurrency: false }, () => {
  assert.deepEqual(stateWith({}).greptile, { score: null })
  assert.deepEqual(stateWith(GREPTILE_COMMENT('looks fine')).greptile, { score: null })
})

test('no Greptile in the settings: no score is read and a check named greptile is not hidden', { concurrency: false }, () => {
  const state = stateWith({ ...GREPTILE_COMMENT('Confidence Score: 3/5'), ...FAILED_GREPTILE }, { ...SETTINGS, greptile: null })
  assert.equal(state.greptile, null)
  assert.deepEqual(state.failedChecks, ['Greptile Review'])
  assert.equal(state.checks, 'failed')
})

test('logins are matched without regard to case', { concurrency: false }, () => {
  const state = stateWith({
    reviews: { nodes: [{ id: 'r1', databaseId: 5, author: { login: 'Owner-Login' }, state: 'APPROVED', body: '', commit: { oid: 'abc' } }] },
    reviewThreads: { nodes: [{ id: 't1', isResolved: false, path: 'a', line: 1, comments: { nodes: [{ id: 'c1', author: { login: 'OWNER-LOGIN' }, body: 'q' }, { id: 'c2', author: { login: 'Bot-Login' }, body: 'a' }] } }] },
  })
  assert.equal(state.approved, true)
  assert.deepEqual(state.items, [])
})

const PUBLISH: RepoRules = { afterPush: { command: 'publish {pr}' }, qaRules: null }
const PUBLISH_CHANGED: RepoRules = { afterPush: { command: 'publish {pr}', whenChanged: '.qa-artifacts/*/result.json' }, qaRules: null }
const record = (worktree: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
  fs.writeFileSync(path.join(worktree, file), text)
}
const storedStamp = (world: World) => world.store.prReport(world.repoId, 1)?.afterPushStamp

test('the after-push command runs once when the PR opens, with the PR number, before the merge', async () => {
  const { did, steps, world } = await buildPr({ rules: PUBLISH })
  assert.deepEqual(did.afterPushes, ['publish 7'])
  assert.deepEqual(steps, ['design marked built', 'opened', 'after push'])
  assert.equal(did.merged, 1)
  assert.equal(storedStamp(world), '')
})

test('without whenChanged the command never runs again, even after a fix is pushed', async () => {
  const { did } = await buildPr({ rules: PUBLISH, github: [{ items: [OWNER_THREAD] }, { approved: true }] })
  assert.deepEqual([did.pushed, did.afterPushes.length], [1, 1])
})

test('with whenChanged the command runs again only when a matched file changed', async () => {
  let round = 0
  const { did } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileImplementing: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'first'),
    whileAnswering: (worktree) => {
      round += 1
      if (round === 1) record(worktree, '.qa-artifacts/a/result.json', 'second')
      else record(worktree, '.qa-artifacts/a/video.mp4', 'new video')
    },
    github: [{ items: [OWNER_THREAD] }, { items: [OWNER_THREAD, OWNER_COMMENT] }, { approved: true }],
  })
  assert.equal(round, 2)
  assert.equal(did.afterPushes.length, 2)
})

test('a command that writes into the matched files is not run again for its own writes', async () => {
  const { did } = await buildPr({
    rules: PUBLISH_CHANGED,
    afterPush: (worktree, run) => record(worktree, '.qa-artifacts/a/result.json', `published ${run}`),
    github: [{}, {}, { approved: true }],
  })
  assert.deepEqual([did.afterPushes.length, did.merged], [1, 1])
})

test('when no file matches, the command does not run and the stored stamp is kept', async () => {
  const { did, world } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileImplementing: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'first'),
    whileAnswering: (worktree) => fs.rmSync(path.join(worktree, '.qa-artifacts'), { recursive: true }),
    answerAction: 'answered',
    github: [{ items: [OWNER_THREAD] }, { approved: true }],
  })
  assert.deepEqual([did.afterPushes.length, did.merged], [1, 1])
  assert.match(storedStamp(world) ?? '', /^[0-9a-f]{64}$/)
})

test('a failed after-push command needs attention and blocks replies, re-review and merge; the next build retries and carries on', async () => {
  const { report, did, replies, reviewPrompts, events, build, world } = await buildPr({
    rules: PUBLISH,
    afterPush: (_worktree, run) => {
      if (run === 1) throw new Error('publish failed:\nno evidence found')
    },
    github: [{ approved: true, items: [OWNER_COMMENT], greptile: { score: 0 } }],
  })
  assert.equal(reviewState(report), 'fix failed')
  assert.match(('review' in report && report.review?.problems.join('\n')) || '', /publish 7[\s\S]*no evidence found/)
  assert.deepEqual([did.merged, did.reReviews, replies.length, reviewPrompts.length], [0, 0, 0, 0])
  assert.equal(events().at(-1), 'pr needs attention')
  assert.equal(storedStamp(world), undefined)
  await build()
  assert.deepEqual([did.afterPushes.length, did.merged], [2, 1])
  assert.equal(storedStamp(world), '')
})

test('an after-push command that commits fails without storing its stamp or merging', async () => {
  const { report, did, world } = await buildPr({
    rules: PUBLISH,
    afterPush: (_worktree, _run, commit) => commit(),
  })
  assert.equal(reviewState(report), 'fix failed')
  assert.match(('review' in report && report.review?.problems.join('\n')) || '', /after-push command `publish 7` made a commit/)
  assert.deepEqual([did.merged, storedStamp(world)], [0, undefined])
})

test("an owner's push to the PR branch is caught up with, and the PR merges without running the command again", async () => {
  const { did, steps } = await buildPr({ rules: PUBLISH, catchUp: 'behind', github: [{}, { head: 'owner-push', approved: true }, { state: 'closed' }] })
  assert.deepEqual(steps.slice(2), ['after push', 'catch up'])
  assert.deepEqual([did.afterPushes.length, did.pushed, did.mergedHeads], [1, 0, ['owner-push']])
})

test('a PR whose first look at GitHub is already behind an owner push catches up, then runs the command for the first time', async () => {
  const { did, steps } = await buildPr({ rules: PUBLISH, catchUp: 'behind', github: [{ head: 'owner-push', approved: true }, { state: 'closed' }] })
  assert.deepEqual(steps.slice(2), ['catch up', 'after push'])
  assert.deepEqual(did.mergedHeads, ['owner-push'])
})

test('replies held for a pushed fix are posted once the worktree has caught up with an owner push on top of it', async () => {
  const bot = { items: [BOT_THREAD], greptile: { score: 0 } }
  const { did, replies, reviewPrompts } = await buildPr({ rules: PUBLISH, catchUp: 'behind', github: [bot, { ...bot, head: 'owner-push', approved: true }, { state: 'closed' }] })
  assert.deepEqual(replies, [{ id: 'T1', body: 'reply to R1', resolved: true }])
  assert.deepEqual([reviewPrompts.length, did.reReviews, did.mergedHeads], [1, 1, ['owner-push']])
})

test('commits a failed fix left unpushed are pushed by the next build, which then carries on', async () => {
  const answer = { checks: [{ command: 'make lint', passed: false }] }
  const { did, steps, build } = await buildPr({ rules: PUBLISH, answer, github: [{ items: [BOT_THREAD] }, { approved: true }] })
  assert.equal(did.pushed, 0)
  assert.equal(reviewState(await build()), 'merged')
  assert.ok(steps.includes('catch up'))
  assert.deepEqual([did.pushed, did.mergedHeads], [1, ['fix-1']])
})

test('a branch that changed on both sides is merged and pushed, then the PR carries on', async () => {
  const { did } = await buildPr({ rules: PUBLISH, catchUp: 'diverged', github: [{ head: 'owner-push' }, { approved: true }] })
  assert.deepEqual([did.pushed, did.afterPushes.length, did.mergedHeads], [1, 1, ['merge-owner-push']])
})

test('a branch that changed on both sides and conflicts needs attention, with nothing run, posted or merged', async () => {
  const { report, did, replies, events } = await buildPr({ rules: PUBLISH, catchUp: 'conflicts', github: [{ head: 'owner-push', approved: true, items: [OWNER_COMMENT], greptile: { score: 0 } }] })
  assert.equal(reviewState(report), 'fix failed')
  assert.match(('review' in report && report.review?.problems.join('\n')) || '', /new commits both on GitHub and in the worktree[\s\S]*conflict/)
  assert.deepEqual([did.afterPushes.length, did.merged, did.pushed, replies.length, did.reReviews], [0, 0, 0, 0, 0])
  assert.equal(events().at(-1), 'pr needs attention')
})

test('a catch-up fetch that sees a newer GitHub head waits for a fresh read', async () => {
  const { did, steps } = await buildPr({ rules: PUBLISH, catchUp: 'changed', github: [{ head: 'owner-push' }, { approved: true }] })
  assert.deepEqual(steps.slice(2), ['catch up', 'after push'])
  assert.deepEqual([did.waits, did.afterPushes.length, did.mergedHeads], [1, 1, ['abc']])
})

test('with no after-push command the worktree is not caught up with GitHub', async () => {
  const { did, steps } = await buildPr({ github: [{ head: 'owner-push', approved: true }] })
  assert.ok(!steps.includes('catch up'))
  assert.deepEqual(did.mergedHeads, ['owner-push'])
})

test('a review fix left unpushed by a failed check is retried on the next build and posted only once GitHub has it; the stored empty stamp keeps the command from running again', async () => {
  const answer = { checks: [{ command: 'make lint', passed: false }] }
  const pending = { items: [BOT_THREAD], greptile: { score: 0 } }
  const { did, replies, reviewPrompts, build } = await buildPr({ rules: PUBLISH, answer, github: [pending, pending, pending, { approved: true }] })
  assert.deepEqual([did.pushed, replies.length], [0, 0])
  answer.checks = []
  assert.equal(reviewState(await build()), 'merged')
  assert.deepEqual([reviewPrompts.length, did.pushed, replies.length, did.reReviews, did.afterPushes.length], [2, 2, 1, 1, 1])
})

test('answers from an unsynchronized pass are posted after its push and after-push command succeed', async () => {
  const answer = { checks: [{ command: 'make lint', passed: false }] }
  let answers = 0
  const pending = { items: [BOT_THREAD], greptile: { score: 0 } }
  const { did, replies, reviewPrompts, build } = await buildPr({
    rules: PUBLISH_CHANGED,
    answer,
    whileAnswering: (worktree) => {
      answers += 1
      if (answers === 2) record(worktree, '.qa-artifacts/a/result.json', 'fixed')
    },
    github: [pending, pending, { items: [BOT_THREAD], greptile: { score: 0 } }, { approved: true }],
  })
  answer.checks = []
  assert.equal(reviewState(await build()), 'merged')
  assert.deepEqual(replies, [{ id: 'T1', body: 'reply to R1', resolved: true }])
  assert.deepEqual([reviewPrompts.length, did.reReviews, did.afterPushes.length], [2, 1, 2])
})

test("an owner's thread whose held reply is posted is not answered again in the same pass", async () => {
  const { replies, reviewPrompts } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileAnswering: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'changed'),
    github: [{ items: [OWNER_THREAD] }, { items: [OWNER_THREAD] }, { state: 'closed' }],
  })
  assert.deepEqual([replies.length, reviewPrompts.length], [1, 1])
})

test('a failed after-push command after a review fix leaves its replies and re-review unposted', async () => {
  const { report, did, replies } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileAnswering: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'changed'),
    afterPush: (_worktree, run) => {
      if (run === 2) throw new Error('publish failed')
    },
    github: [{ items: [BOT_THREAD], greptile: { score: 0 } }],
  })
  assert.equal(reviewState(report), 'fix failed')
  assert.deepEqual([did.pushed, did.reReviews, did.merged, did.afterPushes.length, replies.length], [1, 0, 0, 2, 0])
})

test('replies held when the after-push command fails are kept in the report and posted exactly once by the next build', async () => {
  const bot = { items: [BOT_THREAD], greptile: { score: 0 } }
  const { did, replies, reviewPrompts, build, world } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileAnswering: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'changed'),
    afterPush: (_worktree, run) => {
      if (run === 2) throw new Error('publish failed')
    },
    github: [bot, bot, bot, { state: 'closed' }],
  })
  assert.deepEqual(world.store.prReport(world.repoId, 1)?.held, { replies: [{ item: { id: 'T1', kind: 'thread', latest: BOT_THREAD.latest, fromOwner: false, text: BOT_THREAD.text }, body: 'reply to R1', resolve: true }], reReview: true })
  assert.equal(replies.length, 0)
  assert.equal(reviewState(await build()), 'closed')
  assert.deepEqual(replies, [{ id: 'T1', body: 'reply to R1', resolved: true }])
  assert.deepEqual([did.reReviews, reviewPrompts.length, did.afterPushes.length], [1, 1, 3])
  assert.equal(world.store.prReport(world.repoId, 1)?.held, undefined)
})

test('a held re-review request is dropped when the score on GitHub has since reached the threshold', async () => {
  const bot = { items: [BOT_THREAD], greptile: { score: 0 } }
  const { did, replies, build } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileAnswering: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'changed'),
    afterPush: (_worktree, run) => {
      if (run === 2) throw new Error('publish failed')
    },
    github: [bot, bot, { items: [BOT_THREAD], greptile: { score: 5 } }, { state: 'closed' }],
  })
  assert.equal(reviewState(await build()), 'closed')
  assert.deepEqual([replies.length, did.reReviews], [1, 0])
})

test('a build that stops partway through posting held replies leaves only the unposted ones for the next build', async () => {
  const other: ReviewItem = { ...BOT_THREAD, id: 'T4', where: 'App.swift:4' }
  const bots = { items: [BOT_THREAD, other], greptile: { score: 0 } }
  let down = true
  const { did, replies, build } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileAnswering: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'changed'),
    afterPush: (_worktree, run) => {
      if (run === 2) throw new Error('publish failed')
    },
    replyFails: (id) => id === 'T4' && down,
    github: [bots, bots, bots, { items: [other], greptile: { score: 0 } }, { state: 'closed' }],
  })
  await assert.rejects(build(), /GitHub is down/)
  down = false
  assert.equal(reviewState(await build()), 'closed')
  assert.deepEqual([replies.map(({ id }) => id), did.reReviews], [['T1', 'T4'], 1])
})

test('a failed first immediate reply keeps the held queue for the next build', async () => {
  const { world, build } = await buildPr({ github: [{ items: [BOT_THREAD] }], replyFails: () => true, allowInitialError: true })
  await assert.rejects(build(), /GitHub is down/)
  assert.deepEqual(world.store.prReport(world.repoId, 1)?.held, { replies: [{ item: { id: 'T1', kind: 'thread', latest: BOT_THREAD.latest, fromOwner: false, text: BOT_THREAD.text }, body: 'reply to R1', resolve: true }], reReview: false })
})

test('a held reply does not resolve or hide a thread changed by the owner', async () => {
  const ownerUpdate: ReviewItem = { ...BOT_THREAD, latest: 'owner-comment', fromOwner: true, text: 'owner-login: please also cover the new case' }
  const { replies, reviewPrompts, build } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileAnswering: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'changed'),
    afterPush: (_worktree, run) => {
      if (run === 2) throw new Error('publish failed')
    },
    github: [{ items: [BOT_THREAD] }, { items: [ownerUpdate] }, { items: [ownerUpdate] }, { state: 'closed' }],
  })
  assert.equal(reviewState(await build()), 'closed')
  assert.deepEqual(replies[0], { id: 'T1', body: 'reply to R1', resolved: false })
  assert.equal(reviewPrompts.length, 2)
})

test('a review fix is replied to only after after-push succeeds on its new head', async () => {
  const { did, replies, steps } = await buildPr({
    rules: PUBLISH_CHANGED,
    whileAnswering: (worktree) => record(worktree, '.qa-artifacts/a/result.json', 'changed'),
    github: [{ items: [BOT_THREAD], greptile: { score: 0 } }, { approved: true, items: [BOT_THREAD], greptile: { score: 0 } }],
  })
  assert.deepEqual(replies, [{ id: 'T1', body: 'reply to R1', resolved: true }])
  assert.deepEqual(did.afterPushes, ['publish 7', 'publish 7'])
  assert.deepEqual(steps.slice(-3), ['after push', 'reply', 're-review'])
})

test('a thread that fails to resolve after its reply posted is resolved on the next pass without replying again', async () => {
  const { report, replies, resolves } = await buildPr({ resolveFails: (attempt) => attempt === 1, github: [{ items: [BOT_THREAD] }, { approved: true }] })
  assert.equal(reviewState(report), 'merged')
  assert.deepEqual([replies, resolves], [[{ id: 'T1', body: 'reply to R1', resolved: true }], ['T1', 'T1']])
})

test('a thread that keeps failing to resolve stops the build with the reason, and the next build resolves it without replying again', async () => {
  let down = true
  const { report, replies, resolves, world, build } = await buildPr({ resolveFails: () => down, github: [{ items: [BOT_THREAD] }, { approved: true }] })
  assert.equal(reviewState(report), 'fix failed')
  assert.match(('review' in report && report.review?.problems.join('\n')) || '', /review thread T1 was posted, but resolving the thread failed 3 times \(GitHub is down\)/)
  assert.equal(world.store.prReport(world.repoId, 1)?.held?.replies[0].posted, true)
  down = false
  assert.equal(reviewState(await build()), 'merged')
  assert.deepEqual([replies, resolves.length], [[{ id: 'T1', body: 'reply to R1', resolved: true }], 4])
})

test('a build stopped between posting a reply and resolving its thread only resolves it next time', async () => {
  const { replies, resolves, atResolve, world, build } = await buildPr({ github: [{ items: [BOT_THREAD] }, { approved: true }] })
  world.store.savePrReport(world.repoId, atResolve[0])
  assert.equal(reviewState(await build()), 'merged')
  assert.deepEqual([replies, resolves], [[{ id: 'T1', body: 'reply to R1', resolved: true }], ['T1', 'T1']])
})

const unpushedFailure = { answer: { checks: [{ command: 'make lint', passed: false }] }, answerAction: 'answered' as const }

test("a resumed last PR whose branch moved on GitHub merges GitHub's commits into its design move and pushes, never a plain push", async () => {
  let moved = false
  const { report, did, steps, world, build } = await buildPr({ ...unpushedFailure, catchUp: 'diverged', designMovedAgain: () => moved, github: [{ items: [OWNER_COMMENT] }, { head: 'owner-push' }, { approved: true }] })
  assert.equal(reviewState(report), 'fix failed')
  moved = true
  assert.equal(reviewState(await build()), 'merged')
  assert.deepEqual([steps.includes('catch up'), steps.includes('push'), did.mergedHeads], [true, false, ['merge-owner-push']])
  assert.equal(world.store.prReport(world.repoId, 1)?.mustCatchUp, undefined)
})

test('a resumed last PR whose design move conflicts with GitHub needs attention, and the build after the owner resolves it pushes and merges', async () => {
  let moved = true
  const options = { ...unpushedFailure, catchUp: 'conflicts' as 'conflicts' | undefined, designMovedAgain: () => moved, github: [{ items: [OWNER_COMMENT] }, { head: 'owner-push' }, { head: 'owner-push' }, { approved: true }] }
  const { did, build } = await buildPr(options)
  const conflicted = await build()
  assert.equal(reviewState(conflicted), 'fix failed')
  assert.match(('review' in conflicted && conflicted.review?.problems.join('\n')) || '', /new commits both on GitHub and in the worktree[\s\S]*merge origin\/factory\/001-first\/pr-1, resolve the conflicts/)
  assert.deepEqual([did.pushed, did.merged], [0, 0])
  moved = false
  options.catchUp = undefined
  assert.equal(reviewState(await build()), 'merged')
  assert.deepEqual(did.mergedHeads, ['design-moved'])
})

test('a review fix whose push finds new commits on GitHub merges them in and pushes before replying', async () => {
  const { did, replies, steps } = await buildPr({ catchUp: 'diverged', github: [{ head: 'owner-push', items: [BOT_THREAD] }, { approved: true }] })
  assert.deepEqual([steps.includes('push'), replies.length, did.mergedHeads], [false, 1, ['merge-owner-push']])
})

test('a review fix whose push conflicts with GitHub keeps its replies until the build after the owner resolves it has pushed', async () => {
  const options = { catchUp: 'conflicts' as 'conflicts' | undefined, github: [{ head: 'owner-push', items: [BOT_THREAD] }, { head: 'owner-push' }, { approved: true }] }
  const { report, did, replies, steps, build } = await buildPr(options)
  assert.equal(reviewState(report), 'fix failed')
  assert.deepEqual([did.pushed, replies.length], [0, 0])
  options.catchUp = undefined
  assert.equal(reviewState(await build()), 'merged')
  assert.deepEqual([replies.length, did.mergedHeads], [1, ['fix-1']])
  assert.ok(steps.indexOf('reply') > steps.lastIndexOf('catch up'))
})

test('the after-push command runs in the worktree with the bot token and fails with its last output', { concurrency: false }, async () => {
  const { workshop, restore } = workshopWithGitHubResponse(githubResponse())
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-after-push-'))
  try {
    await workshop.afterPush(worktree, 'printf "%s" "$GH_TOKEN" > token.txt')
    assert.equal(fs.readFileSync(path.join(worktree, 'token.txt'), 'utf8'), 'token')
    await assert.rejects(workshop.afterPush(worktree, 'echo first; echo stale evidence >&2; exit 3'), /exit 3[\s\S]*stale evidence/)
  } finally {
    restore()
  }
})

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const eventually = async (condition: () => boolean) => {
  for (let tries = 0; tries < 100 && !condition(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  return condition()
}
const BACKGROUND_CHILD = 'sleep 300 & echo $! > child.pid; wait'
const TERM_IGNORING_BACKGROUND_CHILD = "trap '' TERM; sleep 300 & echo $! > child.pid; wait"
const childPid = (worktree: string) => Number(fs.readFileSync(path.join(worktree, 'child.pid'), 'utf8'))

test('an after-push command that runs past its time limit is stopped along with every process it started', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-after-push-'))
  await assert.rejects(runAfterPush(worktree, BACKGROUND_CHILD, process.env, 300), /ran past .* minutes and was stopped/)
  assert.equal(await eventually(() => !running(childPid(worktree))), true)
})

test('stopping the build with Ctrl-C stops the after-push command and every process it started', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-after-push-'))
  const workshopFile = path.resolve(import.meta.dirname, '..', 'lib', 'workshop.ts')
  const script = `import { runAfterPush } from ${JSON.stringify(workshopFile)}; await runAfterPush(process.env.WORKTREE, ${JSON.stringify(BACKGROUND_CHILD)}, process.env, 60000)`
  const build = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', env: { ...process.env, WORKTREE: worktree } })
  assert.equal(await eventually(() => fs.existsSync(path.join(worktree, 'child.pid')) && childPid(worktree) > 0), true)
  build.kill('SIGINT')
  const [, signal] = await once(build, 'exit')
  assert.equal(signal, 'SIGINT')
  assert.equal(await eventually(() => !running(childPid(worktree))), true)
})

test('stopping the build with Ctrl-C force-stops a descendant that ignores SIGTERM', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-after-push-'))
  const workshopFile = path.resolve(import.meta.dirname, '..', 'lib', 'workshop.ts')
  const script = `import { runAfterPush } from ${JSON.stringify(workshopFile)}; await runAfterPush(process.env.WORKTREE, ${JSON.stringify(TERM_IGNORING_BACKGROUND_CHILD)}, process.env, 60000)`
  const build = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', env: { ...process.env, WORKTREE: worktree } })
  assert.equal(await eventually(() => fs.existsSync(path.join(worktree, 'child.pid')) && childPid(worktree) > 0), true)
  build.kill('SIGINT')
  const [, signal] = await once(build, 'exit')
  assert.equal(signal, 'SIGINT')
  assert.equal(await eventually(() => !running(childPid(worktree))), true)
})

const AUTHOR = { GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' }
const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...AUTHOR } }).trim()
const commitIn = (dir: string, file: string, text: string) => {
  fs.writeFileSync(path.join(dir, file), text)
  gitIn(dir, 'add', file)
  gitIn(dir, 'commit', '-m', `change ${file}`)
  return gitIn(dir, 'rev-parse', 'HEAD')
}

// A PR branch on a local remote, the factory's worktree of it, and the owner's own clone.
function prBranchOnBothSides() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-catch-up-'))
  const remote = path.join(root, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', remote])
  const worktree = path.join(root, 'worktree')
  const owner = path.join(root, 'owner')
  execFileSync('git', ['clone', '-q', remote, worktree], { stdio: 'pipe' })
  gitIn(worktree, 'checkout', '-q', '-b', 'pr')
  commitIn(worktree, 'a.txt', 'first\n')
  gitIn(worktree, 'push', '-q', 'origin', 'pr')
  execFileSync('git', ['clone', '-q', '-b', 'pr', remote, owner], { stdio: 'pipe' })
  const real = realWorkshop('/tmp/repo', 'owner/app', '/tmp/worktrees', '/tmp/runs', SETTINGS)
  const workshop: Workshop = { ...real, push: (dir, branch) => void gitIn(dir, 'push', '-q', 'origin', branch) }
  const onGitHub = () => gitIn(remote, 'rev-parse', 'pr')
  return { worktree, owner, workshop, onGitHub }
}

test('catching up with an owner push fast-forwards the worktree', () => {
  const { worktree, owner, workshop } = prBranchOnBothSides()
  const theirs = commitIn(owner, 'b.txt', 'owner\n')
  gitIn(owner, 'push', '-q', 'origin', 'pr')
  assert.equal(workshop.catchUp(worktree, 'pr', theirs), 'fast-forwarded')
  assert.equal(gitIn(worktree, 'rev-parse', 'HEAD'), theirs)
})

test('catching up pushes commits only the worktree has', () => {
  const { worktree, workshop, onGitHub } = prBranchOnBothSides()
  const theirs = onGitHub()
  const ours = commitIn(worktree, 'b.txt', 'fix\n')
  assert.equal(workshop.catchUp(worktree, 'pr', theirs), 'pushed')
  assert.equal(onGitHub(), ours)
})

test("catching up a branch changed on both sides merges GitHub's commits in as the bot and pushes, keeping the owner's", () => {
  const { worktree, owner, workshop, onGitHub } = prBranchOnBothSides()
  const theirs = commitIn(owner, 'b.txt', 'owner\n')
  gitIn(owner, 'push', '-q', 'origin', 'pr')
  const ours = commitIn(worktree, 'c.txt', 'fix\n')
  assert.equal(workshop.catchUp(worktree, 'pr', theirs), 'pushed')
  const merged = gitIn(worktree, 'rev-parse', 'HEAD')
  assert.equal(onGitHub(), merged)
  assert.deepEqual(gitIn(worktree, 'rev-parse', 'HEAD^1', 'HEAD^2').split('\n'), [ours, theirs])
  assert.equal(gitIn(worktree, 'log', '-1', '--format=%an'), 'Bot')
})

test('a branch changed on both sides that conflicts is left as it was, on GitHub and in the worktree', () => {
  const { worktree, owner, workshop, onGitHub } = prBranchOnBothSides()
  const theirs = commitIn(owner, 'a.txt', 'owner\n')
  gitIn(owner, 'push', '-q', 'origin', 'pr')
  const ours = commitIn(worktree, 'a.txt', 'fix\n')
  assert.equal(workshop.catchUp(worktree, 'pr', theirs), 'conflicts')
  assert.deepEqual([gitIn(worktree, 'rev-parse', 'HEAD'), onGitHub(), gitIn(worktree, 'status', '--porcelain')], [ours, theirs, ''])
})
