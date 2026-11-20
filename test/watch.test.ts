import assert from 'node:assert/strict'
import test from 'node:test'

import {
  interpretExit,
  loadWatchConfig,
  Notifier,
  parseBuildReports,
  releaseReason,
  startedFromStderrLine,
  startedNotification,
  watcherErrorNotification,
} from '../lib/watch.ts'
import type { Notification } from '../lib/watch.ts'

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

test('reads the started line', () => {
  assert.deepEqual(startedFromStderrLine('started: 001-first on develop. Agent traces: /x/traces'), {
    design: '001-first',
    base: 'develop',
    resumed: false,
  })
})

test('reads the resumed line', () => {
  assert.deepEqual(startedFromStderrLine('already in progress: 002 on main. Agent traces: /x'), {
    design: '002',
    base: 'main',
    resumed: true,
  })
})

test('ignores an unrelated stderr line', () => {
  assert.equal(startedFromStderrLine('something else entirely'), null)
})

test('parses one report', () => {
  const report = { state: 'nothing to build' }
  assert.deepEqual(parseBuildReports(JSON.stringify(report, null, 2)), [report])
})

test('parses several concatenated reports in order', () => {
  const a = { design: '001', state: 'all PRs merged' }
  const b = { state: 'nothing to build' }
  const text = `${JSON.stringify(a, null, 2)}\n${JSON.stringify(b, null, 2)}\n`
  assert.deepEqual(parseBuildReports(text), [a, b])
})

test('parses a report whose strings contain braces', () => {
  const report = { state: 'stopped', reason: 'PR {1} needs }attention{ "now"' }
  assert.deepEqual(parseBuildReports(JSON.stringify(report, null, 2)), [report])
})

test('returns empty for empty or whitespace input', () => {
  assert.deepEqual(parseBuildReports(''), [])
  assert.deepEqual(parseBuildReports('  \n  '), [])
})

test('a started build notifies build started', () => {
  const n = startedNotification({ design: '001', base: 'develop', resumed: false }, 'o/a', 'T')
  assert.equal(n.kind, 'build started')
  assert.equal(n.repo, 'o/a')
  assert.equal(n.design, '001')
  assert.ok(n.summary.length > 0)
})

test('a resumed build says so', () => {
  const n = startedNotification({ design: '001', base: 'develop', resumed: true }, 'o/a', 'T')
  assert.match(n.summary, /resum|pick/i)
})

test('nothing to build holds nothing', () => {
  assert.deepEqual(interpretExit(0, [{ state: 'nothing to build' }], 'o/a', 'T'), { notifications: [], hold: false })
})

test('each merged design finishes', () => {
  const result = interpretExit(0, [{ state: 'all PRs merged', design: '001' }, { state: 'nothing to build' }], 'o/a', 'T')
  assert.equal(result.hold, false)
  assert.deepEqual(result.notifications.map((n) => [n.kind, n.design]), [['design finished', '001']])
})

test('needs attention is retried, not held', () => {
  const result = interpretExit(2, [{ state: 'needs attention', design: '003', number: 2, problems: ['x'] }], 'o/a', 'T')
  assert.equal(result.hold, false)
  assert.deepEqual(result.notifications, [])
})

test('a stopped PR holds and explains', () => {
  const reason = 'PR 2 still needs attention after 3 attempts: Check failed: make test.'
  const result = interpretExit(2, [{ state: 'stopped', design: '003', number: 2, reason }], 'o/a', 'T')
  assert.equal(result.hold, true)
  assert.equal(result.notifications.length, 1)
  assert.equal(result.notifications[0].kind, 'build stopped')
  assert.match(result.notifications[0].summary, /after 3 attempts/)
})

test('an unclean gate holds', () => {
  const result = interpretExit(2, [{ state: 'implemented', design: '003', number: 1, worktree: '/w', gate: { state: 'fix failed', problems: ['Check failed: make test'] } }], 'o/a', 'T')
  assert.equal(result.hold, true)
  assert.equal(result.notifications[0].kind, 'build stopped')
  assert.match(result.notifications[0].summary, /gate|fix failed/i)
})

test('a closed review holds', () => {
  const result = interpretExit(2, [{ state: 'implemented', design: '003', number: 1, pullRequest: { number: 7, url: 'u' }, review: { state: 'closed', problems: [] } }], 'o/a', 'T')
  assert.equal(result.hold, true)
  assert.match(result.notifications[0].summary, /closed/i)
})

test('a thrown build error holds', () => {
  const result = interpretExit(1, [], 'o/a', 'T', 'boom went the build')
  assert.equal(result.hold, true)
  assert.equal(result.notifications[0].kind, 'build stopped')
  assert.match(result.notifications[0].summary, /boom went the build/)
})

test('not buildable holds', () => {
  const result = interpretExit(1, [{ state: 'not buildable', design: '003', reasons: ['no finished plan'] }], 'o/a', 'T')
  assert.equal(result.hold, true)
  assert.match(result.notifications[0].summary, /no finished plan/)
})

test('a finished design before a stop both notify', () => {
  const result = interpretExit(2, [
    { state: 'all PRs merged', design: '001' },
    { state: 'stopped', design: '002', number: 1, reason: 'closed' },
  ], 'o/a', 'T')
  assert.equal(result.hold, true)
  assert.deepEqual(result.notifications.map((n) => n.kind), ['design finished', 'build stopped'])
})

test('releaseReason sees a moved base', () => {
  assert.match(releaseReason({ baseCommit: 'a', claim: 'c' }, { baseCommit: 'b', claim: 'c' })!, /base/)
})

test('releaseReason sees a changed claim', () => {
  assert.match(releaseReason({ baseCommit: 'a', claim: 'c' }, { baseCommit: 'a', claim: 'c2' })!, /claim/)
})

test('releaseReason stays held when nothing changed', () => {
  assert.equal(releaseReason({ baseCommit: 'a', claim: 'c' }, { baseCommit: 'a', claim: 'c' }), null)
})

function collector() {
  const written: Notification[] = []
  const notifier = new Notifier((n) => written.push(n))
  return { written, notifier }
}

test('the notifier skips an identical repeat', () => {
  const { written, notifier } = collector()
  const n: Notification = { at: 'T', kind: 'build stopped', repo: 'o/a', design: '003', summary: 'same' }
  notifier.write(n)
  notifier.write({ ...n, at: 'T2' })
  assert.equal(written.length, 1)
})

test('the notifier writes a different summary', () => {
  const { written, notifier } = collector()
  notifier.write({ at: 'T', kind: 'build stopped', repo: 'o/a', summary: 'one' })
  notifier.write({ at: 'T', kind: 'build stopped', repo: 'o/a', summary: 'two' })
  assert.equal(written.length, 2)
})

test('a watcher error is written once until it clears', () => {
  const { written, notifier } = collector()
  const err = watcherErrorNotification('o/a', 'cannot reach GitHub', 'T')
  notifier.write(err)
  notifier.write({ ...err, at: 'T2' })
  assert.equal(written.length, 1)
  notifier.clearError('o/a')
  notifier.write({ ...err, at: 'T3' })
  assert.equal(written.length, 2)
})
