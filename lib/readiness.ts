import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { readDesign } from './design.ts'
import { checkPlan, parsePlan, renderPlan, tidyPlan } from './plan.ts'
import type { PlanContent } from './plan.ts'
import type { ApprovedPlan, Design } from './types.ts'

export const PLAN_FILE = 'ImplementationPlan.md'
const SEAL = /\n<!-- factory: finished plan for design ([0-9a-f]{64}), plan ([0-9a-f]{64})\. [^\n]*-->\n/

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const planFile = (repo: string, design: Design) => path.join(repo, design.dir, PLAN_FILE)

export function designHash(repo: string, design: Design): string {
  const hash = createHash('sha256')
  for (const file of [...design.files, ...design.screenshots.map((name) => `screenshots/${name}`)]) {
    hash.update(file).update(fs.readFileSync(path.join(repo, design.dir, file)))
  }
  return hash.digest('hex')
}

export function recordApprovedPlan(repo: string, design: Design, plan: PlanContent): void {
  const content = tidyPlan(plan)
  const body = renderPlan(content, design)
  if (!isDeepStrictEqual(parsePlan(body), content)) {
    throw new Error(`The clean plan cannot be recorded: ${PLAN_FILE} would not read back as the same plan.`)
  }
  const seal = `<!-- factory: finished plan for design ${designHash(repo, design)}, plan ${sha(body)}. Any edit to this file or the design undoes it; run "factory finalize" again. -->`
  fs.writeFileSync(planFile(repo, design), `${body}\n${seal}\n`)
}

function readSealedPlan(repo: string, design: Design): { designHash: string; planHash: string; body: string } | null {
  if (!fs.existsSync(planFile(repo, design))) return null
  const text = fs.readFileSync(planFile(repo, design), 'utf8')
  const seal = SEAL.exec(text)
  return seal && { designHash: seal[1], planHash: seal[2], body: text.replace(seal[0], '') }
}

export function readPlanBody(repo: string, design: Design): string | null {
  if (!fs.existsSync(planFile(repo, design))) return null
  return fs.readFileSync(planFile(repo, design), 'utf8').replace(SEAL, '')
}

export function readApprovedPlan(repo: string, design: Design): ApprovedPlan {
  const sealed = readSealedPlan(repo, design)
  if (!sealed) throw new Error(`${design.name} has no finished implementation plan.`)
  return { designHash: sealed.designHash, ...parsePlan(sealed.body) }
}

export function reasonsNotBuildable(repo: string, design: Design): string[] {
  const sealed = readSealedPlan(repo, design)
  if (!sealed) return [`No finished implementation plan (${PLAN_FILE} is missing or was not finished by the factory); run "factory finalize".`]
  if (sha(sealed.body) !== sealed.planHash) return [`${PLAN_FILE} was edited after it was finished; run "factory finalize" again.`]
  const reasons = checkPlan(parsePlan(sealed.body), design)
  if (sealed.designHash !== designHash(repo, design)) {
    reasons.push('The design files changed after the plan was finished; run "factory finalize" again.')
  }
  return reasons
}

export function designStatuses(repo: string): { design: string; buildable: boolean; reasons: string[] }[] {
  const ready = path.join(repo, 'designs', 'ready')
  if (!fs.existsSync(ready)) return []
  return fs.readdirSync(ready).filter((name) => /^\d{3}-/.test(name)).sort().map((name) => {
    let reasons: string[]
    try {
      reasons = reasonsNotBuildable(repo, readDesign(repo, name.slice(0, 3)))
    } catch (error) {
      reasons = [(error as Error).message]
    }
    return { design: name, buildable: reasons.length === 0, reasons }
  })
}
