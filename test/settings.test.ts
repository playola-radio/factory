import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkSettings, loadSettings } from '../lib/settings.ts'

const BOT = { login: 'bot-login', name: 'Bot', email: '1+bot-login@users.noreply.github.com' }
const MINIMAL = { owner: 'owner-login', bot: BOT }
const problemsOf = (json: unknown) => ('problems' in checkSettings(json) ? (checkSettings(json) as { problems: string[] }).problems : [])

test('a minimal file is valid and has no Greptile and no models', () => {
  assert.deepEqual(checkSettings(MINIMAL), { settings: { owner: 'owner-login', bot: BOT, greptile: null, models: {} } })
})

test('a full file is valid', () => {
  const full = { ...MINIMAL, greptile: { reReviewBelow: 3 }, models: { claude: 'opus', codex: 'gpt-6-astra' } }
  assert.deepEqual(checkSettings(full), { settings: { owner: 'owner-login', bot: BOT, greptile: { reReviewBelow: 3 }, models: { claude: 'opus', codex: 'gpt-6-astra' } } })
})

test('Greptile with no threshold re-reviews below 4', () => {
  assert.deepEqual((checkSettings({ ...MINIMAL, greptile: {} }) as { settings: { greptile: unknown } }).settings.greptile, { reReviewBelow: 4 })
})

for (const field of ['owner', 'bot', 'bot.login', 'bot.name', 'bot.email']) {
  test(`${field} missing is reported by name`, () => {
    const json: any = structuredClone(MINIMAL)
    if (field.startsWith('bot.')) delete json.bot[field.slice(4)]
    else delete json[field]
    assert.match(problemsOf(json).join('\n'), new RegExp(`${field.replace('.', '\\.')} is missing`))
  })
}

test('the owner message says what it is for', () => {
  assert.deepEqual(problemsOf({ bot: BOT }), ['owner is missing: the GitHub login whose approval merges a PR'])
})

test('wrong types are reported', () => {
  const problems = problemsOf({ owner: 5, bot: 'x', greptile: 'yes', models: [] })
  assert.equal(problems.length, 4)
})

test('unknown fields are errors at the top level and nested, with a hint for a near miss', () => {
  const problems = problemsOf({ ...MINIMAL, greptile: { rereviewbelow: 3 }, reviewbot: {}, Owner: 'x', models: { gemini: 'x' } })
  assert.deepEqual(problems, [
    'reviewbot is not a setting',
    'Owner is not a setting (did you mean owner?)',
    'greptile.rereviewbelow is not a setting (did you mean greptile.reReviewBelow?)',
    'models.gemini is not a setting',
  ])
})

test('an unknown field inside bot is an error', () => {
  assert.match(problemsOf({ owner: 'o', bot: { ...BOT, token: 'secret' } })[0], /bot\.token is not a setting/)
})

test('the bot may not be the owner, whatever the case', () => {
  for (const login of ['owner-login', 'Owner-Login']) {
    assert.match(problemsOf({ owner: 'owner-login', bot: { ...BOT, login } })[0], /bot\.login must not be the owner/)
  }
})

test('reReviewBelow must be a whole number from 1 to 5', () => {
  for (const bad of [0, 6, 3.5, '4', null]) {
    assert.match(problemsOf({ ...MINIMAL, greptile: { reReviewBelow: bad } })[0], /greptile\.reReviewBelow must be a whole number from 1 to 5/)
  }
  for (const good of [1, 5]) assert.equal('settings' in checkSettings({ ...MINIMAL, greptile: { reReviewBelow: good } }), true)
})

test('an empty model name is an error', () => {
  assert.match(problemsOf({ ...MINIMAL, models: { claude: '' } })[0], /models\.claude must be a non-empty string/)
})

test('several problems are reported together', () => {
  const problems = problemsOf({ bot: { login: 'x' }, extra: 1, greptile: { reReviewBelow: 9 } })
  assert.equal(problems.length, 5)
})

test('a settings file that is not an object is an error', () => {
  assert.deepEqual(problemsOf([]), ['the settings must be a JSON object'])
})

function homeWith(content?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-settings-'))
  if (content !== undefined) fs.writeFileSync(path.join(home, 'settings.json'), content)
  return home
}

test('loadSettings reads a valid file', () => {
  assert.equal(loadSettings(homeWith(JSON.stringify(MINIMAL))).owner, 'owner-login')
})

test('loadSettings names a missing file and says how to fix it', () => {
  assert.throws(() => loadSettings(homeWith()), /settings\.json does not exist\. Run "factory init" to fix it\.$/)
})

test('loadSettings reports bad JSON with the parse error', () => {
  assert.throws(() => loadSettings(homeWith('{nope')), /is not valid JSON: .*Run "factory init" to fix it\.$/s)
})

test('loadSettings lists every problem in one error', () => {
  assert.throws(() => loadSettings(homeWith('{"extra":1}')), (error: Error) => /owner is missing/.test(error.message) && /extra is not a setting/.test(error.message) && error.message.endsWith('Run "factory init" to fix it.'))
})
