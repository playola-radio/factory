import { NO_DELEGATION } from './agents.ts'
import type { World } from './build.ts'
import { readDesign } from './design.ts'
import { designValues, renderPrompt } from './prompts.ts'
import type { Claim, GateFinding, GateReport, GateRound, PrReport } from './store.ts'
import type { PlannedPr } from './types.ts'
import { branchProblems } from './workshop.ts'
import type { Workshop } from './workshop.ts'

const MAX_ROUNDS = 3
const SMALL_FIX_LINES = 30

type Pass<T> = { findings: T[] } | { error: string }

async function twice<T>(run: () => Promise<{ findings: T[] }>): Promise<Pass<T>> {
  try {
    return await run()
  } catch {
    try {
      return await run()
    } catch (error) {
      return { error: (error as Error).message }
    }
  }
}

export async function runGate(pr: PlannedPr, claim: Claim, report: PrReport, world: World, workshop: Workshop): Promise<GateReport> {
  const { worktree } = report
  const event = { repo: claim.repo, design: claim.design, pr: pr.number }
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
    world.store.record({ ...event, at: world.now(), type: `gate ${state}` })
    return { state, rounds, problems }
  }
  world.store.record({ ...event, at: world.now(), type: 'gate started' })

  let auditExcess = true
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const step = `gate-pr-${pr.number}-round-${round}`
    const [broken, excess] = await Promise.all([
      twice(() => workshop.breakIt(worktree, renderPrompt('gate-break', values), `${step}-break-it`)),
      auditExcess ? twice(() => workshop.auditExcess(worktree, renderPrompt('gate-excess', values), `${step}-excess`)) : { findings: [] },
    ])
    if ('error' in broken) return end('did not run', [`The break-it pass failed twice in round ${round}: ${broken.error}`])
    if ('error' in excess) return end('did not run', [`The excess audit failed twice in round ${round}: ${excess.error}`])

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

    const before = workshop.head(worktree)
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
