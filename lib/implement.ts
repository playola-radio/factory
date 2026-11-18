import { isDeepStrictEqual } from 'node:util'

import { branchPrefix } from './build.ts'
import type { World } from './build.ts'
import { readDesign } from './design.ts'
import { designValues, renderPrompt } from './prompts.ts'
import { designStatuses, readApprovedPlan } from './readiness.ts'
import type { Claim, Implementation, PrReport } from './store.ts'
import type { PlannedPr } from './types.ts'

export interface Workshop {
  prepareWorktree(base: string, branch: string): string
  mergeBase(worktree: string, base: string): 'merged' | 'conflicts'
  implement(worktree: string, prompt: string, step: string): Promise<Implementation>
  commitMessages(worktree: string, base: string): string[]
  uncommittedFiles(worktree: string): string[]
}

export type PrBuildReport =
  | PrReport
  | { state: 'all PRs implemented' }
  | { state: 'waiting' | 'stopped'; number: number; reason: string }

const MAX_ATTEMPTS = 3

const MERGE_NOTE = {
  merged: 'The latest `{base}` has been merged in cleanly.',
  conflicts: 'Merging the latest `{base}` left conflicts. Resolve them first, keeping both sides\' intent, and commit the merge.',
}

const planIsIntact = (worktree: string, design: string) =>
  designStatuses(worktree).some((status) => status.design === design && status.buildable)

export async function buildNextPr(prs: PlannedPr[], claim: Claim, world: World, workshop: Workshop): Promise<PrBuildReport> {
  const pr = prs.find((planned) => world.store.prReport(claim.repo, planned.number)?.state !== 'implemented')
  if (!pr) return { state: 'all PRs implemented' }
  const previous = world.store.prReport(claim.repo, pr.number)
  const attempts = previous?.attempts ?? (previous ? 1 : 0)
  if (previous && attempts >= MAX_ATTEMPTS) {
    return { state: 'stopped', number: pr.number, reason: `PR ${pr.number} still needs attention after ${attempts} attempts: ${previous.problems.join('; ')}. Its work is in ${previous.worktree}.` }
  }
  if (pr.dependsOn.length > 0) {
    return { state: 'waiting', number: pr.number, reason: `PR ${pr.number} builds on PR ${pr.dependsOn.join(', ')}; building on an earlier PR is not written yet.` }
  }

  const branch = `${branchPrefix(claim.design)}pr-${pr.number}`
  const worktree = workshop.prepareWorktree(claim.base, branch)
  const merge = previous ? workshop.mergeBase(worktree, claim.base) : null
  const number = claim.design.slice(0, 3)
  if (!planIsIntact(worktree, claim.design) || !isDeepStrictEqual(readApprovedPlan(worktree, readDesign(worktree, number)).prs, prs)) {
    throw new Error(`${claim.base} does not hold the finished plan for ${claim.design} that this checkout has. Merge the design there, or abandon and build with the right --base.`)
  }

  const event = { repo: claim.repo, design: claim.design, pr: pr.number }
  world.store.record({ ...event, at: world.now(), type: 'pr started' })
  const values = { ...designValues(readDesign(worktree, number)), pr_number: String(pr.number), pr_title: pr.title, base: claim.base, branch }
  const prompt = previous && merge
    ? renderPrompt('finish', {
        ...values,
        merge_note: MERGE_NOTE[merge].replace('{base}', claim.base),
        last_summary: previous.implementation.summary,
        problems: previous.problems.map((problem) => `- ${problem}`).join('\n'),
      })
    : renderPrompt('implement', values)
  const implementation = await workshop.implement(worktree, prompt, `implement-pr-${pr.number}`)

  const commits = workshop.commitMessages(worktree, claim.base)
  const uncommitted = workshop.uncommittedFiles(worktree)
  const problems = [
    ...implementation.blockers.map((blocker) => `Blocked: ${blocker}`),
    ...implementation.checks.filter((check) => !check.passed).map((check) => `Check failed: ${check.command}`),
    ...(implementation.status === 'blocked' && implementation.blockers.length === 0 ? ['The implementer stopped without saying what blocked it.'] : []),
    ...(commits.length === 0 ? ['No commits were made.'] : []),
    ...(commits.some((message) => /co-authored-by/i.test(message)) ? ['A commit message has a Co-Authored-By line.'] : []),
    ...(uncommitted.length > 0 ? [`Uncommitted changes: ${uncommitted.join(', ')}`] : []),
    ...(planIsIntact(worktree, claim.design) ? [] : ['The design folder or its plan was changed.']),
  ]
  const report: PrReport = {
    state: problems.length === 0 ? 'implemented' : 'needs attention',
    number: pr.number,
    attempts: attempts + 1,
    branch,
    worktree,
    commits: commits.map((message) => message.split('\n')[0]),
    problems,
    implementation,
  }
  world.store.savePrReport(claim.repo, report)
  world.store.record({ ...event, at: world.now(), type: `pr ${report.state}` })
  return report
}
