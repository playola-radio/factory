import { checkPlan, parsePlan, renderPlan, tidyPlan } from './plan.ts'
import type { PlanContent } from './plan.ts'
import { readDesign } from './design.ts'
import { designHash, PLAN_FILE, readPlanBody, recordApprovedPlan } from './readiness.ts'
import type { Design, Finding, Review } from './types.ts'

const BLOCKING = ['P1', 'P2']

export type FinalizeReport =
  | { state: 'finished'; remainingFindings: Finding[] }
  | { state: 'plan needs fixing'; problems: string[] }
  | { state: 'review found problems'; findings: Finding[] }

export async function finalizePlan(
  repo: string,
  design: Design,
  review: (planText: string) => Promise<Review>,
): Promise<FinalizeReport> {
  const written = readPlanBody(repo, design)
  if (written === null) return { state: 'plan needs fixing', problems: [`${PLAN_FILE} is missing; write it, then finalize.`] }
  let plan: PlanContent
  try {
    plan = tidyPlan(parsePlan(written))
  } catch (error) {
    return { state: 'plan needs fixing', problems: [(error as Error).message] }
  }
  const problems = checkPlan(plan, design)
  if (problems.length > 0) return { state: 'plan needs fixing', problems }

  const reviewedDesign = designHash(repo, design)
  const { findings } = await review(renderPlan(plan, design))
  const currentDesign = readDesign(repo, design.name.slice(0, 3))
  if (designHash(repo, currentDesign) !== reviewedDesign || readPlanBody(repo, currentDesign) !== written) {
    throw new Error('The design or the plan changed while it was being reviewed; run "factory finalize" again.')
  }
  if (findings.some((finding) => BLOCKING.includes(finding.severity))) return { state: 'review found problems', findings }
  recordApprovedPlan(repo, design, plan)
  return { state: 'finished', remainingFindings: findings }
}
