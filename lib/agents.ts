import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Vendor } from './types.ts'

const STAGE_TIMEOUT_MS = 30 * 60 * 1000
// deploy/auto-update.sh takes a run whose trace files stop changing for two minutes as idle, and outside-voice
// writes nothing until it ends, so a running agent touches its trace file this often.
const TRACE_HEARTBEAT_MS = 30 * 1000

export const OTHER_VENDOR: Record<Vendor, Vendor> = { claude: 'outside', outside: 'claude' }
// For the outside vendor the "model" is an outside-voice tier; the provider and model live in its config.
export const DEFAULT_MODEL: Record<Vendor, string> = { claude: 'opus', outside: 'heavy' }
export const NO_DELEGATION: Record<Vendor, string> = {
  claude: 'Do this work yourself in this Claude session. Do NOT hand any of it to another AI tool (`outside-voice`, `codex`, `agy` or similar), and do not invoke skills.',
  outside: 'Do not read or follow files under `~/.claude/` or `.claude/skills/`.',
}

interface StageCall {
  model: string
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

const runningChildren = new Set<ChildProcess>()
let signalsRegistered = false

function killChildGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

function registerSignalHandlers(): void {
  if (signalsRegistered) return
  signalsRegistered = true
  const handleSignal = (code: number) => () => {
    for (const child of runningChildren) killChildGroup(child)
    process.exit(code)
  }
  process.on('SIGINT', handleSignal(130))
  process.on('SIGTERM', handleSignal(143))
  process.on('SIGHUP', handleSignal(129))
}

function runProcess(command: string, args: string[], { cwd, prompt, traceFile, timeoutMs = STAGE_TIMEOUT_MS, env }: StageCall): Promise<string> {
  registerSignalHandlers()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    runningChildren.add(child)
    const trace = fs.createWriteStream(traceFile, { flags: 'a' })
    const heartbeat = setInterval(() => fs.utimes(traceFile, new Date(), new Date(), () => {}), TRACE_HEARTBEAT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      trace.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      killChildGroup(child)
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      runningChildren.delete(child)
      trace.end()
      reject(err)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      runningChildren.delete(child)
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
    ['-p', '--model', call.model, '--output-format', 'stream-json', '--verbose', '--json-schema', schema, ...(call.canWrite ? ['--permission-mode', 'bypassPermissions'] : ['--allowedTools', 'Read,Grep,Glob'])],
    call,
  )
  const events = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const result = events.findLast((event) => event.type === 'result')
  if (!result || result.is_error || !result.structured_output) {
    throw new Error(`claude returned no structured result; see ${call.traceFile}`)
  }
  return result.structured_output
}

async function runOutside(call: StageCall): Promise<unknown> {
  const lastMessageFile = call.traceFile.replace(/\.jsonl$/, '.last-message.json')
  await runProcess(
    'outside-voice',
    ['--tier', call.model, '--schema', call.schemaFile, '-o', lastMessageFile, '-'],
    call,
  )
  return JSON.parse(fs.readFileSync(lastMessageFile, 'utf8'))
}

const RUNNERS = { claude: runClaude, outside: runOutside }

export function runAgent({ vendor, runDir, step, ...call }: AgentCall): Promise<unknown> {
  const traceDir = path.join(runDir, 'traces')
  fs.mkdirSync(traceDir, { recursive: true })
  return RUNNERS[vendor]({ ...call, traceFile: path.join(traceDir, `${step}.jsonl`) })
}
