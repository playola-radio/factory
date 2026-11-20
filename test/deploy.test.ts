import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const DEPLOY = path.resolve(import.meta.dirname, '..', 'deploy')

// A fake HOME with a stub `launchctl` on PATH, so the install/uninstall scripts run without touching real launchd.
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-deploy-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n')
  fs.chmodSync(path.join(bin, 'launchctl'), 0o755)
  const env = { ...process.env, HOME: home, FACTORY_HOME: path.join(home, '.factory'), PATH: `${bin}:${process.env.PATH}` }
  const plist = (label: string) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  return { home, env, plist }
}

test('install renders both plists with this machine paths and loads them', () => {
  const { home, env, plist } = sandbox()
  execFileSync('bash', [path.join(DEPLOY, 'install-launchd.sh')], { env })
  for (const label of ['com.playola.factory-watch', 'com.playola.factory-updater']) {
    const contents = fs.readFileSync(plist(label), 'utf8')
    assert.doesNotMatch(contents, /__REPO_DIR__|__FACTORY_HOME__/, `${label} still has unrendered tokens`)
    assert.match(contents, new RegExp(path.resolve(DEPLOY, '..').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(contents, new RegExp(path.join(home, '.factory').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('uninstall removes both plists', () => {
  const { env, plist } = sandbox()
  execFileSync('bash', [path.join(DEPLOY, 'install-launchd.sh')], { env })
  execFileSync('bash', [path.join(DEPLOY, 'uninstall-launchd.sh')], { env })
  assert.equal(fs.existsSync(plist('com.playola.factory-watch')), false)
  assert.equal(fs.existsSync(plist('com.playola.factory-updater')), false)
})

test('install is safe to run twice', () => {
  const { env, plist } = sandbox()
  execFileSync('bash', [path.join(DEPLOY, 'install-launchd.sh')], { env })
  execFileSync('bash', [path.join(DEPLOY, 'install-launchd.sh')], { env })
  assert.equal(fs.existsSync(plist('com.playola.factory-watch')), true)
})
