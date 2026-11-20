#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { DEFAULT_MODEL, NO_DELEGATION, OTHER_VENDOR, runAgent } from '../lib/agents.ts'
import { readDesign } from '../lib/design.ts'
import { finalizePlan } from '../lib/finalize.ts'
import { abandon, finish, realWorld, startOrResume } from '../lib/build.ts'
import { buildDesign } from '../lib/implement.ts'
import { diskStore } from '../lib/store.ts'
import { loadWatchConfig, realIsGitClone, realWatchEffects, watch } from '../lib/watch.ts'
import { baseView, realWorkshop } from '../lib/workshop.ts'
import { designValues, renderPrompt } from '../lib/prompts.ts'
import { designStatuses } from '../lib/readiness.ts'
import type { Review, Vendor } from '../lib/types.ts'

const USAGE = `Usage:
  factory finalize <repo-path> [design-number] [--author claude|codex] [--reviewer-model <id>]
                                  check ImplementationPlan.md, have the other vendor review it, and mark it finished
                                  (no number: the first design without a finished plan; --author is who wrote the plan)
  factory status <repo-path>      list factory/ready and say which have a finished plan and can be built
  factory build <repo-path> [--base <branch>] [--model <id>] [--one-design]
                                  start the next design on the base branch as GitHub has it (or continue the one in progress) and implement its next PR
                                  in a fresh worktree, or finish one that needs attention (three attempts at most), then put it
                                  through the review gate (Codex tries to break it and audits it for excess, the implementer
                                  fixes, three rounds at most), then push it and open its PR as marge-watson and stay with it: fix or answer what reviewers say, merge it once
                                  the owner approves, and go on to the next PR and then the next design (the last PR moves its design to factory/done;
                                  --one-design stops once the current design is finished); --base is the branch its PRs go into (default develop)
  factory abandon <repo-path>     give up the design in progress so the next build can start
  factory watch [--config <path>] keep a factory build running for every repo in the config (default
                                  $FACTORY_HOME/watch.json), building new designs unattended until stopped with
                                  SIGTERM; a repo whose build exits non-zero is left until the watcher restarts

  finalize exits 0 when the plan is finished, 2 when the plan needs fixing, 1 on an error.`

const HOME = process.env.FACTORY_HOME || path.join(os.homedir(), '.factory')
const SCHEMAS_DIR = path.join(import.meta.dirname, '..', 'schemas')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function finalize(repoArg: string, numberArg: string | undefined, options: Record<string, string | undefined>) {
  const repo = path.resolve(repoArg)
  const number = numberArg ?? designStatuses(repo).find((status) => !status.buildable)?.design.slice(0, 3)
  if (!number) throw new Error('Every design in factory/ready already has a finished plan.')
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
      config: { type: 'string' },
      model: { type: 'string' },
      'one-design': { type: 'boolean' },
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
    const world = realWorld(repo, diskStore(HOME), HOME)
    if (command === 'abandon') {
      console.log(JSON.stringify(abandon(world), null, 2))
      return
    }
    const base = values.base || world.store.claimFor(world.repoId)?.base || 'develop'
    const buildDir = path.join(HOME, 'worktrees', world.repoId.replaceAll('/', '__'))
    const lock = path.join(buildDir, 'build.pid')
    const running = fs.existsSync(lock) && Number(fs.readFileSync(lock, 'utf8'))
    if (running && isAlive(running)) throw new Error(`A factory build is already running on ${world.repoId} (process ${running}).`)
    fs.mkdirSync(buildDir, { recursive: true })
    // The lock is written only once there is work, so that a build with nothing to build never writes build.pid
    // — on a full disk that write would ENOSPC and, as a non-zero exit, pause a repo that had no work. A
    // low-disk refusal (startOrResume throws before claiming) exits before the lock is written for the same reason.
    let locked = false
    const lockForWork = () => {
      if (locked) return
      fs.writeFileSync(lock, String(process.pid))
      process.on('exit', () => fs.rmSync(lock, { force: true }))
      locked = true
    }
    for (;;) {
      const report = startOrResume(baseView(repo, buildDir, base), world, base)
      if (report.state !== 'started' && report.state !== 'already in progress') {
        console.log(JSON.stringify(report, null, 2))
        if (report.state !== 'nothing to build') process.exitCode = 1
        return
      }
      lockForWork()
      const runDir = path.join(HOME, 'runs', `${path.basename(repo)}-${report.design}-build`)
      console.error(`${report.state}: ${report.design} on ${base}. Agent traces: ${runDir}/traces`)
      const pr = await buildDesign(report.claim.prs, report.claim, world, realWorkshop(repo, world.repoId, buildDir, runDir, values.model || DEFAULT_MODEL.claude))
      console.log(JSON.stringify({ design: report.design, base, ...pr }, null, 2))
      if (pr.state !== 'all PRs merged') {
        process.exitCode = 2
        return
      }
      finish(world)
      if (values['one-design']) return
    }
  }
  if (command === 'watch' && rest.length === 0) {
    const configPath = values.config || path.join(HOME, 'watch.json')
    if (!fs.existsSync(configPath)) throw new Error(`No watch config at ${configPath}. Create it (see the factory watch design) or pass --config.`)
    const config = loadWatchConfig(fs.readFileSync(configPath, 'utf8'), realIsGitClone, os.homedir())
    const stop = new Promise<void>((resolve) => {
      const onSignal = () => resolve()
      process.once('SIGTERM', onSignal)
      process.once('SIGINT', onSignal)
    })
    await watch(config, realWatchEffects(import.meta.filename), stop)
    return
  }
  if (command !== 'finalize' || rest.length < 1 || rest.length > 2) throw new Error(USAGE)
  const report = await finalize(rest[0], rest[1], { author: values.author, 'reviewer-model': values['reviewer-model'] })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.state === 'finished' ? 0 : 2
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
