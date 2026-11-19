import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBase, startOrResume } from '../lib/build.ts'
import type { Claim } from '../lib/store.ts'

const claim: Claim = { repo: 'owner/app', design: '001-first', base: 'feature/x', startedAt: 'now', prs: [] }
const unreachable = () => {
  throw new Error('GitHub should not have been asked')
}

test('--base wins over the claim and GitHub', () => {
  assert.equal(resolveBase('release', claim, unreachable), 'release')
})

test('the claim wins over GitHub, so a build in progress survives a changed default branch', () => {
  assert.equal(resolveBase(undefined, claim, unreachable), 'feature/x')
})

test("with no flag and no claim, GitHub's default branch is used", () => {
  assert.equal(resolveBase(undefined, null, () => 'develop'), 'develop')
})

test('when GitHub cannot be asked, its error is passed on', () => {
  const failing = () => {
    throw new Error('Could not ask GitHub for the default branch of owner/app. Pass --base <branch>.')
  }
  assert.throws(() => resolveBase(undefined, null, failing), /owner\/app.*--base/)
})

test('an explicit --base that conflicts with the claim keeps the existing error', () => {
  const world = { store: { claimFor: () => claim }, repoId: 'owner/app' } as never
  assert.throws(() => startOrResume('/nowhere', world, resolveBase('release', claim, unreachable)), /in progress on base feature\/x, not release/)
})
