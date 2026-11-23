import assert from 'node:assert/strict'
import test from 'node:test'

import { codexFailure } from '../lib/agents.ts'

const events = (...lines: object[]) => lines.map((line) => JSON.stringify(line)).join('\n')

test("a failed codex run reports codex's own reason, which it writes to its event stream", () => {
  const stdout = events(
    { type: 'thread.started', thread_id: 't' },
    { type: 'error', message: "You've hit your usage limit. Try again at 3:05 PM." },
    { type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 3:05 PM." } },
  )
  assert.equal(codexFailure(`${stdout}\n`), "You've hit your usage limit. Try again at 3:05 PM.")
})

test('a codex run with no failure event, or output cut off mid-line, has no reason to add', () => {
  assert.equal(codexFailure(events({ type: 'thread.started', thread_id: 't' })), undefined)
  assert.equal(codexFailure('{"type":"err'), undefined)
})
