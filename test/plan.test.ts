import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readDesign } from '../lib/design.ts'
import { finalizePlan } from '../lib/finalize.ts'
import { checkPlan, parsePlan } from '../lib/plan.ts'
import { designStatuses } from '../lib/readiness.ts'
import type { Finding } from '../lib/types.ts'

const HAND_WRITTEN = `# 001-example — Implementation plan

The design files beside this plan are the truth; this plan only says how to build them.

One PR does it all.

| PR | Title | Depends on | Hard |
|---|---|---|---|
| 1 | feature: do the thing | — | no |

## PR 1 — feature: do the thing

A user can do the thing.

**Changes**

- Add the thing to \`Thing.swift\`.

**Tests**

- The thing works.

**Screenshots it must match**

- \`screenshots/a--default.png\`

**"Done when" items it delivers**

- 1. first outcome
`

function repoWithPlan(planText: string | null) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-finalize-'))
  const dir = path.join(repo, 'designs', 'ready', '001-example')
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'screenshots', 'a--default.png'), 'png')
  fs.writeFileSync(path.join(dir, 'Design.md'), '![a](screenshots/a--default.png)\n\n## Done when\n\n- [ ] first outcome\n')
  if (planText !== null) fs.writeFileSync(path.join(dir, 'ImplementationPlan.md'), planText)
  let reviews = 0
  const finalize = (findings: Finding[] = [], duringReview = () => {}) =>
    finalizePlan(repo, readDesign(repo, '001'), async () => {
      reviews++
      duringReview()
      return { findings }
    })
  return { repo, dir, finalize, reviews: () => reviews, buildable: () => designStatuses(repo)[0].buildable }
}
const finding = (severity: Finding['severity']): Finding => ({ severity, where: 'PR 1', problem: 'p', fix: 'f' })

test('a hand-written plan in the agreed layout reads as its PRs', () => {
  assert.deepEqual(parsePlan(HAND_WRITTEN), {
    summary: 'One PR does it all.',
    prs: [{ number: 1, title: 'feature: do the thing', goal: 'A user can do the thing.', changes: ['Add the thing to `Thing.swift`.'], tests: ['The thing works.'], dependsOn: [], screenshots: ['a--default.png'], doneWhen: [1], hard: false }],
  })
})

test('checkPlan reports unassigned, doubled and unknown items', () => {
  const pr = parsePlan(HAND_WRITTEN).prs[0]
  const design = { name: 'd', dir: 'd', files: [], screenshots: ['a--default.png', 'b.png'], doneWhen: ['one'] }
  const problems = checkPlan({ prs: [{ ...pr, doneWhen: [1, 1, 2] }] }, design).join(' ')
  assert.match(problems, /item 1 is assigned to 2 PRs/)
  assert.match(problems, /item 2 is not in the design/)
  assert.match(problems, /Screenshot b.png is assigned to 0 PRs/)
})

test('a plan that passes review is finished and the design becomes buildable', async () => {
  const { finalize, buildable } = repoWithPlan(HAND_WRITTEN)
  assert.deepEqual(await finalize([finding('P3')]), { state: 'finished', remainingFindings: [finding('P3')] })
  assert.equal(buildable(), true)
})

test('a blocking finding leaves the design not buildable', async () => {
  const { finalize, buildable } = repoWithPlan(HAND_WRITTEN)
  assert.equal((await finalize([finding('P2')])).state, 'review found problems')
  assert.equal(buildable(), false)
})

test('a missing plan is reported without paying for a review', async () => {
  const { finalize, reviews } = repoWithPlan(null)
  assert.equal((await finalize()).state, 'plan needs fixing')
  assert.equal(reviews(), 0)
})

test('a plan that leaves a checklist item out is reported without paying for a review', async () => {
  const { finalize, reviews } = repoWithPlan(HAND_WRITTEN.replace('- 1. first outcome', '- none'))
  assert.deepEqual(await finalize(), { state: 'plan needs fixing', problems: ['"Done when" item 1 is assigned to 0 PRs; it must be assigned to exactly one.'] })
  assert.equal(reviews(), 0)
})

test('a plan in the wrong layout is reported without paying for a review', async () => {
  const { finalize, reviews } = repoWithPlan(HAND_WRITTEN.replace('**Tests**', '### Tests'))
  const report = await finalize()
  assert.match(JSON.stringify(report), /PR 1 has no \*\*Tests\*\* list/)
  assert.equal(reviews(), 0)
})

test('a design edited during the review is not marked finished', async () => {
  const { dir, finalize, buildable } = repoWithPlan(HAND_WRITTEN)
  await assert.rejects(finalize([], () => fs.appendFileSync(path.join(dir, 'Design.md'), '\nlate change\n')), /changed while it was being reviewed/)
  assert.equal(buildable(), false)
})

test('a design file added during the review is not marked finished', async () => {
  const { dir, finalize, buildable } = repoWithPlan(HAND_WRITTEN)
  await assert.rejects(finalize([], () => fs.writeFileSync(path.join(dir, 'ApiContract.md'), '# API\n')), /changed while it was being reviewed/)
  assert.equal(buildable(), false)
})

test('finalizing again after a finished plan was edited reviews the edited plan', async () => {
  const { dir, finalize, reviews, buildable } = repoWithPlan(HAND_WRITTEN)
  await finalize()
  const file = path.join(dir, 'ImplementationPlan.md')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('The thing works.', 'The thing works twice.'))
  assert.equal(buildable(), false)
  await finalize()
  assert.equal(reviews(), 2)
  assert.equal(buildable(), true)
})
