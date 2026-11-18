import { execFileSync } from 'node:child_process'
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

export function repoIdFromRemote(url: string): string {
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/)
  if (!match) throw new Error(`Cannot tell which repository this is from its origin address: ${url}`)
  return match[1]
}

export function realWorld(repo: string, store: Store): World {
  return {
    store,
    repoId: repoIdFromRemote(git(repo, 'remote', 'get-url', 'origin')),
    remoteBranches: (prefix) =>
      git(repo, 'ls-remote', '--heads', 'origin', `${prefix}*`)
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t')[1].replace('refs/heads/', '')),
    now: () => new Date().toISOString(),
  }
}
