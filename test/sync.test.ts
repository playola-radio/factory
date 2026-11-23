import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CATALOG } from '../lib/snapshot.ts'
import type { WatchedRepo } from '../lib/snapshot.ts'
import { diskStore, legacyRunId } from '../lib/store.ts'
import type { Claim, FactoryEvent, PrReport, Store } from '../lib/store.ts'
import { syncLoop } from '../lib/sync.ts'
import type { SyncEffects } from '../lib/sync.ts'
import type { PlannedPr } from '../lib/types.ts'

const RUN = '98093cbb-16c0-43a9-b026-cc9b1d91c47a'
const START = Date.parse('2026-11-23T12:00:00.000Z')
const ENV = { FACTORY_REPORT_TOKEN: 'secret-token' }
const CLAIM: Claim = { repo: 'owner/app', design: '001-first', base: 'develop', startedAt: '2026-11-23T11:00:00.000Z', prs: [{ number: 1, title: 'PR 1' } as PlannedPr], runId: RUN }
const REPORT: PrReport = { state: 'implemented', number: 1, attempts: 1, branch: 'b', worktree: '/w', commits: [], problems: [], implementation: { status: 'done', summary: 's', checks: [], blockers: [] } }

interface Push {
  at: number
  url: string
  token: string
  body: { catalog: unknown; snapshot: { builds: { runId: string }[]; counts: unknown }; events: Record<string, unknown>[]; artifacts: Record<string, unknown>[] }
}

// Runs the loop on a fake clock: each sleep moves the clock on, and `during` can change the world at a given second.
async function run(options: { env?: NodeJS.ProcessEnv; seconds?: number; status?: (push: number) => number | Error; store?: Store; repos?: () => WatchedRepo[]; during?: Record<number, () => void> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-'))
  const store = options.store ?? diskStore(home)
  let clock = START
  const pushes: Push[] = []
  const logs: string[] = []
  let finish = () => {}
  const stop = new Promise<void>((resolve) => (finish = resolve))
  const effects: SyncEffects = {
    store,
    signature: () => String(store.eventLog().length),
    repos: options.repos ?? (() => [{ repo: 'owner/app', claim: CLAIM, report: () => null, exitCode: null, counts: { upNext: 0, planNotFinished: 0, done: 0 } }]),
    post: async (url, token, body) => {
      pushes.push({ at: (clock - START) / 1000, url, token, body: JSON.parse(body) })
      const status = options.status?.(pushes.length) ?? 204
      if (status instanceof Error) throw status
      return status
    },
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms
      options.during?.[(clock - START) / 1000]?.()
      if (clock - START >= (options.seconds ?? 0) * 1000) finish()
    },
    log: (message) => void logs.push(message),
  }
  await syncLoop(options.env ?? ENV, effects, stop)
  return { pushes, logs, store, home }
}

const record = (store: Store, type: FactoryEvent['type'], report?: PrReport) =>
  store.record({ at: '2026-11-23T11:30:00.000Z', repo: 'owner/app', design: '001-first', runId: RUN, ...(report && { pr: 1 }), type }, report)

test('a push carries the status list, the latest state, and the new history with its reports', async () => {
  const store = diskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-')))
  record(store, 'design claimed')
  record(store, 'pr implemented', REPORT)
  const [push] = (await run({ store })).pushes
  assert.equal(push.url, 'https://api.marge.playola.fm/v1/factory/sync')
  assert.equal(push.token, 'secret-token')
  assert.deepEqual(push.body.catalog, CATALOG)
  assert.deepEqual(push.body.snapshot.builds.map((build) => build.runId), [RUN])
  assert.deepEqual(push.body.snapshot.counts, { upNext: 0, planNotFinished: 0, done: 0 })
  const [claimed, implemented] = push.body.events
  assert.deepEqual(Object.keys(claimed), ['id', 'runId', 'at', 'repo', 'design', 'pr', 'type', 'artifactId'])
  assert.deepEqual([claimed.pr, claimed.artifactId, claimed.runId], [null, null, RUN])
  assert.equal(implemented.artifactId, implemented.id)
  const { worktree: _, ...body } = REPORT
  assert.deepEqual(push.body.artifacts, [{ id: implemented.id, kind: 'pr_report', at: '2026-11-23T11:30:00.000Z', body }])
})

test('MARGE_API_URL changes where pushes go', async () => {
  const { pushes } = await run({ env: { ...ENV, MARGE_API_URL: 'http://localhost:8080' } })
  assert.equal(pushes[0].url, 'http://localhost:8080/v1/factory/sync')
})

test('only history marge has not yet accepted is sent, and accepted reports are deleted', async () => {
  const store = diskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-')))
  record(store, 'pr implemented', REPORT)
  const { pushes } = await run({ store, seconds: 10, during: { 5: () => record(store, 'gate started') } })
  assert.deepEqual(pushes.map((push) => push.body.events.map((event) => event.type)), [['pr implemented'], ['gate started']])
  assert.equal(store.artifact(String(pushes[0].body.events[0].id)), null)
})

test('with nothing new, a heartbeat with the latest state still goes every minute', async () => {
  const { pushes } = await run({ seconds: 130 })
  assert.deepEqual(pushes.map((push) => push.at), [0, 60, 120])
  assert.deepEqual(pushes[2].body.events, [])
  assert.equal(pushes[2].body.snapshot.builds.length, 1)
})

test('a push that is not accepted is sent again a minute later with the same history', async () => {
  const store = diskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-')))
  record(store, 'pr implemented', REPORT)
  const { pushes, logs } = await run({ store, seconds: 65, status: (push) => (push === 1 ? 500 : 204), during: { 5: () => record(store, 'gate started') } })
  assert.deepEqual(pushes.map((push) => push.at), [0, 60])
  assert.deepEqual(pushes[1].body.events.map((event) => event.type), ['pr implemented', 'gate started'])
  assert.equal(pushes[1].body.artifacts.length, 1)
  assert.match(logs.join('\n'), /500/)
})

test('a network failure is logged and the sender carries on', async () => {
  const { pushes, logs } = await run({ seconds: 65, status: (push) => (push === 1 ? new Error('connect ECONNREFUSED') : 204) })
  assert.deepEqual(pushes.map((push) => push.at), [0, 60])
  assert.match(logs.join('\n'), /ECONNREFUSED/)
})

test('a state read that fails sends nothing rather than a stale state', async () => {
  const { pushes, logs } = await run({ repos: () => { throw new Error('base view is mid-checkout') } })
  assert.deepEqual(pushes, [])
  assert.match(logs.join('\n'), /mid-checkout/)
})

test('with no token nothing is sent, the sender says so once and stops', async () => {
  const { pushes, logs } = await run({ env: {}, seconds: 600 })
  assert.deepEqual(pushes, [])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /FACTORY_REPORT_TOKEN/)
})

test('an empty MARGE_API_URL turns reporting off', async () => {
  const { pushes, logs } = await run({ env: { ...ENV, MARGE_API_URL: '' } })
  assert.deepEqual(pushes, [])
  assert.match(logs[0], /MARGE_API_URL/)
})

test('history written before ids existed gets the same ids on every push, and the run of its claim', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-'))
  const legacy = [
    { at: '2026-11-20T00:00:00.000Z', repo: 'owner/app', design: '001-first', type: 'design claimed' },
    { at: '2026-11-20T00:01:00.000Z', repo: 'owner/app', design: '001-first', pr: 1, type: 'pr started' },
  ]
  fs.writeFileSync(path.join(home, 'events.jsonl'), legacy.map((line) => `${JSON.stringify(line)}\n`).join(''))
  const { pushes } = await run({ store: diskStore(home), seconds: 65, status: (push) => (push === 1 ? 500 : 204) })
  const [first, again] = pushes.map((push) => push.body.events)
  assert.deepEqual(first.map((event) => event.id), again.map((event) => event.id))
  assert.notEqual(first[0].id, first[1].id)
  const runId = legacyRunId('owner/app', '001-first', '2026-11-20T00:00:00.000Z')
  assert.deepEqual(first.map((event) => event.runId), [runId, runId])
})

test('a line that cannot be sent is skipped and left behind, and a half-written last line waits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-'))
  const store = diskStore(home)
  fs.writeFileSync(path.join(home, 'events.jsonl'), 'not json\n')
  record(store, 'design claimed')
  fs.appendFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ at: 'yesterday', repo: 'owner/app', design: '001-first', runId: RUN, type: 'pr started' }) + '\n{"at":')
  const { pushes, logs } = await run({ store })
  assert.deepEqual(pushes[0].body.events.map((event) => event.type), ['design claimed'])
  assert.equal(store.syncCursor(), fs.statSync(path.join(home, 'events.jsonl')).size - '{"at":'.length)
  assert.equal(logs.length, 2)
})

test('a long backlog goes at most 500 events at a time, the rest on the next poll', async () => {
  const store = diskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-')))
  for (let index = 0; index < 501; index++) record(store, 'review round')
  const { pushes } = await run({ store, seconds: 9 })
  assert.deepEqual(pushes.map((push) => [push.at, push.body.events.length]), [[0, 500], [5, 1]])
})

test('a push carries at most 50 reports', async () => {
  const store = diskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-')))
  for (let index = 0; index < 51; index++) record(store, 'review round', REPORT)
  const { pushes } = await run({ store, seconds: 9 })
  assert.deepEqual(pushes.map((push) => push.body.artifacts.length), [50, 1])
})

test('an event whose report is gone points at none', async () => {
  const store = diskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sync-')))
  record(store, 'pr implemented', REPORT)
  store.forgetArtifact(JSON.parse(store.eventLog()).id)
  const [push] = (await run({ store })).pushes
  assert.equal(push.body.events[0].artifactId, null)
  assert.deepEqual(push.body.artifacts, [])
})
