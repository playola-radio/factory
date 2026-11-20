import path from 'node:path'

export interface RepoConfig {
  path: string
  base: string
}

export interface WatchConfig {
  pollSeconds: number
  repos: RepoConfig[]
}

export interface Started {
  design: string
  base: string
  resumed: boolean
}

const CONFIG_KEYS = new Set(['pollSeconds', 'repos'])
const REPO_KEYS = new Set(['path', 'base'])

function expandHome(repoPath: string, homeDir: string): string {
  const expanded = repoPath === '~' ? homeDir : repoPath.startsWith('~/') ? path.join(homeDir, repoPath.slice(2)) : repoPath
  return path.resolve(expanded)
}

// Reads and validates ~/.factory/watch.json. `isGitRepo` and `homeDir` are injected so this stays pure.
export function loadWatchConfig(text: string, isGitRepo: (repoPath: string) => boolean, homeDir: string): WatchConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`watch.json is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('watch.json must be a JSON object with a "repos" list.')
  const object = parsed as Record<string, unknown>
  for (const key of Object.keys(object)) if (!CONFIG_KEYS.has(key)) throw new Error(`watch.json has an unknown field "${key}"; allowed fields are pollSeconds and repos.`)

  const pollSeconds = object.pollSeconds ?? 300
  if (typeof pollSeconds !== 'number' || !Number.isFinite(pollSeconds) || pollSeconds <= 0) throw new Error(`watch.json pollSeconds must be a positive number, not ${JSON.stringify(object.pollSeconds)}.`)

  if (!Array.isArray(object.repos) || object.repos.length === 0) throw new Error('watch.json must list at least one repo under "repos".')
  const seen = new Set<string>()
  const repos: RepoConfig[] = object.repos.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`watch.json repo ${index} must be an object with "path" and "base".`)
    const repo = entry as Record<string, unknown>
    for (const key of Object.keys(repo)) if (!REPO_KEYS.has(key)) throw new Error(`watch.json repo ${index} has an unknown field "${key}"; allowed fields are path and base.`)
    if (typeof repo.path !== 'string' || repo.path === '') throw new Error(`watch.json repo ${index} needs a "path".`)
    if (typeof repo.base !== 'string' || repo.base === '') throw new Error(`watch.json repo "${repo.path}" needs a "base" branch; the watcher never guesses one.`)
    const resolved = expandHome(repo.path, homeDir)
    if (seen.has(resolved)) throw new Error(`watch.json lists the same repo twice: ${resolved}.`)
    seen.add(resolved)
    if (!isGitRepo(resolved)) throw new Error(`watch.json path is not a git clone: ${resolved}.`)
    return { path: resolved, base: repo.base }
  })
  return { pollSeconds, repos }
}

// `factory build` logs "started: <design> on <base>." or "already in progress: <design> on <base>." to stderr
// when it claims or picks up a design. Everything else on stderr is noise to the watcher.
export function startedFromStderrLine(line: string): Started | null {
  const match = line.match(/^(started|already in progress): (\S+) on (\S+)\./)
  if (!match) return null
  return { design: match[2], base: match[3], resumed: match[1] === 'already in progress' }
}

// `factory build` prints one pretty JSON report per design it finishes, then a terminal one, all to stdout.
// Reads every top-level JSON value out of the concatenated text by tracking brace depth outside strings.
export function parseBuildReports(stdout: string): unknown[] {
  const reports: unknown[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = -1
  for (let i = 0; i < stdout.length; i++) {
    const char = stdout[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}' || char === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        reports.push(JSON.parse(stdout.slice(start, i + 1)))
        start = -1
      }
    }
  }
  return reports
}

export type NotificationKind = 'build started' | 'design finished' | 'build stopped' | 'hold released' | 'watcher error'

export interface Notification {
  at: string
  kind: NotificationKind
  repo: string
  design?: string
  summary?: string
  detail?: unknown
}

// A hold remembers where the base branch and the claim stood when the build last ended badly.
export interface Hold {
  baseCommit: string | null
  claim: string | null
}

type Report = Record<string, unknown>

export function startedNotification(started: Started, repo: string, at: string): Notification {
  const summary = started.resumed
    ? `Picked up ${started.design} again on ${started.base}.`
    : `Started building ${started.design} on ${started.base}.`
  return { at, kind: 'build started', repo, design: started.design, summary }
}

function stoppedSummary(report: Report | undefined, error: string | undefined): string {
  if (!report) return `The build errored: ${error ?? 'no reason given'}.`
  const number = typeof report.number === 'number' ? report.number : undefined
  const where = typeof report.worktree === 'string' ? ` Its work is in ${report.worktree}.` : ''
  const review = report.review as Report | undefined
  const gate = report.gate as Report | undefined
  if (report.state === 'stopped') return String(report.reason)
  if (review?.state === 'closed') return `PR ${number} was closed without being merged.`
  if (review?.state === 'fix failed') return `PR ${number} could not be fixed: ${(review.problems as string[] ?? []).join('; ')}.${where}`
  if (gate && gate.state !== 'clean') return `PR ${number}'s review gate ended "${gate.state}": ${(gate.problems as string[] ?? []).join('; ')}.${where}`
  if (report.state === 'not buildable' || report.state === 'refused') return `${report.design}: ${(report.reasons as string[] ?? []).join('; ')}`
  return `${report.design ?? 'The build'} stopped (${report.state}).`
}

// Reads a finished build child's exit code and stdout reports into notifications, and says whether to hold.
// Retry (no hold) only for exit 0 or an exit-2 build still in `needs attention`; everything else holds.
export function interpretExit(exitCode: number, reports: unknown[], repo: string, at: string, error?: string): { notifications: Notification[]; hold: boolean } {
  const notifications: Notification[] = []
  for (const value of reports) {
    const report = value as Report
    if (report.state === 'all PRs merged') {
      notifications.push({ at, kind: 'design finished', repo, design: report.design as string, summary: `Every PR of ${report.design} merged.`, detail: report })
    }
  }
  const terminal = reports.at(-1) as Report | undefined
  const retry = exitCode === 0 || (exitCode === 2 && terminal?.state === 'needs attention')
  if (retry) return { notifications, hold: false }
  notifications.push({
    at,
    kind: 'build stopped',
    repo,
    design: terminal?.design as string | undefined,
    summary: stoppedSummary(terminal, error),
    detail: terminal ?? { error },
  })
  return { notifications, hold: true }
}

export function releaseReason(held: Hold, current: Hold): string | null {
  if (held.baseCommit !== current.baseCommit) return 'the base branch moved'
  if (held.claim !== current.claim) return 'the claim changed'
  return null
}

export function watcherErrorNotification(repo: string, cause: string, at: string): Notification {
  return { at, kind: 'watcher error', repo, summary: cause }
}

// Writes notifications, dropping one identical to the last written for its repo. A watcher error is written
// once and not again until `clearError` marks its cause gone.
export class Notifier {
  private lastWritten = new Map<string, string>()
  private outstandingError = new Map<string, string>()
  private readonly effect: (n: Notification) => void
  constructor(effect: (n: Notification) => void) {
    this.effect = effect
  }

  private key(n: Notification): string {
    return `${n.kind}\n${n.design ?? ''}\n${n.summary ?? ''}`
  }

  write(n: Notification): void {
    if (n.kind === 'watcher error') {
      if (this.outstandingError.get(n.repo) === n.summary) return
      this.outstandingError.set(n.repo, n.summary ?? '')
    } else if (this.lastWritten.get(n.repo) === this.key(n)) {
      return
    }
    this.effect(n)
    this.lastWritten.set(n.repo, this.key(n))
  }

  clearError(repo: string): void {
    this.outstandingError.delete(repo)
  }
}
