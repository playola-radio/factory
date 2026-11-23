import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { diskStore, legacyRunId } from '../lib/store.ts'
import type { PrReport } from '../lib/store.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RUN = '11111111-2222-4333-8444-555555555555'

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'factory-store-'))
}

const lines = (dir: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

const REPORT: PrReport = {
  state: 'implemented',
  number: 1,
  attempts: 1,
  branch: 'factory/001-first/pr-1',
  worktree: '/Users/me/.factory/worktrees/x',
  commits: ['feat'],
  problems: [],
  implementation: { status: 'done', summary: 'did it', checks: [], blockers: [] },
}

test('every recorded event gets its own lower-case uuid', () => {
  const dir = home()
  const store = diskStore(dir)
  store.record({ at: '2026-11-23T00:00:00.000Z', repo: 'owner/app', design: '001-first', runId: RUN, type: 'design claimed' })
  store.record({ at: '2026-11-23T00:00:01.000Z', repo: 'owner/app', design: '001-first', runId: RUN, type: 'pr started', pr: 1 })
  const [first, second] = lines(dir)
  assert.match(first.id, UUID)
  assert.match(second.id, UUID)
  assert.notEqual(first.id, second.id)
  assert.equal(first.runId, RUN)
})

test('an event recorded with a report keeps a copy of it, without the worktree path, under the event id', () => {
  const dir = home()
  const store = diskStore(dir)
  store.record({ at: '2026-11-23T00:00:00.000Z', repo: 'owner/app', design: '001-first', runId: RUN, pr: 1, type: 'pr implemented' }, REPORT)
  const [event] = lines(dir)
  assert.equal(event.artifactId, event.id)
  const { worktree: _, ...withoutWorktree } = REPORT
  assert.deepEqual(store.artifact(event.id), withoutWorktree)
})

test('a report too big for marge is kept as a short stub instead', () => {
  const dir = home()
  const store = diskStore(dir)
  const huge = { ...REPORT, problems: ['x'.repeat(300 * 1024)] }
  store.record({ at: '2026-11-23T00:00:00.000Z', repo: 'owner/app', design: '001-first', runId: RUN, pr: 1, type: 'pr needs attention' }, huge)
  const [event] = lines(dir)
  const body = store.artifact(event.id) as Record<string, unknown>
  assert.match(String(body.omitted), /256 KiB/)
})

test('an event recorded without a report points at none', () => {
  const dir = home()
  diskStore(dir).record({ at: '2026-11-23T00:00:00.000Z', repo: 'owner/app', design: '001-first', runId: RUN, type: 'design claimed' })
  assert.equal(lines(dir)[0].artifactId, undefined)
})

test('a claim written before run ids existed reads back with one derived from its start', () => {
  const dir = home()
  const store = diskStore(dir)
  const claim = { repo: 'owner/app', design: '001-first', base: 'develop', startedAt: '2026-11-23T00:00:00.000Z', prs: [] }
  fs.mkdirSync(path.join(dir, 'builds', 'owner__app'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'builds', 'owner__app', 'claim.json'), JSON.stringify(claim))
  const runId = store.claimFor('owner/app')!.runId
  assert.match(runId, UUID)
  assert.equal(runId, legacyRunId('owner/app', '001-first', '2026-11-23T00:00:00.000Z'))
})

test('the sync cursor starts at the beginning and keeps what was saved', () => {
  const store = diskStore(home())
  assert.equal(store.syncCursor(), 0)
  store.saveSyncCursor(512)
  assert.equal(store.syncCursor(), 512)
})

test('the event log reads as empty before anything is recorded', () => {
  assert.equal(diskStore(home()).eventLog(), '')
})
