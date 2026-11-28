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
  fs.writeFileSync(schemaFile, '{}')

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
