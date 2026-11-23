import assert from 'node:assert/strict'
import test from 'node:test'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadWatchConfig, realWatchEffects, spawnTree, watch } from '../lib/watch.ts'
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

// Like runsUntilStopped, but done resolves on a later tick after stop() — modelling a real child that takes a
// moment to exit, so a watcher that forgot to await it would return too early.
function runsUntilStoppedAsync(onResolved: () => void): BuildHandle {
  let resolve!: (code: number) => void
  const done = new Promise<number>((r) => { resolve = r })
  return { done, stop: () => setTimeout(() => { onResolved(); resolve(143) }, 5) }
}

// Drives `watch` for `passes` sleeps, then stops. `startBuild` is the fake under test.
async function drive(opts: { repos: RepoConfig[]; startBuild: WatchEffects['startBuild']; passes: number; paused?: Map<string, number> }) {
  let stopResolve!: () => void
  const stop = new Promise<void>((r) => { stopResolve = r })
  let passCount = 0
  const logs: string[] = []
  const effects: WatchEffects = {
    startBuild: opts.startBuild,
    log: (message) => logs.push(message),
    sleep: (_ms: number, _signal: AbortSignal) => {
      passCount += 1
      if (passCount >= opts.passes) {
        stopResolve()
        return new Promise<void>(() => {})
      }
      return Promise.resolve()
    },
  }
  await watch({ pollSeconds: 1, repos: opts.repos }, effects, stop, opts.paused)
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

test('a paused repo is shared with its exit code, so the page can say it stopped', async () => {
  const paused = new Map<string, number>()
  await drive({ repos: [{ path: '/a', base: 'develop' }, { path: '/b', base: 'main' }], startBuild: (repo) => exits(repo.path === '/a' ? 2 : 0), passes: 2, paused })
  assert.deepEqual([...paused], [['/a', 2]])
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

test('waits for a stopped child to exit before returning', async () => {
  let doneResolved = false
  await drive({
    repos: [{ path: '/a', base: 'develop' }],
    startBuild: () => runsUntilStoppedAsync(() => { doneResolved = true }),
    passes: 1,
  })
  // watch() only returns after awaiting every child's done; the child here resolves on a later tick.
  assert.equal(doneResolved, true)
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('stopping a build kills the agents it spawned, not just its own process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-tree-'))
  const pidFile = path.join(dir, 'grandchild.pid')
  // The "build" spawns a "claude" that records its pid and lingers. Only a process-group kill reaches it.
  fs.writeFileSync(path.join(dir, 'grandchild.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
  fs.writeFileSync(path.join(dir, 'build.js'), `require('child_process').spawn(process.execPath, [${JSON.stringify(path.join(dir, 'grandchild.js'))}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`)

  const handle = spawnTree(process.execPath, [path.join(dir, 'build.js')])
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await delay(10)
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(alive(grandchild), true, 'the agent should be running before we stop')

  handle.stop()
  await handle.done
  for (let i = 0; i < 100 && alive(grandchild); i++) await delay(10)
  assert.equal(alive(grandchild), false, 'the agent must be killed when the build is stopped')
})

test('a build never sees the token for reporting to marge', async (t) => {
  const previous = process.env.FACTORY_REPORT_TOKEN
  process.env.FACTORY_REPORT_TOKEN = 'secret-token'
  t.after(() => {
    if (previous === undefined) delete process.env.FACTORY_REPORT_TOKEN
    else process.env.FACTORY_REPORT_TOKEN = previous
  })
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-env-')), 'seen')
  const handle = spawnTree(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, String(process.env.FACTORY_REPORT_TOKEN))`])
  assert.equal(await handle.done, 0)
  assert.equal(fs.readFileSync(out, 'utf8'), 'undefined')
})

test('a sleep is cut short when its signal aborts', async () => {
  const effects = realWatchEffects('/does/not/matter')
  const controller = new AbortController()
  const started = Date.now()
  const sleeping = effects.sleep(60_000, controller.signal)
  controller.abort()
  await sleeping
  assert.ok(Date.now() - started < 1_000, 'aborting the signal should resolve the sleep at once')
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
