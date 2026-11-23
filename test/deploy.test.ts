import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const DEPLOY = path.resolve(import.meta.dirname, '..', 'deploy')
const LABELS = ['com.playola.factory-watch', 'com.playola.factory-updater']

// A fake HOME with a recording `launchctl` on PATH that also tracks which jobs are "loaded": bootout of a job
// that is not loaded fails (as the real one does), so the install's `|| true` is actually exercised.
function sandbox(options: { factoryHome?: string; deployDir?: string } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-deploy-'))
  const bin = path.join(home, 'bin')
  const log = path.join(home, 'launchctl.log')
  const state = path.join(home, 'loaded')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(bin, 'launchctl'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"',
    'case "$1" in',
    '  bootout) label=$(basename "$2"); if [ -e "$LAUNCHCTL_STATE/$label" ]; then rm -f "$LAUNCHCTL_STATE/$label"; exit 0; else exit 1; fi ;;',
    '  bootstrap) label=$(basename "$3" .plist); : > "$LAUNCHCTL_STATE/$label"; exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'))
  fs.chmodSync(path.join(bin, 'launchctl'), 0o755)
  const factoryHome = options.factoryHome ?? path.join(home, '.factory')
  const env = { ...process.env, HOME: home, FACTORY_HOME: factoryHome, PATH: `${bin}:${process.env.PATH}`, LAUNCHCTL_LOG: log, LAUNCHCTL_STATE: state }
  const deployDir = options.deployDir ?? DEPLOY
  const run = (script: string) => execFileSync('bash', [path.join(deployDir, script)], { env })
  const plist = (label: string) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])
  return { home, factoryHome, env, run, plist, calls }
}

test('install renders both plists with this machine paths and no leftover tokens', () => {
  const box = sandbox()
  box.run('install-launchd.sh')
  for (const label of LABELS) {
    const contents = fs.readFileSync(box.plist(label), 'utf8')
    assert.doesNotMatch(contents, /__REPO_DIR__|__FACTORY_HOME__/, `${label} still has unrendered tokens`)
    assert.ok(contents.includes(path.resolve(DEPLOY, '..')), `${label} should name the repo dir`)
    assert.ok(contents.includes(box.factoryHome), `${label} should name FACTORY_HOME`)
  }
})

test('both jobs carry FACTORY_HOME in their environment, including a custom one', () => {
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-custom-home-'))
  const box = sandbox({ factoryHome: custom })
  box.run('install-launchd.sh')
  for (const label of LABELS) {
    const contents = fs.readFileSync(box.plist(label), 'utf8')
    assert.match(contents, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>FACTORY_HOME<\/key>\s*<string>([^<]+)<\/string>/)
    const value = contents.match(/<key>FACTORY_HOME<\/key>\s*<string>([^<]+)<\/string>/)![1]
    assert.equal(value, custom, `${label} must pass the custom FACTORY_HOME to the job`)
  }
})

test('install boots out each job before loading it, and records both labels', () => {
  const box = sandbox()
  box.run('install-launchd.sh')
  const calls = box.calls()
  for (const label of LABELS) {
    const bootout = calls.findIndex((line) => line.startsWith('bootout') && line.includes(label))
    const bootstrap = calls.findIndex((line) => line.startsWith('bootstrap') && line.includes(`${label}.plist`))
    assert.ok(bootout >= 0, `bootout for ${label} should be called`)
    assert.ok(bootstrap >= 0, `bootstrap for ${label} should be called`)
    assert.ok(bootout < bootstrap, `${label} must be booted out before it is bootstrapped`)
  }
})

test('uninstall boots out and removes both plists', () => {
  const box = sandbox()
  box.run('install-launchd.sh')
  box.run('uninstall-launchd.sh')
  for (const label of LABELS) {
    assert.equal(fs.existsSync(box.plist(label)), false, `${label} plist should be gone`)
    assert.ok(box.calls().some((line) => line.startsWith('bootout') && line.includes(label)), `${label} should be booted out`)
  }
})

test('install is safe to run twice', () => {
  const box = sandbox()
  box.run('install-launchd.sh')
  box.run('install-launchd.sh')
  assert.equal(fs.existsSync(box.plist('com.playola.factory-watch')), true)
})

test('a repo path with XML-special characters still renders valid plists', () => {
  // Copy the deploy dir under a path containing an ampersand; its parent becomes REPO_DIR.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-amp-'))
  const repoDir = path.join(root, 'a & b')
  const deployDir = path.join(repoDir, 'deploy')
  fs.mkdirSync(deployDir, { recursive: true })
  for (const file of fs.readdirSync(DEPLOY)) fs.copyFileSync(path.join(DEPLOY, file), path.join(deployDir, file))
  const box = sandbox({ deployDir })
  box.run('install-launchd.sh')
  for (const label of LABELS) {
    const target = box.plist(label)
    const contents = fs.readFileSync(target, 'utf8')
    assert.match(contents, /a &amp; b/, `${label} should XML-escape the ampersand`)
    assert.doesNotMatch(contents, /a & b/, `${label} should not leave a raw ampersand in the XML`)
    if (process.platform === 'darwin') execFileSync('plutil', ['-lint', target]) // plutil is macOS-only; throws if the rendered plist is not valid
  }
})

test('the watcher starts with the report token from secrets.env, after the machine env', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-'))
  fs.mkdirSync(path.join(repoDir, 'deploy'))
  fs.mkdirSync(path.join(repoDir, 'bin'))
  fs.copyFileSync(path.join(DEPLOY, 'run-watch.sh'), path.join(repoDir, 'deploy', 'run-watch.sh'))
  fs.writeFileSync(path.join(repoDir, 'bin', 'factory.ts'), '#!/bin/sh\necho "$1 $FACTORY_REPORT_TOKEN $MARGE_API_URL"\n')
  fs.chmodSync(path.join(repoDir, 'bin', 'factory.ts'), 0o755)
  const factoryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-'))
  fs.writeFileSync(path.join(factoryHome, 'env'), 'MARGE_API_URL=http://localhost:8080\nFACTORY_REPORT_TOKEN=from-env\n')
  fs.writeFileSync(path.join(factoryHome, 'secrets.env'), 'FACTORY_REPORT_TOKEN=from-secrets\n')
  const { FACTORY_REPORT_TOKEN: _, MARGE_API_URL: __, ...env } = process.env
  const output = execFileSync('bash', [path.join(repoDir, 'deploy', 'run-watch.sh')], { env: { ...env, FACTORY_HOME: factoryHome }, encoding: 'utf8' })
  assert.equal(output.trim(), 'watch from-secrets http://localhost:8080')
})
