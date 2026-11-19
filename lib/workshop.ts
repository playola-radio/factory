import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { runAgent } from './agents.ts'
import { readDesign } from './design.ts'
import { reasonsNotBuildable } from './readiness.ts'
import type { Settings } from './settings.ts'
import type { FixWave, Implementation, PullRequest, ReviewWave } from './store.ts'

export interface BreakFinding {
  severity: 'P0' | 'P1' | 'P2' | 'P3'
  where: string
  problem: string
}

export interface ExcessFinding {
  where: string
  delete: string
  breaks: string
}

// One unresolved review thread that is waiting on the author, or one top-level comment from the owner.
export interface ReviewItem {
  id: string
  kind: 'thread' | 'comment'
  // The GitHub comment a reaction goes on.
  latest: string
  fromOwner: boolean
  where?: string
  text: string
}

export interface PullRequestState {
  state: 'open' | 'merged' | 'closed'
  head: string
  approved: boolean
  conflicts: boolean
  checks: 'pending' | 'passed' | 'failed'
  failedChecks: string[]
  // null when Greptile is not in use; a null score means none posted yet or unreadable.
  greptile: { score: number | null } | null
  items: ReviewItem[]
}

export interface Workshop {
  prepareWorktree(base: string, branch: string): string
  mergeBase(worktree: string, base: string): 'merged' | 'conflicts'
  implement(worktree: string, prompt: string, step: string): Promise<Implementation>
  breakIt(worktree: string, prompt: string, step: string): Promise<{ findings: BreakFinding[] }>
  auditExcess(worktree: string, prompt: string, step: string): Promise<{ findings: ExcessFinding[] }>
  fix(worktree: string, prompt: string, step: string): Promise<FixWave>
  head(worktree: string): string
  linesChanged(worktree: string, since: string): { added: number; deleted: number }
  commitMessages(worktree: string, base: string): string[]
  uncommittedFiles(worktree: string): string[]
  // Moves the design to factory/done in one commit; false when it is already there.
  markDesignBuilt(worktree: string, design: string): boolean
  openPullRequest(worktree: string, branch: string, base: string, title: string, body: string): PullRequest
  // Runs the repo's after-push command in the worktree with the bot's token; throws with its last output when it fails.
  afterPush(worktree: string, command: string): Promise<void>
  pullRequestState(number: number): PullRequestState
  answerReview(worktree: string, prompt: string, step: string): Promise<ReviewWave>
  push(worktree: string, branch: string): void
  // Brings the worktree and the PR branch on GitHub to the same commit, never rewriting GitHub's: fast-forwards to it, pushes local commits on top of it, or merges the two and pushes. A conflicting merge is undone.
  catchUp(worktree: string, branch: string, theirs: string): 'fast-forwarded' | 'pushed' | 'conflicts' | 'changed'
  // Marks a comment as seen with an eyes reaction.
  acknowledge(item: ReviewItem): void
  reply(number: number, item: Pick<ReviewItem, 'id' | 'kind' | 'text'>, body: string): void
  resolve(thread: string): void
  requestReview(number: number): void
  merge(number: number, head: string): void
  wait(): Promise<void>
}

export function planIsIntact(worktree: string, design: string): boolean {
  try {
    return reasonsNotBuildable(worktree, readDesign(worktree, design.slice(0, 3))).length === 0
  } catch {
    return false
  }
}

export function branchProblems(workshop: Workshop, worktree: string, base: string, design: string): string[] {
  const commits = workshop.commitMessages(worktree, base)
  const uncommitted = workshop.uncommittedFiles(worktree)
  return [
    ...(commits.length === 0 ? ['No commits were made.'] : []),
    ...(commits.some((message) => /co-authored-by/i.test(message)) ? ['A commit message has a Co-Authored-By line.'] : []),
    ...(uncommitted.length > 0 ? [`Uncommitted changes: ${uncommitted.join(', ')}`] : []),
    ...(planIsIntact(worktree, design) ? [] : ['The design folder or its plan was changed.']),
  ]
}

const IMPLEMENT_TIMEOUT_MS = 4 * 60 * 60 * 1000
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000
const AFTER_PUSH_TIMEOUT_MS = 30 * 60 * 1000
const AFTER_PUSH_OUTPUT_CAP = 64 * 1024 * 1024
const STOP_GRACE_MS = 5000
const schema = (name: string) => path.join(import.meta.dirname, '..', 'schemas', `${name}.json`)

const GREPTILE = 'greptile-apps'
const POLL_MS = 2 * 60 * 1000

export function botToken(login: string): string {
  let token: string
  try {
    token = execFileSync('gh', ['auth', 'token', '--user', login], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error(`gh is not signed in as ${login}. Run: gh auth login, sign in as ${login}, then gh auth switch to go back to your own account.`)
  }
  try {
    const authenticated = execFileSync('gh', ['api', 'user', '-q', '.login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GH_TOKEN: token } }).trim()
    if (authenticated.toLowerCase() === login.toLowerCase()) return token
  } catch {
    // reported below with the bot's configured login
  }
  throw new Error(`The saved token does not authenticate as ${login}. Sign in again as ${login} with gh auth login.`)
}

export function defaultBranch(repoId: string, login: string): string {
  try {
    const out = execFileSync('gh', ['repo', 'view', repoId, '--json', 'defaultBranchRef'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: botToken(login) } })
    const name = JSON.parse(out).defaultBranchRef?.name
    if (typeof name === 'string' && name) return name
  } catch {
    // reported below with the repo named
  }
  throw new Error(`Could not ask GitHub for the default branch of ${repoId}. Pass --base <branch>.`)
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const STATE_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  state headRefOid mergeable
  reviews(last:100){nodes{id databaseId author{login} state body commit{oid}}}
  comments(last:100){nodes{id databaseId author{login} body}}
  reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{id author{login} body}}}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}
}}}`

// A factory-owned checkout of the base branch as GitHub has it, so picking the next design never depends on the owner's checkout.
export function baseView(repo: string, worktreesDir: string, base: string): string {
  const view = path.join(worktreesDir, 'base')
  git(repo, 'fetch', 'origin', base)
  if (fs.existsSync(view)) git(view, 'checkout', '--detach', `origin/${base}`)
  else git(repo, 'worktree', 'add', '--detach', view, `origin/${base}`)
  return view
}

function scoreOf(body: string): number | null {
  const score = /Confidence Score: (\d)\/5/.exec(body)?.[1]
  return score === undefined ? null : Number(score)
}

// Runs the command in its own process group so that, when it is stopped, everything it started is stopped with it. Rejects with its last output when it fails.
export function runAfterPush(cwd: string, command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal)
      } catch {
        // the whole group has already exited
      }
    }
    let stopped: string | undefined
    const stop = (reason: string) => {
      if (stopped) return
      stopped = reason
      signalGroup('SIGTERM')
      setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS)
    }
    let interruptedBy: NodeJS.Signals | undefined
    // Its own group no longer gets the terminal's Ctrl-C, so stopping the build stops the group (SIGTERM, as background jobs ignore SIGINT), then stops the build as the signal would have.
    const interrupted = (signal: NodeJS.Signals) => {
      if (interruptedBy) return
      interruptedBy = signal
      stop(`it was stopped by ${signal}`)
      stopListening()
    }
    const stopListening = () => {
      process.off('SIGINT', interrupted)
      process.off('SIGTERM', interrupted)
    }
    process.on('SIGINT', interrupted)
    process.on('SIGTERM', interrupted)
    const timer = setTimeout(() => stop(`it ran past ${timeoutMs / 60_000} minutes and was stopped`), timeoutMs)
    const chunks: Buffer[] = []
    let size = 0
    const collect = (chunk: Buffer) => {
      size += chunk.length
      if (size > AFTER_PUSH_OUTPUT_CAP) stop('its output passed 64 MiB and it was stopped')
      else chunks.push(chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      stopListening()
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      stopListening()
      if (interruptedBy) return process.kill(process.pid, interruptedBy)
      if (code === 0 && !stopped) return resolve()
      const output = Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-20).join('\n')
      reject(new Error(`${stopped ?? (signal ? `it was stopped by ${signal}` : `exit ${code}`)}${output ? `\n${output}` : ''}`))
    })
  })
}

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

export function realWorkshop(repo: string, repoId: string, worktreesDir: string, runDir: string, settings: Settings): Workshop {
  const { owner, bot, greptile, models } = settings
  const botEnv = { GIT_AUTHOR_NAME: bot.name, GIT_AUTHOR_EMAIL: bot.email, GIT_COMMITTER_NAME: bot.name, GIT_COMMITTER_EMAIL: bot.email }
  const asBot = (cwd: string) => ({ cwd, encoding: 'utf8' as const, env: { ...process.env, GH_TOKEN: botToken(bot.login) } })
  const gh = (...args: string[]) => execFileSync('gh', args, asBot(process.cwd())).trim()
  const writer = (schemaName: string, cwd: string, prompt: string, step: string) =>
    runAgent({ vendor: 'claude', model: models.claude, prompt, schemaFile: schema(schemaName), cwd, runDir, step, canWrite: true, timeoutMs: IMPLEMENT_TIMEOUT_MS, env: botEnv })
  const reviewer = (schemaName: string, cwd: string, prompt: string, step: string) =>
    runAgent({ vendor: 'codex', model: models.codex, prompt, schemaFile: schema(schemaName), cwd, runDir, step, timeoutMs: REVIEW_TIMEOUT_MS })
  return {
    prepareWorktree(base, branch) {
      const worktree = path.join(worktreesDir, branch.replaceAll('/', '__'))
      if (fs.existsSync(worktree)) return worktree
      git(repo, 'fetch', 'origin', base)
      fs.mkdirSync(worktreesDir, { recursive: true })
      git(repo, 'worktree', 'add', '-b', branch, worktree, `origin/${base}`)
      return worktree
    },
    mergeBase(worktree, base) {
      git(worktree, 'fetch', 'origin', base)
      try {
        git(worktree, 'merge', '--no-edit', `origin/${base}`)
        return 'merged'
      } catch {
        if (git(worktree, 'diff', '--name-only', '--diff-filter=U') === '') throw new Error(`Could not merge origin/${base} into ${worktree}`)
        return 'conflicts'
      }
    },
    implement: (worktree, prompt, step) => writer('implementation', worktree, prompt, step) as Promise<Implementation>,
    breakIt: (worktree, prompt, step) => reviewer('gate-break', worktree, prompt, step) as Promise<{ findings: BreakFinding[] }>,
    auditExcess: (worktree, prompt, step) => reviewer('gate-excess', worktree, prompt, step) as Promise<{ findings: ExcessFinding[] }>,
    fix: (worktree, prompt, step) => writer('gate-fix', worktree, prompt, step) as Promise<FixWave>,
    head: (worktree) => git(worktree, 'rev-parse', 'HEAD'),
    linesChanged(worktree, since) {
      const rows = git(worktree, 'diff', '--numstat', `${since}..HEAD`).split('\n').filter(Boolean).map((row) => row.split('\t'))
      const sum = (column: number) => rows.reduce((total, row) => total + (Number(row[column]) || 0), 0)
      return { added: sum(0), deleted: sum(1) }
    },
    commitMessages: (worktree, base) => git(worktree, 'log', '--format=%B%x00', `origin/${base}..HEAD`).split('\0').map((message) => message.trim()).filter(Boolean),
    uncommittedFiles: (worktree) => git(worktree, 'status', '--porcelain').split('\n').filter(Boolean),
    markDesignBuilt(worktree, design) {
      if (!fs.existsSync(path.join(worktree, 'factory', 'ready', design))) return false
      fs.mkdirSync(path.join(worktree, 'factory', 'done'), { recursive: true })
      git(worktree, 'mv', `factory/ready/${design}`, `factory/done/${design}`)
      execFileSync('git', ['-C', worktree, 'commit', '-m', `chore: mark design ${design} as built`], { env: { ...process.env, ...botEnv } })
      return true
    },
    openPullRequest(worktree, branch, base, title, body) {
      const options = asBot(worktree)
      const gh = (...args: string[]) => execFileSync('gh', args, options).trim()
      this.push(worktree, branch)
      const existing = JSON.parse(gh('pr', 'list', '-R', repoId, '--head', branch, '--state', 'open', '--json', 'number,url'))[0] as PullRequest | undefined
      const url = existing?.url ?? gh('pr', 'create', '-R', repoId, '--head', branch, '--base', base, '--title', title, '--body', body)
      return { number: Number(url.split('/').pop()), url }
    },
    afterPush: async (worktree, command) => runAfterPush(worktree, command, asBot(worktree).env, AFTER_PUSH_TIMEOUT_MS),
    push(worktree, branch) {
      execFileSync('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', `https://github.com/${repoId}.git`, branch], asBot(worktree))
    },
    catchUp(worktree, branch, theirs) {
      git(worktree, 'fetch', 'origin', branch)
      if (git(worktree, 'rev-parse', `origin/${branch}`) !== theirs) return 'changed'
      const isAncestor = (older: string, newer: string) => spawnSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', older, newer]).status === 0
      if (isAncestor('HEAD', theirs)) {
        git(worktree, 'merge', '--ff-only', theirs)
        return 'fast-forwarded'
      }
      if (!isAncestor(theirs, 'HEAD')) {
        try {
          execFileSync('git', ['-C', worktree, 'merge', '--no-edit', theirs], { stdio: 'pipe', env: { ...process.env, ...botEnv } })
        } catch (error) {
          if (git(worktree, 'diff', '--name-only', '--diff-filter=U') === '') throw new Error(`Could not merge ${theirs} into ${worktree}: ${(error as Error).message}`)
          git(worktree, 'merge', '--abort')
          return 'conflicts'
        }
      }
      this.push(worktree, branch)
      return 'pushed'
    },
    pullRequestState(number) {
      const [repoOwner, name] = repoId.split('/')
      const pr = JSON.parse(gh('api', 'graphql', '-f', `query=${STATE_QUERY}`, '-f', `owner=${repoOwner}`, '-f', `name=${name}`, '-F', `number=${number}`)).data.repository.pullRequest
      const checks: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[] = pr.commits.nodes[0].commit.statusCheckRollup?.contexts.nodes ?? []
      const pending = checks.some((check) => (check.status ?? 'COMPLETED') !== 'COMPLETED' || ['PENDING', 'EXPECTED'].includes(check.state ?? ''))
      const failedChecks = checks
        .filter((check) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE', 'STALE'].includes(check.conclusion ?? check.state ?? ''))
        .map((check) => check.name ?? check.context ?? 'a check')
        .filter((check) => !greptile || !/greptile/i.test(check))
      const login = (node: { author: { login: string } | null }) => node.author?.login ?? ''
      const isOwner = (node: { author: { login: string } | null }) => sameLogin(login(node), owner)
      const verdict = pr.reviews.nodes.filter((review: any) => isOwner(review) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)).at(-1)
      const greptileComment = greptile ? pr.comments.nodes.filter((comment: any) => sameLogin(login(comment), GREPTILE)).at(-1) : null
      const threads: ReviewItem[] = pr.reviewThreads.nodes
        .filter((thread: any) => !thread.isResolved && !sameLogin(login(thread.comments.nodes.at(-1)), bot.login))
        .map((thread: any) => ({
          id: thread.id,
          kind: 'thread',
          latest: thread.comments.nodes.at(-1).id,
          fromOwner: thread.comments.nodes.some((comment: any) => isOwner(comment)),
          where: `${thread.path}${thread.line ? `:${thread.line}` : ''}`,
          text: thread.comments.nodes.map((comment: any) => `${login(comment)}: ${comment.body}`).join('\n\n'),
        }))
      const comments: ReviewItem[] = [...pr.comments.nodes, ...pr.reviews.nodes]
        .filter((comment: any) => isOwner(comment) && comment.body.trim() !== '')
        .map((comment: any) => ({ id: comment.id, kind: 'comment', latest: comment.id, fromOwner: true, text: comment.body }))
      return {
        state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
        head: pr.headRefOid,
        approved: verdict?.state === 'APPROVED' && verdict.commit?.oid === pr.headRefOid,
        conflicts: pr.mergeable === 'CONFLICTING',
        checks: pending ? 'pending' : failedChecks.length > 0 ? 'failed' : 'passed',
        failedChecks,
        greptile: greptile ? { score: greptileComment ? scoreOf(greptileComment.body) : null } : null,
        items: [...threads, ...comments],
      }
    },
    answerReview: (worktree, prompt, step) => writer('review-fix', worktree, prompt, step) as Promise<ReviewWave>,
    acknowledge: (item) => void gh('api', 'graphql', '-f', 'query=mutation($subject:ID!){addReaction(input:{subjectId:$subject,content:EYES}){reaction{id}}}', '-f', `subject=${item.latest}`),
    reply(number, item, body) {
      if (item.kind === 'comment') {
        gh('pr', 'comment', String(number), '-R', repoId, '--body', `> ${item.text.split('\n')[0]}\n\n${body}`)
        return
      }
      gh('api', 'graphql', '-f', 'query=mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}', '-f', `thread=${item.id}`, '-f', `body=${body}`)
    },
    resolve: (thread) => void gh('api', 'graphql', '-f', 'query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id}}}', '-f', `thread=${thread}`),
    requestReview: (number) => void gh('pr', 'comment', String(number), '-R', repoId, '--body', '@greptile review this'),
    merge: (number, head) => void gh('pr', 'merge', String(number), '-R', repoId, '--merge', '--match-head-commit', head),
    wait: () => new Promise((resolve) => setTimeout(resolve, POLL_MS)),
  }
}
