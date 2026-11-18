import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { abandon, repoIdFromRemote, startOrResume } from '../lib/build.ts'
import type { World } from '../lib/build.ts'
import { readDesign } from '../lib/design.ts'
import { recordApprovedPlan } from '../lib/readiness.ts'
import { buildNextPr } from '../lib/implement.ts'
import type { Workshop } from '../lib/implement.ts'
import { diskStore } from '../lib/store.ts'
import type { Implementation } from '../lib/store.ts'

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

async function buildPr(options: { result?: Implementation; uncommitted?: string[]; commits?: string[]; worktree?: string; whileImplementing?: (worktree: string) => void; merge?: 'merged' | 'conflicts' } = {}) {
  const { repo, world, events } = setup([['001-first', true]])
  const started = startOrResume(repo, world, 'feature/x')
  assert.equal(started.state, 'started')
  if (started.state !== 'started') throw new Error('not started')
  const prompts: string[] = []
  const merges: string[] = []
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
    commitMessages: () => options.commits ?? ['add the thing'],
    uncommittedFiles: () => options.uncommitted ?? [],
  }
  const build = () => buildNextPr(started.prs, started.claim, world, workshop)
  return { repo, report: await build(), build, prompts, merges, events }
}

test('the first PR is implemented on its own branch from the plan section', async () => {
  const { report, prompts, events } = await buildPr()
  assert.equal(report.state, 'implemented')
  assert.equal(report.state === 'implemented' && report.branch, 'factory/001-first/pr-1')
  assert.match(prompts[0], /PR 1, "feature: do the thing"/)
  assert.match(prompts[0], /cut from `feature\/x`/)
  assert.deepEqual(events(), ['design claimed', 'pr started', 'pr implemented'])
})

test('once every PR is implemented nothing more is run', async () => {
  const { build, prompts } = await buildPr()
  assert.deepEqual(await build(), { state: 'all PRs implemented' })
  assert.equal(prompts.length, 1)
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
