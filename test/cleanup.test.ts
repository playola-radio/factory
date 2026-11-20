import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { removeDesignWorktrees, removeWorktree, scratchDir } from '../lib/cleanup.ts'

const IDENT = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim()

// A bare "origin", a clone that stands in for the factory's repo checkout, and an empty worktrees dir beside it.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cleanup-'))
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  const worktreesDir = path.join(root, 'worktrees')
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'clone', origin, repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'seed')
  git(repo, 'push', 'origin', 'main')
  fs.mkdirSync(worktreesDir, { recursive: true })
  return { root, origin, repo, worktreesDir }
}

// Adds a factory worktree on `branch`, optionally with its own commit, pushed to origin, and/or untracked build junk.
function addWorktree(
  repo: string,
  worktreesDir: string,
  branch: string,
  { commit = true, push = true, untracked = false } = {},
) {
  const worktree = path.join(worktreesDir, branch.replaceAll('/', '__'))
  git(repo, 'worktree', 'add', '-b', branch, worktree, 'origin/main')
  if (commit) {
    fs.writeFileSync(path.join(worktree, 'work.txt'), branch)
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-m', `work on ${branch}`)
  }
  if (push) git(worktree, 'push', '-u', 'origin', branch)
  if (untracked) fs.writeFileSync(path.join(worktree, 'DerivedData-build.o'), 'x'.repeat(1000))
  return worktree
}

test('removes a fully pushed worktree, its local branch, and its scratch folder', () => {
  const { repo, worktreesDir } = makeRepo()
  const branch = 'factory/001-x/pr-1'
  const worktree = addWorktree(repo, worktreesDir, branch)
  const scratch = scratchDir(worktreesDir, worktree)
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'tmpfile'), 'junk')

  assert.equal(removeWorktree(repo, worktreesDir, worktree, branch, 'main'), true)

  assert.equal(fs.existsSync(worktree), false)
  assert.equal(fs.existsSync(scratch), false)
  assert.doesNotMatch(git(repo, 'branch', '--list', branch), /factory/)
})

test('keeps a worktree that has a commit not on its remote branch', () => {
  const { repo, worktreesDir } = makeRepo()
  const branch = 'factory/001-x/pr-1'
  const worktree = addWorktree(repo, worktreesDir, branch, { commit: true, push: false })

  assert.equal(removeWorktree(repo, worktreesDir, worktree, branch, 'main'), false)
  assert.equal(fs.existsSync(worktree), true)
})

test('force-removes a pushed worktree even when it holds untracked build files', () => {
  const { repo, worktreesDir } = makeRepo()
  const branch = 'factory/001-x/pr-1'
  const worktree = addWorktree(repo, worktreesDir, branch, { untracked: true })

  assert.equal(removeWorktree(repo, worktreesDir, worktree, branch, 'main'), true)
  assert.equal(fs.existsSync(worktree), false)
})

test("removes the design's pushed worktrees but keeps an unpushed one and the base worktree", () => {
  const { repo, worktreesDir } = makeRepo()
  const pr1 = addWorktree(repo, worktreesDir, 'factory/001-x/pr-1')
  const pr2 = addWorktree(repo, worktreesDir, 'factory/001-x/pr-2', { commit: true, push: false })
  const other = addWorktree(repo, worktreesDir, 'factory/002-y/pr-1')
  const base = path.join(worktreesDir, 'base')
  git(repo, 'worktree', 'add', '--detach', base, 'origin/main')

  const result = removeDesignWorktrees(repo, worktreesDir, '001-x', 'main')

  assert.deepEqual(result, { removed: ['factory/001-x/pr-1'], kept: ['factory/001-x/pr-2'] })
  assert.equal(fs.existsSync(pr1), false)
  assert.equal(fs.existsSync(pr2), true)
  assert.equal(fs.existsSync(other), true)
  assert.equal(fs.existsSync(base), true)
})

test('scratchDir is a per-worktree folder under the worktrees dir, outside the worktree itself', () => {
  const worktreesDir = '/home/.factory/worktrees/owner__app'
  const worktree = path.join(worktreesDir, 'factory__001-x__pr-1')
  const scratch = scratchDir(worktreesDir, worktree)
  assert.equal(scratch, path.join(worktreesDir, '.scratch', 'factory__001-x__pr-1'))
  assert.equal(scratch.startsWith(worktree), false)
})

test('the build and test prompts tell the agent to use its factory-owned scratch dir', () => {
  const promptsDir = path.join(import.meta.dirname, '..', 'prompts')
  for (const name of ['implement', 'finish', 'gate-fix', 'review-fix']) {
    const text = fs.readFileSync(path.join(promptsDir, `${name}.md`), 'utf8')
    assert.match(text, /TMPDIR/, `${name}.md should mention TMPDIR`)
  }
})
