import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runInit } from '../lib/init.ts'
import type { InitDeps } from '../lib/init.ts'

const homeWith = (content?: string) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-init-'))
  if (content !== undefined) fs.writeFileSync(path.join(home, 'settings.json'), content)
  return home
}
const written = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))

// Answers questions in order; '' accepts the default. `gh` knows who is signed in and which bots have tokens.
function script(answers: string[], options: { tokenFails?: boolean } = {}) {
  const asked: string[] = []
  const calls: string[][] = []
  const deps: InitDeps = {
    ask: async (question) => {
      asked.push(question)
      return answers.shift() ?? ''
    },
    say: () => undefined,
    gh: (args) => {
      calls.push(args)
      if (args[0] === 'api' && args[1] === 'user') return 'owner-login'
      if (args[0] === 'auth') {
        if (options.tokenFails) throw new Error('no token')
        return 'token'
      }
      if (args[0] === 'api') return '4242'
      throw new Error(`unexpected gh ${args.join(' ')}`)
    },
  }
  return { deps, asked, calls }
}

test('scripted answers write the expected file', async () => {
  const home = homeWith()
  const { deps, calls } = script(['', 'bot-login', 'Bot', 'y', '3', 'opus', 'gpt-6-astra'])
  await runInit(home, deps)
  assert.deepEqual(written(home), {
    owner: 'owner-login',
    bot: { login: 'bot-login', name: 'Bot', email: '4242+bot-login@users.noreply.github.com' },
    greptile: { reReviewBelow: 3 },
    models: { claude: 'opus', codex: 'gpt-6-astra' },
  })
  assert.deepEqual(calls.find((call) => call[0] === 'auth'), ['auth', 'token', '--user', 'bot-login'])
})

test('all defaults: the owner is whoever gh is signed in as, no Greptile, no models', async () => {
  const home = homeWith()
  const { deps } = script(['', 'bot-login', '', '', '', ''])
  await runInit(home, deps)
  assert.deepEqual(written(home), { owner: 'owner-login', bot: { login: 'bot-login', name: 'bot-login', email: '4242+bot-login@users.noreply.github.com' } })
})

test('Greptile with no answer for the threshold uses 4', async () => {
  const home = homeWith()
  await runInit(home, script(['', 'bot-login', '', 'y', '', '', '']).deps)
  assert.deepEqual(written(home).greptile, { reReviewBelow: 4 })
})

test('a bot token that does not work writes nothing and says how to sign the bot in', async () => {
  const home = homeWith()
  await assert.rejects(runInit(home, script(['', 'bot-login'], { tokenFails: true }).deps), /gh is not signed in as bot-login[\s\S]*gh auth login[\s\S]*Nothing was written/)
  assert.equal(fs.existsSync(path.join(home, 'settings.json')), false)
})

test('the bot may not be the owner, whatever the case', async () => {
  const home = homeWith()
  await assert.rejects(runInit(home, script(['', 'OWNER-login']).deps), /must be a different account/)
  assert.equal(fs.existsSync(path.join(home, 'settings.json')), false)
})

test('a threshold out of range writes nothing', async () => {
  const home = homeWith()
  await assert.rejects(runInit(home, script(['', 'bot-login', '', 'y', '9', '', '']).deps), /greptile\.reReviewBelow/)
  assert.equal(fs.existsSync(path.join(home, 'settings.json')), false)
})

test('existing values are offered as defaults and pressing Enter keeps them', async () => {
  const before = {
    owner: 'someone',
    bot: { login: 'bot-login', name: 'Botty', email: '4242+bot-login@users.noreply.github.com' },
    greptile: { reReviewBelow: 2 },
    models: { claude: 'opus' },
  }
  const home = homeWith(JSON.stringify(before))
  const { deps, asked } = script(['', '', '', '', '', '', ''])
  await runInit(home, deps)
  assert.deepEqual(written(home), before)
  assert.match(asked.join('\n'), /\[someone\]/)
  assert.match(asked.join('\n'), /\[Botty\]/)
  assert.match(asked.join('\n'), /\[opus\]/)
})

test('a dash clears a saved model', async () => {
  const home = homeWith(JSON.stringify({ owner: 'someone', bot: { login: 'bot-login', name: 'B', email: 'e' }, models: { claude: 'opus' } }))
  await runInit(home, script(['', '', '', '', '-', '']).deps)
  assert.equal('models' in written(home), false)
})

test('a file that is not factory settings is left untouched and named', async () => {
  const other = '{"theme":"dark"}'
  const home = homeWith(other)
  const { deps, asked } = script([])
  await assert.rejects(runInit(home, deps), (error: Error) => error.message.includes(path.join(home, 'settings.json')) && /FACTORY_HOME/.test(error.message))
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), other)
  assert.deepEqual(asked, [])
})

test('a file that is not even JSON is left untouched', async () => {
  const home = homeWith('not json')
  await assert.rejects(runInit(home, script([]).deps), /not valid factory settings/)
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), 'not json')
})
