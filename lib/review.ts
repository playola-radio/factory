import type { World } from './build.ts'
import { readDesign } from './design.ts'
import { designValues, qaRulesBlock, renderPrompt } from './prompts.ts'
import { fingerprint } from './repo.ts'
import type { RepoRules } from './repo.ts'
import type { Claim, HeldReplies, PrReport, ReviewReport } from './store.ts'
import type { PlannedPr } from './types.ts'
import { branchProblems } from './workshop.ts'
import type { ReviewItem, Workshop } from './workshop.ts'

const MAX_BOT_ROUNDS = 3

const SITUATION = {
  open: 'the pull request is open and waiting on what is below.',
  conflicts: 'the latest `{base}` was merged into this branch and left conflicts. Resolve them first, keeping both sides\' intent, and commit the merge.',
  merged: 'the owner approved this pull request and it has already been merged, so nothing more can be pushed. Answer each item and change no file.',
}

// Stays with one open PR until it is merged or closed: fixes or answers what reviewers say, and merges once the owner approves.
export async function watchPr(pr: PlannedPr, claim: Claim, report: PrReport, world: World, workshop: Workshop, reReviewBelow: number, rules: RepoRules): Promise<PrReport> {
  const { worktree, branch } = report
  if (!report.pullRequest) throw new Error(`PR ${pr.number} has not been opened`)
  const { number, url } = report.pullRequest
  const record = (type: Parameters<World['store']['record']>[0]['type']) =>
    world.store.record({ repo: claim.repo, design: claim.design, pr: pr.number, at: world.now(), type })
  let review: ReviewReport = { rounds: report.review?.rounds ?? [], answered: report.review?.answered ?? [], problems: [] }
  let afterPushStamp = report.afterPushStamp
  let held = report.held
  const save = (): PrReport => {
    const saved: PrReport = { ...report, review, afterPushStamp, held }
    world.store.savePrReport(claim.repo, saved)
    return saved
  }
  const end = (state: NonNullable<ReviewReport['state']>, problems: string[] = []): PrReport => {
    review = { ...review, state, problems }
    record(state === 'fix failed' ? 'pr needs attention' : `pr ${state}`)
    return save()
  }
  const ask = async (items: ReviewItem[], failedChecks: string[], situation: keyof typeof SITUATION, head: string) => {
    for (const item of items) if (item.fromOwner) workshop.acknowledge(item)
    const labelled = items.map((item, index) => ({ label: `R${index + 1}`, item }))
    const wave = await workshop.answerReview(
      worktree,
      renderPrompt('review-fix', {
        ...designValues(readDesign(worktree, claim.design.slice(0, 3))),
        pr_number: String(pr.number),
        pr_title: pr.title,
        pr_url: url,
        base: claim.base,
        branch,
        situation: SITUATION[situation].replace('{base}', claim.base),
        items: labelled.map(({ label, item }) => `- **${label}** [${item.fromOwner ? 'owner' : 'reviewer'}]${item.where ? ` \`${item.where}\`` : ''}\n${item.text.replace(/^/gm, '  > ')}`).join('\n\n') || 'none',
        failed_checks: failedChecks.join(', ') || 'none',
        qa_rules: qaRulesBlock(rules.qaRules, claim.base),
      }),
      `review-pr-${pr.number}-round-${review.rounds.length + 1}`,
    )
    review = { ...review, rounds: [...review.rounds, { ...wave, head, forBots: failedChecks.length > 0 || items.some((item) => !item.fromOwner) }] }
    return labelled.map(({ label, item }) => ({ label, item, reply: wave.replies.find((candidate) => candidate.id === label) }))
  }
  const post = ({ replies, reReview }: HeldReplies) => {
    for (const { item, body, resolve } of replies) workshop.reply(number, item, body, resolve)
    if (reReview) workshop.requestReview(number)
    review = { ...review, answered: [...review.answered, ...replies.filter(({ item }) => item.kind === 'comment').map(({ item }) => item.id)] }
  }
  let toldOwner = false

  for (;;) {
    const github = workshop.pullRequestState(number)
    if (github.state !== 'open') return end(github.state)
    const { afterPush } = rules
    // With an after-push command, every effect below needs the worktree at GitHub's head, so bring the two together first without rewriting GitHub's branch.
    if (afterPush && workshop.head(worktree) !== github.head) {
      const caughtUp = workshop.catchUp(worktree, branch, github.head)
      if (caughtUp === 'conflicts') {
        return end('fix failed', [`The branch has new commits both on GitHub and in the worktree, and merging them would conflict. In ${worktree}, merge origin/${branch}, resolve the conflicts and commit, then build again.`])
      }
      if (caughtUp === 'pushed') {
        await workshop.wait()
        continue
      }
    }
    if (afterPush) {
      const changed = afterPush.whenChanged ? fingerprint(worktree, afterPush.whenChanged) : null
      if (afterPushStamp === undefined || (changed !== null && changed !== afterPushStamp)) {
        const command = afterPush.command.replaceAll('{pr}', String(number))
        try {
          workshop.afterPush(worktree, command)
        } catch (error) {
          return end('fix failed', [`The after-push command \`${command}\` failed: ${(error as Error).message}`])
        }
        if (workshop.head(worktree) !== github.head) {
          return end('fix failed', [`The after-push command \`${command}\` made a commit, and it must not commit.`])
        }
        afterPushStamp = (afterPush.whenChanged && fingerprint(worktree, afterPush.whenChanged)) ?? ''
        save()
      }
    }
    let justPosted: Set<string> | undefined
    if (held) {
      justPosted = new Set(held.replies.map(({ item }) => item.id))
      post(held)
      held = undefined
      save()
      record('review round')
    }
    const unanswered = github.items.filter((item) => !review.answered.includes(item.id) && !held?.replies.some(({ item: heldItem }) => heldItem.id === item.id) && !justPosted?.has(item.id))
    if (github.checks === 'pending') {
      await workshop.wait()
      continue
    }
    if (github.approved && github.checks === 'passed' && !github.conflicts) {
      workshop.merge(number, github.head)
      const questions = unanswered.filter((item) => item.fromOwner)
      if (questions.length > 0) {
        for (const { item, reply } of await ask(questions, [], 'merged', github.head)) if (reply) workshop.reply(number, item, reply.reply, false)
      }
      return end('merged')
    }
    const conflicts = github.conflicts && workshop.mergeBase(worktree, claim.base) === 'conflicts'
    if (github.conflicts && !conflicts) {
      workshop.push(worktree, branch)
      await workshop.wait()
      continue
    }
    const botsToo = review.rounds.filter((round) => round.forBots).length < MAX_BOT_ROUNDS
    const items = unanswered.filter((item) => item.fromOwner || botsToo)
    const handledHeads = review.rounds.filter((round) => round.blockers.length === 0 && round.checks.every((check) => check.passed)).map((round) => round.head)
    const failedChecks = botsToo && !handledHeads.includes(github.head) ? github.failedChecks : []
    if (items.length === 0 && failedChecks.length === 0 && !conflicts) {
      if (!toldOwner) record('pr waiting on owner')
      toldOwner = true
      await workshop.wait()
      continue
    }
    toldOwner = false

    const answers = await ask(items, failedChecks, conflicts ? 'conflicts' : 'open', github.head)
    const wave = review.rounds.at(-1)!
    const problems = [
      ...wave.blockers.map((blocker) => `Blocked: ${blocker}`),
      ...wave.checks.filter((check) => !check.passed).map((check) => `Check failed: ${check.command}`),
      ...answers.filter(({ reply }) => !reply).map(({ label, item }) => `No reply was written for ${item.where ?? 'a comment'} (${label}).`),
      ...branchProblems(workshop, worktree, claim.base, claim.design),
    ]
    if (problems.length > 0) return end('fix failed', problems)

    const pushed = workshop.head(worktree) !== github.head
    if (pushed) workshop.push(worktree, branch)
    const reReview = pushed && github.greptile?.score != null && github.greptile.score < reReviewBelow
    const replies = answers.map(({ item, reply }) => ({ item, body: reply!.reply, resolve: reply!.action === 'fixed' && !item.fromOwner }))
    if (afterPush && pushed) held = { replies: [...(held?.replies ?? []), ...replies], reReview: (held?.reReview ?? false) || reReview }
    else post({ replies, reReview })
    save()
    if (!held) record('review round')
  }
}
