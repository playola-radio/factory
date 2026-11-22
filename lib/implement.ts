import { isDeepStrictEqual } from 'node:util'

import { branchPrefix, ensureDiskSpace } from './build.ts'
import type { World } from './build.ts'
import { readDesign } from './design.ts'
import { runGate } from './gate.ts'
import { watchPr } from './review.ts'
import { designValues, renderPrompt } from './prompts.ts'
import { readApprovedPlan } from './readiness.ts'
import type { Claim, Implementation, PrReport, PullRequest } from './store.ts'
import type { PlannedPr } from './types.ts'
import { branchProblems, planIsIntact } from './workshop.ts'
import type { Workshop } from './workshop.ts'

export type PrBuildReport =
  | PrReport
  | { state: 'all PRs merged' }
  | { state: 'stopped'; number: number; reason: string }

const MAX_ATTEMPTS = 3

const MERGE_NOTE = {
  merged: 'The latest `{base}` has been merged in cleanly.',
  conflicts: 'Merging the latest `{base}` left conflicts. Resolve them first, keeping both sides\' intent, and commit the merge.',
}

// Builds PR after PR, each cut from the base branch once the one before it has merged there.
export async function buildDesign(prs: PlannedPr[], claim: Claim, world: World, workshop: Workshop): Promise<PrBuildReport> {
  for (;;) {
    const report = await buildNextPr(prs, claim, world, workshop)
    if (!('review' in report) || report.review?.state !== 'merged') return report
  }
}

export async function buildNextPr(prs: PlannedPr[], claim: Claim, world: World, workshop: Workshop): Promise<PrBuildReport> {
  const pr = prs.find((planned) => world.store.prReport(claim.repo, planned.number)?.review?.state !== 'merged')
  if (!pr) return { state: 'all PRs merged' }
  const previous = world.store.prReport(claim.repo, pr.number)
  if (previous?.review?.state === 'closed') {
    return { state: 'stopped', number: pr.number, reason: `PR ${pr.number} (${previous.pullRequest?.url}) was closed without being merged.` }
  }
  const last = pr === prs.at(-1)
  if (previous?.pullRequest) {
    if (last && workshop.markDesignBuilt(previous.worktree, claim.design)) workshop.push(previous.worktree, previous.branch)
    return watchPr(pr, claim, previous, world, workshop)
  }
  const openPr = (gated: PrReport): Promise<PrReport> => {
    if (last) workshop.markDesignBuilt(gated.worktree, claim.design)
    const body = pullRequestBody(gated, claim.design, pr.number, prs.length)
    const opened = { ...gated, pullRequest: workshop.openPullRequest(gated.worktree, gated.branch, claim.base, pr.title, body) }
    world.store.savePrReport(claim.repo, opened)
    world.store.record({ repo: claim.repo, design: claim.design, pr: pr.number, at: world.now(), type: 'pr opened' })
    return watchPr(pr, claim, opened, world, workshop)
  }
  const gate = async (implemented: PrReport): Promise<PrReport> => {
    const gated = { ...implemented, gate: await runGate(pr, claim, implemented, world, workshop) }
    world.store.savePrReport(claim.repo, gated)
    return gated.gate.state === 'clean' ? openPr(gated) : gated
  }
  if (previous?.state === 'implemented') {
    if (previous.gate?.state === 'clean') return openPr(previous)
    if (!previous.gate || previous.gate.state === 'did not run') return gate(previous)
    const open = [...previous.gate.problems, ...(previous.gate.rounds.at(-1)?.findings ?? []).map((finding) => `[${finding.severity}] ${finding.where}: ${finding.problem}`)]
    return { state: 'stopped', number: pr.number, reason: `PR ${pr.number}'s review gate ended "${previous.gate.state}": ${open.join('; ')}. Its work is in ${previous.worktree}.` }
  }
  const attempts = previous?.attempts ?? (previous ? 1 : 0)
  if (previous && attempts >= MAX_ATTEMPTS) {
    return { state: 'stopped', number: pr.number, reason: `PR ${pr.number} still needs attention after ${attempts} attempts: ${previous.problems.join('; ')}. Its work is in ${previous.worktree}.` }
  }

  ensureDiskSpace(world, claim.design)
  const branch = `${branchPrefix(claim.design)}pr-${pr.number}`
  // A PR with no local record may still be merged into the base on GitHub — e.g. the design was abandoned (which
  // wipes the store) and rebuilt, or the store was lost or moved. Its head branch is deleted on merge, so neither the
  // store nor the remote branch list signals it; only the merged PR GitHub keeps by head ref does. Record the
  // discovery so the next pass reads it from the store instead of asking GitHub again, then move on to the next PR.
  if (!previous) {
    const merged = workshop.mergedPullRequest(branch, claim.base)
    if (merged) {
      // The branch name carries only the design and PR number, so a merged PR from an earlier plan can match a
      // rewritten PR that reuses the number for different work. Its title is the plan title it was opened under; when
      // that no longer matches this PR's title the plan was rewritten after the merge — stop rather than skip new work.
      if (merged.title !== pr.title) {
        return { state: 'stopped', number: pr.number, reason: `${branch} is already merged on GitHub as PR ${merged.number} (${merged.url}) titled "${merged.title}", but PR ${pr.number} in the plan is now "${pr.title}". The plan was rewritten after that PR merged; reconcile it before rebuilding.` }
      }
      // The last PR's build is what moves the design into factory/done; a last PR already merged means that move never
      // rode a PR (the plan was shortened to end on an already-merged PR). Finishing while the design is still in
      // factory/ready would let the build loop re-claim it forever, so stop for the owner to move it. Once they have —
      // the design is in factory/done — fall through and finish, which releases the claim so the repo can advance.
      if (pr === prs.at(-1) && workshop.designAwaitingDone(claim.design)) {
        return { state: 'stopped', number: pr.number, reason: `Every PR for ${claim.design} is already merged on GitHub (PR ${pr.number}, ${merged.url}), but the design is still in factory/ready. Move it to factory/done on ${claim.base} to finish it.` }
      }
      world.store.savePrReport(claim.repo, mergedReport(pr.number, branch, merged))
      world.store.record({ repo: claim.repo, design: claim.design, pr: pr.number, at: world.now(), type: 'pr merged' })
      return buildNextPr(prs, claim, world, workshop)
    }
  }
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
  const problems = [
    ...implementation.blockers.map((blocker) => `Blocked: ${blocker}`),
    ...implementation.checks.filter((check) => !check.passed).map((check) => `Check failed: ${check.command}`),
    ...(implementation.status === 'blocked' && implementation.blockers.length === 0 ? ['The implementer stopped without saying what blocked it.'] : []),
    ...branchProblems(workshop, worktree, claim.base, claim.design),
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
  return report.state === 'implemented' ? gate(report) : report
}

// A stand-in report for a PR found already merged on GitHub with no local record, so the store treats it as done
// (and does not re-query GitHub) from here on. Its worktree is gone with the merged branch, so it carries none.
function mergedReport(number: number, branch: string, pullRequest: PullRequest): PrReport {
  return {
    state: 'implemented',
    number,
    attempts: 0,
    branch,
    worktree: '',
    commits: [],
    problems: [],
    implementation: { status: 'done', summary: 'Already merged on GitHub before this build; its branch is gone.', checks: [], blockers: [] },
    pullRequest,
    review: { state: 'merged', rounds: [], answered: [], problems: [] },
  }
}

function pullRequestBody(report: PrReport, design: string, number: number, total: number): string {
  const rounds = report.gate?.rounds ?? []
  const settled = rounds.flatMap((round) => round.fix?.dispositions ?? [])
  const declined = settled.filter((disposition) => disposition.action === 'declined')
  return [
    '# What & why',
    report.implementation.summary,
    `Built by the factory from \`factory/ready/${design}/\` (PR ${number} of ${total} in its plan).`,
    '## Review gate',
    `Clean after ${rounds.length} round${rounds.length === 1 ? '' : 's'}: ${settled.length - declined.length} findings fixed, ${declined.length} declined.`,
    ...declined.map((disposition) => `- ${disposition.id} declined: ${disposition.reason}`),
  ].join('\n\n')
}
