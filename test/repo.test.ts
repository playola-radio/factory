import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkRepoConfig, fingerprint, readRepoRules } from '../lib/repo.ts'

const problems = (json: unknown) => {
  const checked = checkRepoConfig(json)
  return 'problems' in checked ? checked.problems : []
}

test('an empty config means no after-push command', () => {
  assert.deepEqual(checkRepoConfig({}), { config: { afterPush: null } })
})

test('a full config is read as it is', () => {
  const afterPush = { command: 'make ux-evidence-publish PR={pr}', whenChanged: '.qa-artifacts/*/result.json' }
  assert.deepEqual(checkRepoConfig({ afterPush }), { config: { afterPush } })
})

test('whenChanged is optional', () => {
  assert.deepEqual(checkRepoConfig({ afterPush: { command: 'echo {pr}' } }), { config: { afterPush: { command: 'echo {pr}' } } })
})

test('an unknown field is an error, at the top level and inside afterPush', () => {
  assert.deepEqual(problems({ afterpush: {} }), ['afterpush is not a field (did you mean afterPush?)'])
  assert.deepEqual(problems({ afterPush: { command: 'x', when: 'y' } }), ['afterPush.when is not a field'])
})

test('afterPush needs a command, and it cannot be empty', () => {
  assert.match(problems({ afterPush: {} })[0], /^afterPush\.command is missing/)
  assert.match(problems({ afterPush: { command: '  ' } })[0], /^afterPush\.command must be a non-empty string/)
})

test('wrong types are errors', () => {
  assert.match(problems([])[0], /must be a JSON object/)
  assert.match(problems({ afterPush: 'make it' })[0], /^afterPush must be an object/)
  assert.match(problems({ afterPush: { command: 'x', whenChanged: 3 } })[0], /^afterPush\.whenChanged must be a non-empty string/)
})

test('whenChanged must stay inside the repo', () => {
  assert.match(problems({ afterPush: { command: 'x', whenChanged: '/tmp/*.json' } })[0], /afterPush\.whenChanged must be a path inside the repo/)
  assert.match(problems({ afterPush: { command: 'x', whenChanged: 'qa/../../*.json' } })[0], /afterPush\.whenChanged must be a path inside the repo/)
})

function baseWith(files: Record<string, string>): string {
  const view = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-base-'))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(view, name)), { recursive: true })
    fs.writeFileSync(path.join(view, name), text)
  }
  return view
}

test('with no factory files there is no after-push command and no QA rules', () => {
  assert.deepEqual(readRepoRules(baseWith({}), 'develop'), { afterPush: null, qaRules: null })
})

test('the config and QA rules are read from the base checkout', () => {
  const view = baseWith({ 'factory/config.json': '{"afterPush":{"command":"echo {pr}"}}', 'factory/qa-rules.md': 'Record a video.\n' })
  assert.deepEqual(readRepoRules(view, 'develop'), { afterPush: { command: 'echo {pr}' }, qaRules: 'Record a video.' })
})

test('every problem names the file and the branch it was read from', () => {
  const view = baseWith({ 'factory/config.json': '{"afterpush":{},"other":1}' })
  assert.throws(() => readRepoRules(view, 'develop'), (error: Error) => {
    assert.equal(error.message, 'factory/config.json on develop: afterpush is not a field (did you mean afterPush?)\nfactory/config.json on develop: other is not a field')
    return true
  })
})

test('a config that is not valid JSON is an error naming the file and branch', () => {
  assert.throws(() => readRepoRules(baseWith({ 'factory/config.json': '{' }), 'main'), /^Error: factory\/config\.json on main is not valid JSON/)
})

test('the fingerprint covers the path and contents of every matched file, git-ignored or not', () => {
  const worktree = baseWith({ '.qa-artifacts/a/result.json': '1', '.qa-artifacts/b/result.json': '2', '.qa-artifacts/a/video.mp4': 'v' })
  const glob = '.qa-artifacts/*/result.json'
  const before = fingerprint(worktree, glob)
  assert.match(before ?? '', /^[0-9a-f]{64}$/)
  fs.writeFileSync(path.join(worktree, '.qa-artifacts/a/video.mp4'), 'changed')
  assert.equal(fingerprint(worktree, glob), before)
  fs.writeFileSync(path.join(worktree, '.qa-artifacts/b/result.json'), '3')
  assert.notEqual(fingerprint(worktree, glob), before)
})

test('a glob that matches no file has no fingerprint', () => {
  assert.equal(fingerprint(baseWith({}), '.qa-artifacts/*/result.json'), null)
})
