import { createHash } from 'node:crypto'

import { DEFAULT_MODEL, NO_DELEGATION } from './agents.ts'
import { ensureDiskSpace } from './build.ts'
import type { World } from './build.ts'
import { readDesign } from './design.ts'
import { designValues, renderPrompt } from './prompts.ts'
import type { Claim, GateFinding, GateReport, GateRound, PrReport } from './store.ts'
import type { PlannedPr } from './types.ts'
import { branchProblems } from './workshop.ts'
import type { Workshop } from './workshop.ts'

const MAX_ROUNDS = 3
const SMALL_FIX_LINES = 30
// Trying again cannot get past a spent codex allowance, and would only hide why the pass failed.
const USAGE_LIMIT = /usage limit|rate[ _]limit|too many requests/i

type Failure = { error: string; limited: boolean }
type Pass<T> = { findings: T[] } | Failure

async function twice<T>(run: () => Promise<{ findings: T[] }>): Promise<Pass<T>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const message = (error as Error).message
      const limited = USAGE_LIMIT.test(message)
      if (limited || attempt === 2) return { error: message, limited }
    }
  }
}

const failure = (pass: string, round: number, { error, limited }: Failure) =>
  limited ? `The ${pass} hit the codex usage limit in round ${round} — try again after it resets: ${error}` : `The ${pass} failed twice in round ${round}: ${error}`

export async function runGate(pr: PlannedPr, claim: Claim, report: PrReport, world: World, workshop: Workshop): Promise<GateReport> {
  const { worktree } = report
  const event = { repo: claim.repo, design: claim.design, runId: claim.runId, pr: pr.number }
  const values = {
    ...designValues(readDesign(worktree, claim.design.slice(0, 3))),
    pr_number: String(pr.number),
    pr_title: pr.title,
    base: claim.base,
    branch: report.branch,
    no_delegation: NO_DELEGATION.codex,
  }
  const rounds: GateRound[] = []
  const end = (state: GateReport['state'], problems: string[] = []): GateReport => {
    const gate = { state, rounds, problems }
    world.store.record({ ...event, at: world.now(), type: `gate ${state}` }, { ...report, gate })
    return gate
  }
  world.store.record({ ...event, at: world.now(), type: 'gate started' })
  // A pass is kept by the exact commit, prompt and model it reviewed, so a gate resumed after an interruption reviews
  // each code state once, as an uninterrupted gate would, instead of paying again for reviews it already has. Within
  // one run, a round on a commit already reviewed (every finding declined, nothing committed) reviews it afresh.
  const reviewedThisRun = new Set<string>()
  const review = async <T>(head: string, template: string, run: (prompt: string) => Promise<{ findings: T[] }>): Promise<Pass<T>> => {
    const prompt = renderPrompt(template, values)
    const key = createHash('sha256').update([head, template, DEFAULT_MODEL.codex, prompt].join('\n')).digest('hex')
    const kept = reviewedThisRun.has(key) ? null : world.store.gatePass<T>(claim.repo, key)
    reviewedThisRun.add(key)
    if (kept) {
      world.store.record({ ...event, at: world.now(), type: 'gate pass cached' })
      return kept
    }
    const pass = await twice(() => run(prompt))
    if ('findings' in pass) world.store.saveGatePass(claim.repo, key, pass)
    return pass
  }

  let auditExcess = true
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    ensureDiskSpace(world, claim)
    const step = `gate-pr-${pr.number}-round-${round}`
    const before = workshop.head(worktree)
    const [broken, excess] = await Promise.all([
      review(before, 'gate-break', (prompt) => workshop.breakIt(worktree, prompt, `${step}-break-it`)),
      auditExcess ? review(before, 'gate-excess', (prompt) => workshop.auditExcess(worktree, prompt, `${step}-excess`)) : { findings: [] },
    ])
    if ('error' in broken) return end('did not run', [failure('break-it pass', round, broken)])
    if ('error' in excess) return end('did not run', [failure('excess audit', round, excess)])

    const findings: GateFinding[] = [
      ...broken.findings.map((finding, index) => ({ id: `B${index + 1}`, severity: finding.severity, where: finding.where, problem: finding.problem })),
      ...excess.findings.map((finding, index) => ({
        id: `E${index + 1}`,
        severity: 'excess' as const,
        where: finding.where,
        problem: `Delete: ${finding.delete} What breaks if deleted: ${finding.breaks}`,
      })),
    ]
    const clean = !findings.some((finding) => finding.severity === 'P0' || finding.severity === 'P1')
    const current: GateRound = { round, verdict: clean ? 'clean' : 'not clean', excessAudited: auditExcess, findings }
    rounds.push(current)
    if (findings.length === 0) return end('clean')
    if (!clean && round === MAX_ROUNDS) return end('stopped at round limit')

    const fix = await workshop.fix(
      worktree,
      renderPrompt('gate-fix', {
        ...values,
        findings: findings.map((finding) => `- **${finding.id}** [${finding.severity}] \`${finding.where}\`: ${finding.problem}`).join('\n'),
      }),
      `${step}-fix`,
    )
    const lines = workshop.linesChanged(worktree, before)
    current.fix = { ...fix, ...lines }
    const settled = new Set(fix.dispositions.map((disposition) => disposition.id))
    const problems = [
      ...fix.blockers.map((blocker) => `Blocked: ${blocker}`),
      ...fix.checks.filter((check) => !check.passed).map((check) => `Check failed: ${check.command}`),
      ...findings.filter((finding) => !settled.has(finding.id)).map((finding) => `Finding ${finding.id} was neither fixed nor declined.`),
      ...branchProblems(workshop, worktree, claim.base, claim.design),
    ]
    if (problems.length > 0) return end('fix failed', problems)
    if (clean && (round === MAX_ROUNDS || lines.added + lines.deleted <= SMALL_FIX_LINES)) return end('clean')
    auditExcess = lines.added > lines.deleted
  }
  throw new Error('unreachable: the last round always ends the gate')
}
