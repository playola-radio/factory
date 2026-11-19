import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runAgent } from '../lib/agents.ts'
import { checkSettings } from '../lib/settings.ts'
import type { Settings } from '../lib/settings.ts'
import { realWorkshop } from '../lib/workshop.ts'

const BRIAN = {
  owner: 'briankeane',
  bot: { login: 'marge-watson', name: 'Marge', email: '263082108+marge-watson@users.noreply.github.com' },
  greptile: { reReviewBelow: 4 },
  models: { claude: 'opus', codex: 'gpt-6-astra' },
}
const NO_MODELS: Settings = { owner: 'owner-login', bot: { login: 'bot-login', name: 'Bot', email: 'e' }, greptile: null, models: {} }

// Puts fake `claude`, `codex` and `gh` programs first on PATH; each CLI records its arguments and answers with an empty result.
function withFakeClis(run: (argsOf: (cli: string) => string[]) => Promise<void>) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-clis-'))
  const log = path.join(bin, 'calls.jsonl')
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cli: 'claude', args: process.argv.slice(2) }) + '\\n')
console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { findings: [] } }))
`)
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cli: 'codex', args }) + '\\n')
require('node:fs').writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ findings: [] }))
`)
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho token\n')
  for (const cli of ['claude', 'codex', 'gh']) fs.chmodSync(path.join(bin, cli), 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  const argsOf = (cli: string) => {
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    return calls.find((call) => call.cli === cli).args as string[]
  }
  return run(argsOf).finally(() => void (process.env.PATH = previous))
}

const agentCall = {
  prompt: 'p',
  schemaFile: path.join(import.meta.dirname, '..', 'schemas', 'review.json'),
  cwd: os.tmpdir(),
  runDir: fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-')),
  step: 'x',
}

test('no model set: neither CLI is given a model flag', { concurrency: false }, () =>
  withFakeClis(async (argsOf) => {
    await runAgent({ ...agentCall, vendor: 'claude' })
    await runAgent({ ...agentCall, vendor: 'codex' })
    assert.equal(argsOf('claude').includes('--model'), false)
    assert.equal(argsOf('codex').includes('-m'), false)
  }))

test('a model set is passed to the CLI it is for', { concurrency: false }, () =>
  withFakeClis(async (argsOf) => {
    await runAgent({ ...agentCall, vendor: 'claude', model: 'sonnet' })
    await runAgent({ ...agentCall, vendor: 'codex', model: 'terra' })
    assert.deepEqual(argsOf('claude').slice(1, 3), ['--model', 'sonnet'])
    assert.deepEqual(argsOf('codex').slice(1, 3), ['-m', 'terra'])
  }))

test('a workshop with no models passes no model flag to either CLI', { concurrency: false }, () =>
  withFakeClis(async (argsOf) => {
    const workshop = realWorkshop('/tmp/repo', 'owner/app', '/tmp/worktrees', agentCall.runDir, NO_MODELS)
    await workshop.implement(os.tmpdir(), 'p', 'implement')
    await workshop.breakIt(os.tmpdir(), 'p', 'break')
    assert.equal(argsOf('claude').includes('--model'), false)
    assert.equal(argsOf('codex').includes('-m'), false)
  }))

test("Brian's settings give opus to Claude and gpt-6-astra to Codex", { concurrency: false }, () =>
  withFakeClis(async (argsOf) => {
    const checked = checkSettings(BRIAN)
    assert.ok('settings' in checked)
    const workshop = realWorkshop('/tmp/repo', 'owner/app', '/tmp/worktrees', agentCall.runDir, checked.settings)
    await workshop.implement(os.tmpdir(), 'p', 'implement')
    await workshop.breakIt(os.tmpdir(), 'p', 'break')
    assert.deepEqual(argsOf('claude').slice(1, 3), ['--model', 'opus'])
    assert.deepEqual(argsOf('codex').slice(1, 3), ['-m', 'gpt-6-astra'])
  }))
