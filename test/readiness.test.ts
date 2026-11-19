import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readDesign } from '../lib/design.ts'
import { designStatuses, readApprovedPlan, recordApprovedPlan } from '../lib/readiness.ts'
import type { PlanContent } from '../lib/plan.ts'

function plannedRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ready-'))
  const dir = path.join(repo, 'factory', 'ready', '001-example')
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'screenshots', 'a--default.png'), 'png')
  fs.writeFileSync(path.join(dir, 'Design.md'), '![a](screenshots/a--default.png)\n\n## Done when\n\n- [ ] first outcome\n')
  const plan: PlanContent = {
    summary: 'summary\n\nsecond paragraph',
    prs: [{ number: 1, title: 'feature: do the thing | and more', goal: 'goal', changes: ['first\nstep | `a`', '**Tests** of x'], tests: [], dependsOn: [], screenshots: ['a--default.png'], doneWhen: [1], hard: true }],
  }
  return { repo, dir, plan, record: () => recordApprovedPlan(repo, readDesign(repo, '001'), plan) }
}
const reasons = (repo: string) => designStatuses(repo)[0].reasons.join(' ')

test('a design with no finished plan is not buildable', () => {
  const { repo } = plannedRepo()
  assert.match(reasons(repo), /No finished implementation plan/)
})

test('a design whose plan was recorded as clean is buildable', () => {
  const { repo, record } = plannedRepo()
  record()
  assert.deepEqual(designStatuses(repo), [{ design: '001-example', buildable: true, reasons: [] }])
})

test('changing the design after planning makes it not buildable', () => {
  const { repo, dir, record } = plannedRepo()
  record()
  fs.appendFileSync(path.join(dir, 'Design.md'), '\nA late change.\n')
  assert.match(reasons(repo), /design files changed/)
})

test('editing a finished plan makes it not buildable', () => {
  const { repo, dir, record } = plannedRepo()
  record()
  fs.appendFileSync(path.join(dir, 'ImplementationPlan.md'), '\nextra step\n')
  assert.match(reasons(repo), /edited after it was finished/)
})

test('the recorded plan reads back as the plan that was approved', () => {
  const { repo, plan, record } = plannedRepo()
  record()
  const content = readApprovedPlan(repo, readDesign(repo, '001'))
  const expected = { summary: plan.summary, prs: [{ ...plan.prs[0], changes: ['first step | `a`', '**Tests** of x'] }] }
  assert.deepEqual(content, expected)
})

test('a plan file the factory did not finish is not buildable', () => {
  const { repo, dir } = plannedRepo()
  fs.writeFileSync(path.join(dir, 'ImplementationPlan.md'), '# 001-example — Implementation plan\n')
  assert.match(reasons(repo), /not finished by the factory/)
})

test('a design finished in designs/ready keeps its finished plan once moved to factory/ready', () => {
  const { repo, dir, plan } = plannedRepo()
  const design = readDesign(repo, '001')
  const old = path.join(repo, 'designs', 'ready', '001-example')
  fs.mkdirSync(path.dirname(old), { recursive: true })
  fs.renameSync(dir, old)
  recordApprovedPlan(repo, { ...design, dir: path.join('designs', 'ready', '001-example') }, plan)
  fs.renameSync(old, dir)
  assert.deepEqual(designStatuses(repo), [{ design: '001-example', buildable: true, reasons: [] }])
})
