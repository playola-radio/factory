import type { World } from './build.ts'
import { readDesign } from './design.ts'
import { designValues, qaRulesBlock, renderPrompt } from './prompts.ts'
import { fingerprint } from './repo.ts'
import type { RepoRules } from './repo.ts'
import type { Claim, PrReport, ReviewReport } from './store.ts'
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
  const save = (): PrReport => {
    const saved = { ...report, review, ...(afterPushStamp === undefined ? {} : { afterPushStamp }) }
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
  const post = (answers: Awaited<ReturnType<typeof ask>>, reReview: boolean) => {
    for (const { item, reply } of answers) workshop.reply(number, item, reply!.reply, reply!.action === 'fixed' && !item.fromOwner)
    if (reReview) workshop.requestReview(number)
    review = { ...review, answered: [...review.answered, ...answers.filter(({ item }) => item.kind === 'comment').map(({ item }) => item.id)] }
  }
  let toldOwner = false
  let held: { answers: Awaited<ReturnType<typeof ask>>; reReview: boolean } | undefined

  for (;;) {
    const github = workshop.pullRequestState(number)
    if (github.state !== 'open') return end(github.state)
    const { afterPush } = rules
    // Until the worktree matches GitHub and the after-push command has run on it, a pass may fix and push but posts nothing and cannot merge.
    const synced = !afterPush || workshop.head(worktree) === github.head
    if (afterPush && synced) {
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
    if (held && synced) {
      justPosted = new Set(held.answers.filter(({ item }) => !item.fromOwner).map(({ item }) => item.id))
      post(held.answers, held.reReview)
      held = undefined
      save()
      record('review round')
    }
    const unanswered = github.items.filter((item) => !review.answered.includes(item.id) && !held?.answers.some(({ item: heldItem }) => heldItem.id === item.id) && !justPosted?.has(item.id))
    if (github.checks === 'pending') {
      await workshop.wait()
      continue
    }
    if (synced && github.approved && github.checks === 'passed' && !github.conflicts) {
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
    if (afterPush && (pushed || !synced)) held = { answers: [...(held?.answers ?? []), ...answers], reReview: held?.reReview || reReview }
    else post(answers, reReview)
    save()
    if (!held) record('review round')
    if (!synced) continue
  }
}
