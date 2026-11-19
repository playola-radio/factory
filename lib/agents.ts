import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Vendor } from './types.ts'

const STAGE_TIMEOUT_MS = 30 * 60 * 1000

export const OTHER_VENDOR: Record<Vendor, Vendor> = { claude: 'codex', codex: 'claude' }
export const NO_DELEGATION: Record<Vendor, string> = {
  claude: 'Do this work yourself in this Claude session. Do NOT hand any of it to Codex (`codex exec` or any other Codex call), and do not invoke skills.',
  codex: 'Do this work yourself in this Codex session. Do NOT delegate any of it to Claude (`claude -p` or any other Claude invocation). Do not read or follow files under `~/.claude/` or `.claude/skills/`.',
}

interface StageCall {
  model?: string
  prompt: string
  schemaFile: string
  cwd: string
  traceFile: string
  canWrite?: boolean
  timeoutMs?: number
  env?: Record<string, string>
}

export interface AgentCall extends Omit<StageCall, 'traceFile'> {
  vendor: Vendor
  runDir: string
  step: string
}

function runProcess(command: string, args: string[], { cwd, prompt, traceFile, timeoutMs = STAGE_TIMEOUT_MS, env }: StageCall): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const trace = fs.createWriteStream(traceFile, { flags: 'a' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      trace.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      trace.end()
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} ended with ${code ?? signal}: ${stderr.slice(-2000)}`))
    })
    child.stdin.end(prompt)
  })
}

async function runClaude(call: StageCall): Promise<unknown> {
  const schema = fs.readFileSync(call.schemaFile, 'utf8')
  const stdout = await runProcess(
    'claude',
    ['-p', ...(call.model ? ['--model', call.model] : []), '--output-format', 'stream-json', '--verbose', '--json-schema', schema, ...(call.canWrite ? ['--permission-mode', 'bypassPermissions'] : ['--allowedTools', 'Read,Grep,Glob'])],
    call,
  )
  const events = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const result = events.findLast((event) => event.type === 'result')
  if (!result || result.is_error || !result.structured_output) {
    throw new Error(`claude returned no structured result; see ${call.traceFile}`)
  }
  return result.structured_output
}

async function runCodex(call: StageCall): Promise<unknown> {
  const lastMessageFile = call.traceFile.replace(/\.jsonl$/, '.last-message.json')
  await runProcess(
    'codex',
    ['exec', ...(call.model ? ['-m', call.model] : []), '--sandbox', call.canWrite ? 'danger-full-access' : 'read-only', '--json', '--output-schema', call.schemaFile, '-o', lastMessageFile, '-'],
    call,
  )
  return JSON.parse(fs.readFileSync(lastMessageFile, 'utf8'))
}

const RUNNERS = { claude: runClaude, codex: runCodex }

export function runAgent({ vendor, runDir, step, ...call }: AgentCall): Promise<unknown> {
  const traceDir = path.join(runDir, 'traces')
  fs.mkdirSync(traceDir, { recursive: true })
  return RUNNERS[vendor]({ ...call, traceFile: path.join(traceDir, `${step}.jsonl`) })
}
