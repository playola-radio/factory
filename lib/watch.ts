import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

export interface RepoConfig {
  path: string
  base: string
}

export interface WatchConfig {
  pollSeconds: number
  repos: RepoConfig[]
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

// A running `factory build` child. `done` resolves its exit code; `stop` sends it SIGTERM.
export interface BuildHandle {
  done: Promise<number>
  stop(): void
}

// The watcher's whole contact with the world: start a build, sleep, log. Injected so the loop tests without processes.
export interface WatchEffects {
  startBuild(repo: RepoConfig): BuildHandle
  sleep(ms: number, signal: AbortSignal): Promise<void>
  log(message: string): void
}

// The thin scheduler: keep a `factory build` running for each repo. A build that exits 0 is a clean poll and may
// start again; one that exits non-zero pauses its repo until this process restarts. Nothing else is read.
export async function watch(config: WatchConfig, effects: WatchEffects, stop: Promise<void>): Promise<void> {
  let stopping = false
  // Aborted on shutdown so the pending poll sleep clears its timer at once, rather than keeping the process
  // alive (and launchd waiting to restart it) for the rest of pollSeconds.
  const waking = new AbortController()
  void stop.then(() => {
    stopping = true
    waking.abort()
  })
  const running = new Map<string, BuildHandle>()
  const paused = new Set<string>()

  while (!stopping) {
    for (const repo of config.repos) {
      if (stopping) break
      if (running.has(repo.path) || paused.has(repo.path)) continue
      const handle = effects.startBuild(repo)
      running.set(repo.path, handle)
      effects.log(`Started factory build for ${repo.path} on ${repo.base}.`)
      void handle.done.then((code) => {
        running.delete(repo.path)
        if (!stopping && code !== 0) {
          paused.add(repo.path)
          effects.log(`factory build for ${repo.path} exited ${code}; leaving it until the watcher restarts.`)
        }
      })
    }
    await Promise.race([effects.sleep(config.pollSeconds * 1000, waking.signal), stop])
  }

  const handles = [...running.values()]
  for (const handle of handles) handle.stop()
  await Promise.all(handles.map((handle) => handle.done.catch(() => 0)))
}

export function realIsGitClone(repoPath: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Runs a command in its own process group (`detached`), so stop() can signal the whole tree — a `factory build`
// launches `claude`/`codex` as its own children and does not forward signals, so killing only the build's node
// process would orphan the agent and let it keep editing the worktree while the next build resumes it.
export function spawnTree(command: string, args: string[]): BuildHandle {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env, detached: true })
  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
  return {
    done,
    stop: () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone, or we never became a group leader; nothing to stop.
      }
    },
  }
}

export function realWatchEffects(binPath: string): WatchEffects {
  return {
    startBuild(repo) {
      return spawnTree(process.execPath, [binPath, 'build', repo.path, '--base', repo.base])
    },
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve()
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    log: (message) => console.error(message),
  }
}
