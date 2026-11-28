import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runAgent } from '../lib/agents.ts'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat.length > 0 && !stat.startsWith('Z')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

test('timed-out agent call kills the whole process group including grandchildren', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-agents-'))
  const binDir = path.join(tmp, 'bin')
  const runDir = path.join(tmp, 'run')
  const schemaFile = path.join(tmp, 'schema.json')
  const pidFile = path.join(tmp, 'grandchild.pid')
  fs.mkdirSync(binDir, { recursive: true })

  const fakeOutside = path.join(binDir, 'outside-voice')
  fs.writeFileSync(
    fakeOutside,
    `#!/bin/sh
sleep 30 &
echo $! > "${pidFile}"
wait
`,
    { mode: 0o755 },
  )

  let grandchildPid: number | undefined
  try {
    await assert.rejects(
      runAgent({
        vendor: 'outside',
        runDir,
        step: 'timeout-group',
        model: 'heavy',
        prompt: 'hello',
        schemaFile,
        cwd: tmp,
        timeoutMs: 600,
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      }),
      /ended with SIGKILL/,
    )

    grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

    const deadline = Date.now() + 1000
    while (isAlive(grandchildPid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(isAlive(grandchildPid), false, `expected grandchild ${grandchildPid} to be killed`)
  } finally {
    if (grandchildPid && isAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('a running agent keeps its trace file fresh, so the auto-updater does not take it for idle', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-agents-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const binDir = path.join(tmp, 'bin')
  const runDir = path.join(tmp, 'run')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'outside-voice'), '#!/bin/sh\nsleep 1\nexit 1\n', { mode: 0o755 })

  const run = runAgent({
    vendor: 'outside',
    runDir,
    step: 'quiet',
    model: 'heavy',
    prompt: 'hello',
    schemaFile: path.join(tmp, 'schema.json'),
    cwd: tmp,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
  })
  const traceFile = path.join(runDir, 'traces', 'quiet.jsonl')
  await new Promise((r) => setTimeout(r, 200))
  const longAgo = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(traceFile, longAgo, longAgo)
  t.mock.timers.tick(30_000)
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(fs.statSync(traceFile).mtimeMs > longAgo.getTime() + 30 * 60 * 1000)
  await assert.rejects(run)
})

test('a successful outside-voice run receives the tier, schema, and prompt and returns the JSON written to -o', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-agents-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const binDir = path.join(tmp, 'bin')
  const runDir = path.join(tmp, 'run')
  const schemaFile = path.join(tmp, 'schema.json')
  fs.mkdirSync(binDir)
  fs.writeFileSync(
    path.join(binDir, 'outside-voice'),
    `#!/bin/sh
set -e
[ "$1" = "--tier" ] && [ "$2" = "heavy" ]
[ "$3" = "--schema" ] && [ "$4" = "${schemaFile}" ]
[ "$5" = "-o" ]
[ "$7" = "-" ]
prompt=$(cat)
[ "$prompt" = "hello" ]
printf '{"ok":true,"summary":"looks good"}\\n' > "$6"
`,
    { mode: 0o755 },
  )

  const result = await runAgent({
    vendor: 'outside',
    runDir,
    step: 'success',
    model: 'heavy',
    prompt: 'hello',
    schemaFile,
    cwd: tmp,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
  })
  assert.deepEqual(result, { ok: true, summary: 'looks good' })
})
