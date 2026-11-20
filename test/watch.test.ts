import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWatchConfig, watch } from '../lib/watch.ts'
import type { BuildHandle, RepoConfig, WatchEffects } from '../lib/watch.ts'

const anyGit = () => true

test('defaults pollSeconds to 300', () => {
  const config = loadWatchConfig(JSON.stringify({ repos: [{ path: '/r', base: 'develop' }] }), anyGit, '/Users/x')
  assert.equal(config.pollSeconds, 300)
})

test('expands a leading ~/ in a repo path', () => {
  const config = loadWatchConfig(JSON.stringify({ repos: [{ path: '~/playola/app', base: 'develop' }] }), anyGit, '/Users/x')
  assert.equal(config.repos[0].path, '/Users/x/playola/app')
})

test('keeps pollSeconds when given', () => {
  const config = loadWatchConfig(JSON.stringify({ pollSeconds: 60, repos: [{ path: '/r', base: 'develop' }] }), anyGit, '/Users/x')
  assert.equal(config.pollSeconds, 60)
})

test('requires base on every repo', () => {
  assert.throws(() => loadWatchConfig(JSON.stringify({ repos: [{ path: '/r' }] }), anyGit, '/Users/x'), /base/)
})

test('rejects a path that is not a git clone', () => {
  assert.throws(() => loadWatchConfig(JSON.stringify({ repos: [{ path: '/r', base: 'develop' }] }), () => false, '/Users/x'), /not a git[\s\S]*\/r/i)
})

test('rejects two entries for the same repo', () => {
  const text = JSON.stringify({ repos: [{ path: '/r', base: 'develop' }, { path: '/r', base: 'main' }] })
  assert.throws(() => loadWatchConfig(text, anyGit, '/Users/x'), /same repo|twice/i)
})

test('rejects an unknown top-level field', () => {
  const text = JSON.stringify({ repos: [{ path: '/r', base: 'develop' }], nonsense: 1 })
  assert.throws(() => loadWatchConfig(text, anyGit, '/Users/x'), /nonsense/)
})

test('rejects an unknown field on a repo', () => {
  const text = JSON.stringify({ repos: [{ path: '/r', base: 'develop', extra: 1 }] })
  assert.throws(() => loadWatchConfig(text, anyGit, '/Users/x'), /extra/)
})

test('rejects a non-positive pollSeconds', () => {
  const text = JSON.stringify({ pollSeconds: 0, repos: [{ path: '/r', base: 'develop' }] })
  assert.throws(() => loadWatchConfig(text, anyGit, '/Users/x'), /pollSeconds/)
})

test('rejects when repos is missing or empty', () => {
  assert.throws(() => loadWatchConfig(JSON.stringify({}), anyGit, '/Users/x'), /repos/)
  assert.throws(() => loadWatchConfig(JSON.stringify({ repos: [] }), anyGit, '/Users/x'), /repos/)
})

// --- the driver ---

// A build child whose done resolves immediately to `code`.
function exits(code: number): BuildHandle {
  return { done: Promise.resolve(code), stop: () => {} }
}

// A build child whose done stays pending until stop() is called, then resolves to 143 (SIGTERM).
function runsUntilStopped(onStop?: () => void): BuildHandle {
  let resolve!: (code: number) => void
  const done = new Promise<number>((r) => { resolve = r })
  return { done, stop: () => { onStop?.(); resolve(143) } }
}

// Drives `watch` for `passes` sleeps, then stops. `startBuild` is the fake under test.
async function drive(opts: { repos: RepoConfig[]; startBuild: WatchEffects['startBuild']; passes: number }) {
  let stopResolve!: () => void
  const stop = new Promise<void>((r) => { stopResolve = r })
  let passCount = 0
  const logs: string[] = []
  const effects: WatchEffects = {
    startBuild: opts.startBuild,
    log: (message) => logs.push(message),
    sleep: () => {
      passCount += 1
      if (passCount >= opts.passes) {
        stopResolve()
        return new Promise<void>(() => {})
      }
      return Promise.resolve()
    },
  }
  await watch({ pollSeconds: 1, repos: opts.repos }, effects, stop)
  return { logs }
}

test('starts a build for each repo and restarts after a clean exit', async () => {
  const starts: string[] = []
  await drive({
    repos: [{ path: '/a', base: 'develop' }, { path: '/b', base: 'main' }],
    startBuild: (repo) => { starts.push(repo.path); return exits(0) },
    passes: 2,
  })
  assert.equal(starts.filter((p) => p === '/a').length, 2)
  assert.equal(starts.filter((p) => p === '/b').length, 2)
})

test('does not restart a repo after a non-zero exit', async () => {
  const starts: string[] = []
  await drive({
    repos: [{ path: '/a', base: 'develop' }],
    startBuild: (repo) => { starts.push(repo.path); return exits(2) },
    passes: 3,
  })
  assert.equal(starts.length, 1)
})

test('leaves a running build alone across passes', async () => {
  const starts: string[] = []
  await drive({
    repos: [{ path: '/a', base: 'develop' }],
    startBuild: (repo) => { starts.push(repo.path); return runsUntilStopped() },
    passes: 3,
  })
  assert.equal(starts.length, 1)
})

test('stops running children on shutdown', async () => {
  let stopped = false
  await drive({
    repos: [{ path: '/a', base: 'develop' }],
    startBuild: () => runsUntilStopped(() => { stopped = true }),
    passes: 1,
  })
  assert.equal(stopped, true)
})

test('a clean exit for one repo does not un-pause another', async () => {
  const starts: string[] = []
  await drive({
    repos: [{ path: '/a', base: 'develop' }, { path: '/b', base: 'develop' }],
    startBuild: (repo) => { starts.push(repo.path); return exits(repo.path === '/a' ? 0 : 2) },
    passes: 2,
  })
  assert.equal(starts.filter((p) => p === '/a').length, 2)
  assert.equal(starts.filter((p) => p === '/b').length, 1)
})
