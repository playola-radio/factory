import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { readDesign } from './design.ts'
import { designStatuses, readApprovedPlan } from './readiness.ts'
import type { Claim, Store } from './store.ts'
import type { PlannedPr } from './types.ts'

export interface World {
  store: Store
  repoId: string
  remoteBranches(prefix: string): string[]
  now(): string
  // Bytes free on the volume holding the factory home. Injected so builds can refuse before a step runs out.
  freeSpace(): number
}

const GB = 1024 ** 3
const DEFAULT_MIN_FREE_GB = 20

// The least free space a build will start a step with, from FACTORY_MIN_FREE_GB (binary GB), default 20 GB.
export function minFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FACTORY_MIN_FREE_GB
  const gb = raw === undefined || raw.trim() === '' ? DEFAULT_MIN_FREE_GB : Number(raw)
  if (!Number.isFinite(gb) || gb < 0) {
    throw new Error(`FACTORY_MIN_FREE_GB must be a non-negative number of gigabytes, not ${JSON.stringify(raw)}.`)
  }
  return gb * GB
}

const asGb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`

export class LowDiskError extends Error {
  readonly free: number
  readonly needed: number
  constructor(free: number, needed: number) {
    super(`Not enough disk space to build: ${asGb(free)} free on the factory volume, ${asGb(needed)} needed. Free up space, then restart the build.`)
    this.name = 'LowDiskError'
    this.free = free
    this.needed = needed
  }
}

// Refuses, recording the refusal, when free space on the factory volume is below the floor. Called before the
// build claims a design and before each agent step, so a step never starts only to crash with ENOSPC partway.
export function ensureDiskSpace(world: World, design: string, env: NodeJS.ProcessEnv = process.env): void {
  const free = world.freeSpace()
  const needed = minFreeBytes(env)
  if (free >= needed) return
  // Best effort: the refusal message and exit code matter more than the event, and the volume that is too full
  // to build may also be too full to append to events.jsonl.
  try {
    world.store.record({ at: world.now(), repo: world.repoId, design, type: 'build refused for space' })
  } catch {
    // The disk is full enough that even the event cannot be written; still refuse with the clear message.
  }
  throw new LowDiskError(free, needed)
}

export type BuildReport =
  | { state: 'started' | 'already in progress'; design: string; claim: Claim }
  | { state: 'not buildable' | 'refused'; design: string; reasons: string[] }
  | { state: 'nothing to build' }

export const branchPrefix = (design: string) => `factory/${design}/`

export function startOrResume(repo: string, world: World, base: string): BuildReport {
  const prsOf = (design: string) => readApprovedPlan(repo, readDesign(repo, design.slice(0, 3))).prs
  const existing = world.store.claimFor(world.repoId)
  if (existing && existing.base !== base) {
    throw new Error(`${existing.design} is in progress on base ${existing.base}, not ${base}; abandon it first to change the base.`)
  }
  if (existing && !isDeepStrictEqual(prsOf(existing.design), existing.prs)) {
    return { state: 'refused', design: existing.design, reasons: ['The implementation plan changed after this build started; abandon the build to start again from the new plan.'] }
  }
  if (existing) return { state: 'already in progress', design: existing.design, claim: existing }

  const [next] = designStatuses(repo)
  if (!next) return { state: 'nothing to build' }
  if (!next.buildable) return { state: 'not buildable', design: next.design, reasons: next.reasons }

  const branches = world.remoteBranches(branchPrefix(next.design))
  if (branches.length > 0) {
    return {
      state: 'refused',
      design: next.design,
      reasons: [`GitHub already has factory branches for this design but there is no record of a build here: ${branches.join(', ')}`],
    }
  }

  ensureDiskSpace(world, next.design)
  const claim: Claim = { repo: world.repoId, design: next.design, base, startedAt: world.now(), prs: prsOf(next.design) }
  world.store.claim(claim)
  world.store.record({ at: claim.startedAt, repo: claim.repo, design: claim.design, type: 'design claimed' })
  return { state: 'started', design: next.design, claim }
}

export function abandon(world: World): { state: 'abandoned'; design: string; deleteBeforeBuildingAgain: string[] } | { state: 'nothing in progress' } {
  const claim = world.store.claimFor(world.repoId)
  if (!claim) return { state: 'nothing in progress' }
  world.store.release(world.repoId)
  world.store.record({ at: world.now(), repo: claim.repo, design: claim.design, type: 'design abandoned' })
  return { state: 'abandoned', design: claim.design, deleteBeforeBuildingAgain: world.remoteBranches(branchPrefix(claim.design)) }
}

export function finish(world: World): void {
  const claim = world.store.claimFor(world.repoId)
  if (!claim) return
  world.store.release(world.repoId)
  world.store.record({ at: world.now(), repo: claim.repo, design: claim.design, type: 'design finished' })
}

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

// Takes the per-repo build lock atomically: creates build.pid with O_EXCL so it never overwrites a lock a live
// build still holds (that build and this one would otherwise run agents in the same worktrees and clobber each
// other). A lock left by a dead process is stale and gets taken over. Throws if another build is alive.
export function acquireLock(lockPath: string, repoId: string, isAlive: (pid: number) => boolean): void {
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const other = Number(fs.readFileSync(lockPath, 'utf8'))
      if (other && other !== process.pid && isAlive(other)) {
        throw new Error(`A factory build is already running on ${repoId} (process ${other}).`)
      }
      fs.rmSync(lockPath, { force: true })
    }
  }
}

export function repoIdFromRemote(url: string): string {
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/)
  if (!match) throw new Error(`Cannot tell which repository this is from its origin address: ${url}`)
  return match[1]
}

// Free space on the volume holding `target`, walking up to the nearest existing ancestor so a home that does
// not exist yet (a first run) still reports the right volume.
export function freeSpaceOn(target: string): number {
  let dir = target
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const { bavail, bsize } = fs.statfsSync(dir)
  return bavail * bsize
}

export function realWorld(repo: string, store: Store, home: string): World {
  return {
    store,
    repoId: repoIdFromRemote(git(repo, 'remote', 'get-url', 'origin')),
    remoteBranches: (prefix) =>
      git(repo, 'ls-remote', '--heads', 'origin', `${prefix}*`)
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t')[1].replace('refs/heads/', '')),
    now: () => new Date().toISOString(),
    freeSpace: () => freeSpaceOn(home),
  }
}
