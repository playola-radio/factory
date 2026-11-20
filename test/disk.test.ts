import assert from 'node:assert/strict'
import test from 'node:test'

import { ensureDiskSpace, LowDiskError, minFreeBytes } from '../lib/build.ts'
import type { World } from '../lib/build.ts'
import type { FactoryEvent } from '../lib/store.ts'

const GB = 1024 ** 3

function worldWithFreeSpace(free: number) {
  const events: FactoryEvent[] = []
  const world = {
    repoId: 'owner/app',
    now: () => '2026-11-20T00:00:00.000Z',
    freeSpace: () => free,
    store: { record: (event: FactoryEvent) => void events.push(event) },
  } as unknown as World
  return { world, events }
}

test('the free-space floor defaults to 20 GB when the env var is unset', () => {
  assert.equal(minFreeBytes({}), 20 * GB)
})

test('FACTORY_MIN_FREE_GB overrides the floor, read as gigabytes', () => {
  assert.equal(minFreeBytes({ FACTORY_MIN_FREE_GB: '5' }), 5 * GB)
})

test('a non-numeric or negative FACTORY_MIN_FREE_GB is an error', () => {
  assert.throws(() => minFreeBytes({ FACTORY_MIN_FREE_GB: 'lots' }), /FACTORY_MIN_FREE_GB/)
  assert.throws(() => minFreeBytes({ FACTORY_MIN_FREE_GB: '-3' }), /FACTORY_MIN_FREE_GB/)
})

test('plenty of free space passes the check without recording anything', () => {
  const { world, events } = worldWithFreeSpace(100 * GB)
  assert.doesNotThrow(() => ensureDiskSpace(world, '001-first', {}))
  assert.deepEqual(events, [])
})

test('a full disk that cannot even record the event still throws the free-space message', () => {
  const world = {
    repoId: 'owner/app',
    now: () => '2026-11-20T00:00:00.000Z',
    freeSpace: () => 1 * GB,
    store: { record: () => { throw new Error("ENOSPC: no space left on device, open 'events.jsonl'") } },
  } as unknown as World
  assert.throws(() => ensureDiskSpace(world, '001-first', {}), LowDiskError)
})

test('too little free space throws LowDiskError and records a refusal event', () => {
  const { world, events } = worldWithFreeSpace(3 * GB)
  assert.throws(
    () => ensureDiskSpace(world, '001-first', {}),
    (error: unknown) => {
      assert.ok(error instanceof LowDiskError)
      assert.match(error.message, /3\.0 GB free/)
      assert.match(error.message, /20\.0 GB needed/)
      return true
    },
  )
  assert.deepEqual(events, [{ at: '2026-11-20T00:00:00.000Z', repo: 'owner/app', design: '001-first', type: 'build refused for space' }])
})
