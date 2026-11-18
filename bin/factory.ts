#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { DEFAULT_MODEL, NO_DELEGATION, OTHER_VENDOR, runAgent } from '../lib/agents.ts'
import { readDesign } from '../lib/design.ts'
import { finalizePlan } from '../lib/finalize.ts'
import { abandon, realWorld, startOrResume } from '../lib/build.ts'
import { buildNextPr } from '../lib/implement.ts'
import { diskStore } from '../lib/store.ts'
import { realWorkshop } from '../lib/workshop.ts'
import { designValues, renderPrompt } from '../lib/prompts.ts'
import { designStatuses } from '../lib/readiness.ts'
import type { Review, Vendor } from '../lib/types.ts'

const USAGE = `Usage:
  factory finalize <repo-path> [design-number] [--author claude|codex] [--reviewer-model <id>]
                                  check ImplementationPlan.md, have the other vendor review it, and mark it finished
                                  (no number: the first design without a finished plan; --author is who wrote the plan)
  factory status <repo-path>      list designs/ready and say which have a finished plan and can be built
  factory build <repo-path> [--base <branch>] [--model <id>]
                                  start the next design (or continue the one in progress) and implement its next PR
                                  in a fresh worktree, or finish one that needs attention (three attempts at most); --base is the branch its PRs go into (default develop)
  factory abandon <repo-path>     give up the design in progress so the next build can start

  finalize exits 0 when the plan is finished, 2 when the plan needs fixing, 1 on an error.`

const HOME = process.env.FACTORY_HOME || path.join(os.homedir(), '.factory')
const SCHEMAS_DIR = path.join(import.meta.dirname, '..', 'schemas')

async function finalize(repoArg: string, numberArg: string | undefined, options: Record<string, string | undefined>) {
  const repo = path.resolve(repoArg)
  const number = numberArg ?? designStatuses(repo).find((status) => !status.buildable)?.design.slice(0, 3)
  if (!number) throw new Error('Every design in designs/ready already has a finished plan.')
  const design = readDesign(repo, number)
  const author = (options.author || 'claude') as Vendor
  if (!(author in OTHER_VENDOR)) throw new Error(`--author must be claude or codex, not ${author}`)
  const vendor = OTHER_VENDOR[author]
  const reviewer = { vendor, model: options['reviewer-model'] || DEFAULT_MODEL[vendor] }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const runDir = path.join(HOME, 'runs', `${path.basename(repo)}-${design.name}-${stamp}`)
  const report = await finalizePlan(repo, design, (plan) =>
    runAgent({
      ...reviewer,
      prompt: renderPrompt('review-plan', { ...designValues(design), no_delegation: NO_DELEGATION[vendor], plan }),
      schemaFile: path.join(SCHEMAS_DIR, 'review.json'),
      cwd: repo,
      runDir,
      step: 'review',
    }) as Promise<Review>,
  )
  return { ...report, design: design.name, reviewer, runDir }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      author: { type: 'string' },
      base: { type: 'string' },
      model: { type: 'string' },
      'reviewer-model': { type: 'string' },
    },
  })
  const [command, ...rest] = positionals
  if (command === 'status' && rest.length === 1) {
    const statuses = designStatuses(path.resolve(rest[0]))
    console.log(JSON.stringify(statuses, null, 2))
    return
  }
  if ((command === 'build' || command === 'abandon') && rest.length === 1) {
    const repo = path.resolve(rest[0])
    const world = realWorld(repo, diskStore(HOME))
    if (command === 'abandon') {
      console.log(JSON.stringify(abandon(world), null, 2))
      return
    }
    const report = startOrResume(repo, world, values.base || world.store.claimFor(world.repoId)?.base || 'develop')
    if (report.state !== 'started' && report.state !== 'already in progress') {
      console.log(JSON.stringify(report, null, 2))
      if (report.state !== 'nothing to build') process.exitCode = 1
      return
    }
    const buildDir = path.join(HOME, 'worktrees', world.repoId.replaceAll('/', '__'))
    const runDir = path.join(HOME, 'runs', `${path.basename(repo)}-${report.design}-build`)
    console.error(`${report.state}: ${report.design} on ${report.claim.base}. Agent traces: ${runDir}/traces`)
    const pr = await buildNextPr(report.prs, report.claim, world, realWorkshop(repo, buildDir, runDir, values.model || DEFAULT_MODEL.claude))
    console.log(JSON.stringify({ design: report.design, base: report.claim.base, ...pr }, null, 2))
    if (pr.state === 'needs attention' || pr.state === 'stopped') process.exitCode = 2
    return
  }
  if (command !== 'finalize' || rest.length < 1 || rest.length > 2) throw new Error(USAGE)
  const report = await finalize(rest[0], rest[1], values)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.state === 'finished' ? 0 : 2
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
