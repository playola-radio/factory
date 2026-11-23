import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { repoIdFromRemote } from './build.ts'
import { CATALOG, countDesigns, snapshot } from './snapshot.ts'
import type { LoggedEvent, WatchedRepo } from './snapshot.ts'
import { derivedUuid, legacyRunId } from './store.ts'
import type { Store } from './store.ts'
import type { RepoConfig } from './watch.ts'

// Pushes the factory's state to marge (POST /v1/factory/sync, contract in marge-web's
// factory/done/002-factory-overview/ApiContract.md): on every change, and once a minute when nothing changed.

const POLL_MS = 5_000
const HEARTBEAT_MS = 60_000
const RETRY_MS = 60_000
const MAX_EVENTS = 500
const MAX_ARTIFACTS = 50
const MAX_HISTORY_BYTES = 4 * 1024 * 1024
const DEFAULT_URL = 'https://api.marge.playola.fm'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

export interface SyncEffects {
  store: Store
  // Changes whenever something the page shows may have changed; cheap enough to read every few seconds.
  signature(): string
  repos(): WatchedRepo[]
  // Resolves the response status; rejects when no response came back.
  post(url: string, token: string, body: string): Promise<number>
  now(): Date
  sleep(ms: number, signal: AbortSignal): Promise<void>
  log(message: string): void
}

interface Artifact {
  id: string
  kind: 'pr_report'
  at: string
  body: object
}

interface Line {
  end: number
  event: LoggedEvent | null
}

function problemWith(event: LoggedEvent): string | null {
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max
  if (!UUID.test(event.id) || !UUID.test(event.runId)) return 'its id or run id is not a lower-case uuid'
  if (!UTC.test(event.at) || Number.isNaN(Date.parse(event.at)) || new Date(event.at).toISOString().slice(0, 19) !== event.at.slice(0, 19)) return `its time "${event.at}" is not a UTC time`
  if (!text(event.repo, 200) || !text(event.design, 200) || !text(event.type, 60)) return 'its repo, design or type is missing or too long'
  if (event.pr !== undefined && (!Number.isInteger(event.pr) || event.pr < 1)) return `its PR "${event.pr}" is not a positive whole number`
  if (event.artifactId !== undefined && !UUID.test(event.artifactId)) return 'its report id is not a lower-case uuid'
  return null
}

// Every complete line of the event log with the byte offset just past it. Lines written before events had ids get
// ones derived from where they sit, and the run of the latest claim of their design before them.
function readLog(text: string, log: (message: string) => void, cursor: number): Line[] {
  const lines: Line[] = []
  const claimedAt = new Map<string, string>()
  let offset = 0
  for (const line of text.split('\n').slice(0, -1)) {
    const start = offset
    offset += Buffer.byteLength(line) + 1
    const skip = (why: string) => {
      if (offset > cursor) log(`Not sending event log line at byte ${start} to marge: ${why}.`)
      lines.push({ end: offset, event: null })
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch {
      skip('it is not JSON')
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) {
      skip('it is not an event')
      continue
    }
    const design = `${parsed.repo}\n${parsed.design}`
    if (parsed.type === 'design claimed' && parsed.runId === undefined) claimedAt.set(design, String(parsed.at))
    const event = {
      ...parsed,
      id: parsed.id ?? derivedUuid(`${start}:${line}`),
      runId: parsed.runId ?? legacyRunId(String(parsed.repo), String(parsed.design), claimedAt.get(design) ?? 'unclaimed'),
    } as LoggedEvent
    const problem = problemWith(event)
    if (problem) skip(problem)
    else lines.push({ end: offset, event })
  }
  return lines
}

function readArtifact(store: Store, event: LoggedEvent): Artifact | null {
  const id = event.artifactId
  if (!id) return null
  const body = store.artifact(id)
  return body && { id, kind: 'pr_report', at: event.at, body }
}

// One push built from one full read of the state, carrying the oldest history marge has not accepted yet.
function nextPush(effects: SyncEffects) {
  const { store, log } = effects
  const text = store.eventLog()
  // A log cut shorter than the cursor was replaced; send it from the start, since marge ignores ids it already has.
  const saved = store.syncCursor()
  const cursor = saved > Buffer.byteLength(text) ? 0 : saved
  const lines = readLog(text, log, cursor)
  const repos = effects.repos()
  const events: object[] = []
  const artifacts: Artifact[] = []
  let end = cursor
  let bytes = 0
  const pending = lines.filter((line) => line.end > cursor)
  for (const { end: lineEnd, event } of pending) {
    if (event) {
      const artifact = readArtifact(store, event)
      const sent = { id: event.id, runId: event.runId, at: event.at, repo: event.repo, design: event.design, pr: event.pr ?? null, type: event.type, artifactId: artifact ? artifact.id : null }
      const size = Buffer.byteLength(JSON.stringify(sent)) + (artifact ? Buffer.byteLength(JSON.stringify(artifact)) : 0)
      if (events.length === MAX_EVENTS || (artifact && artifacts.length === MAX_ARTIFACTS) || (events.length > 0 && bytes + size > MAX_HISTORY_BYTES)) break
      events.push(sent)
      if (artifact) artifacts.push(artifact)
      bytes += size
    }
    end = lineEnd
  }
  const known = lines.flatMap((line) => (line.event ? [line.event] : []))
  const body = JSON.stringify({ catalog: CATALOG, snapshot: snapshot(repos, known, effects.now()), events, artifacts })
  return { body, end, artifactIds: artifacts.map((artifact) => artifact.id), more: end < (pending.at(-1)?.end ?? cursor) }
}

export async function syncLoop(env: NodeJS.ProcessEnv, effects: SyncEffects, stop: Promise<void>): Promise<void> {
  const url = env.MARGE_API_URL ?? DEFAULT_URL
  const token = env.FACTORY_REPORT_TOKEN?.trim()
  if (!token) return effects.log('FACTORY_REPORT_TOKEN is not set, so the factory is not reporting to marge.')
  if (!url) return effects.log('MARGE_API_URL is empty, so the factory is not reporting to marge.')

  let stopping = false
  const waking = new AbortController()
  void stop.then(() => {
    stopping = true
    waking.abort()
  })
  let sentSignature: string | null = null
  let heartbeatAt = 0
  let retryAt = 0
  let more = false

  while (!stopping) {
    const now = effects.now().getTime()
    try {
      const signature = effects.signature()
      if (now >= retryAt && (more || signature !== sentSignature || now >= heartbeatAt)) {
        const push = nextPush(effects)
        const status = await effects.post(`${url}/v1/factory/sync`, token, push.body)
        if (status !== 204) throw new Error(`marge answered ${status}`)
        effects.store.saveSyncCursor(push.end)
        for (const id of push.artifactIds) effects.store.forgetArtifact(id)
        sentSignature = signature
        heartbeatAt = now + HEARTBEAT_MS
        more = push.more
      }
    } catch (error) {
      effects.log(`Could not report to marge; trying again in a minute: ${(error as Error).message}`)
      retryAt = now + RETRY_MS
    }
    await effects.sleep(POLL_MS, waking.signal)
  }
}

// The real world for the sender: the factory's store and log, the watched repos and the network.
export function realSyncEffects(home: string, store: Store, repos: RepoConfig[], paused: ReadonlyMap<string, number>, sleep: SyncEffects['sleep'], log: SyncEffects['log']): SyncEffects {
  const events = path.join(home, 'events.jsonl')
  return {
    store,
    signature: () => JSON.stringify([fs.existsSync(events) ? fs.statSync(events).size : 0, [...paused]]),
    repos: () =>
      repos.map((repo) => {
        const id = repoIdFromRemote(execFileSync('git', ['-C', repo.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
        const claim = store.claimFor(id)
        return {
          claim,
          report: (number) => store.prReport(id, number),
          exitCode: paused.get(repo.path) ?? null,
          counts: countDesigns(path.join(home, 'worktrees', id.replaceAll('/', '__'), 'base'), claim?.design),
        }
      }),
    post: async (url, token, body) => {
      // fetch's own errors can quote the request headers, token and all, so only their cause is passed on.
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      }).catch((error: Error) => {
        throw new Error(`no answer (${(error.cause as NodeJS.ErrnoException | undefined)?.code ?? error.name})`)
      })
      await response.body?.cancel()
      return response.status
    },
    now: () => new Date(),
    sleep,
    log,
  }
}
