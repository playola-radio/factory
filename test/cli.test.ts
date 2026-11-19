import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { botToken, defaultBranch } from '../lib/workshop.ts'

const FACTORY = path.join(import.meta.dirname, '..', 'bin', 'factory.ts')

function repoWithOrigin() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-repo-'))
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/owner/app.git'])
  return repo
}

function factory(args: string[], home: string, env: Record<string, string> = {}) {
  return spawnSync('node', [FACTORY, ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: home, ...env } })
}

test('build with no settings file stops before any work and says how to fix it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-home-'))
  const result = factory(['build', repoWithOrigin()], home)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /settings\.json does not exist\. Run "factory init" to fix it\.$/m)
  assert.deepEqual(fs.readdirSync(home), [])
})

test('build with an invalid settings file lists the problems', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-home-'))
  fs.writeFileSync(path.join(home, 'settings.json'), '{"owner":"a","bot":{"login":"A","name":"n","email":"e"}}')
  const result = factory(['build', repoWithOrigin()], home)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /bot\.login must not be the owner/)
})

test('abandon and status do not read the settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-home-'))
  const repo = repoWithOrigin()
  assert.equal(factory(['abandon', repo], home).status, 0)
  assert.equal(factory(['status', repo], home).status, 0)
})

test('finalize with an invalid settings file is an error, but a missing one is fine', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-home-'))
  const repo = repoWithOrigin()
  assert.doesNotMatch(factory(['finalize', repo], home).stderr, /factory init/)
  fs.writeFileSync(path.join(home, 'settings.json'), '{"nope":1}')
  assert.match(factory(['finalize', repo], home).stderr, /nope is not a setting[\s\S]*Run "factory init" to fix it\./)
})

test("build stops before any work when the base's factory/config.json is wrong, naming the file, branch and field", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-origin-'))
  const origin = path.join(root, 'owner', 'app.git')
  const seed = path.join(root, 'seed')
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  execFileSync('git', ['init', '-q', '--bare', origin])
  execFileSync('git', ['init', '-q', '-b', 'develop', seed])
  fs.mkdirSync(path.join(seed, 'factory'))
  fs.writeFileSync(path.join(seed, 'factory', 'config.json'), '{"afterpush":{"command":"x"}}')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'seed')
  git(seed, 'push', '-q', origin, 'develop')
  const repo = path.join(root, 'repo')
  execFileSync('git', ['clone', '-q', origin, repo])
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-home-'))
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ owner: 'owner-login', bot: { login: 'bot-login', name: 'Bot', email: 'b@example.com' } }))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gh-'))
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$1" = auth ]; then echo token; else echo bot-login; fi\n')
  fs.chmodSync(path.join(bin, 'gh'), 0o755)
  const result = factory(['build', repo, '--base', 'develop'], home, { PATH: `${bin}:${process.env.PATH}` })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^factory\/config\.json on develop: afterpush is not a field \(did you mean afterPush\?\)$/m)
  assert.equal(fs.existsSync(path.join(home, 'builds')), false)
})

function withFakeGh(script: string, run: () => void) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gh-'))
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${script}\n`)
  fs.chmodSync(path.join(bin, 'gh'), 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  try {
    run()
  } finally {
    process.env.PATH = previous
  }
}

test("the default base is GitHub's default branch for the repo", { concurrency: false }, () => {
  withFakeGh('if [ "$1" = auth ]; then echo token; elif [ "$1" = api ]; then echo bot-login; else echo \'{"defaultBranchRef":{"name":"develop"}}\'; fi', () => {
    assert.equal(defaultBranch('owner/app', 'bot-login'), 'develop')
  })
})

test('when GitHub cannot say, the error names the repo and suggests --base', { concurrency: false }, () => {
  withFakeGh('if [ "$1" = auth ]; then echo token; elif [ "$1" = api ]; then echo bot-login; else exit 1; fi', () => {
    assert.throws(() => defaultBranch('owner/app', 'bot-login'), /owner\/app[\s\S]*--base/)
  })
})

test('the bot token must authenticate as the configured bot', { concurrency: false }, () => {
  withFakeGh('if [ "$1" = auth ]; then echo token; else echo someone-else; fi', () => {
    assert.throws(() => botToken('bot-login'), /saved token does not authenticate as bot-login/)
  })
})
