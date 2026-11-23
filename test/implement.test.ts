import assert from 'node:assert/strict'
import test from 'node:test'

import { pullRequestTitle } from '../lib/implement.ts'

test('a PR in a multi-PR plan gets its place in the plan on its title', () => {
  assert.equal(pullRequestTitle('chore: fetch the changes', 2, 5), 'chore: fetch the changes (PR 2/5)')
})

test('the only PR in a plan keeps its plan title unchanged', () => {
  assert.equal(pullRequestTitle('feature: do the thing', 1, 1), 'feature: do the thing')
})

test('a plan title already ending in parentheses still gets the progress suffix after them', () => {
  assert.equal(pullRequestTitle('bugfix: stop the crash (iOS only)', 1, 3), 'bugfix: stop the crash (iOS only) (PR 1/3)')
})
