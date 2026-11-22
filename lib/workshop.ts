import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_MODEL, runAgent } from './agents.ts'
import { removeWorktree, scratchDir } from './cleanup.ts'
import { readDesign } from './design.ts'
import { reasonsNotBuildable } from './readiness.ts'
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

export interface MergedPullRequest extends PullRequest {
  title: string
}

export interface PullRequestState {
  state: 'open' | 'merged' | 'closed'
  head: string
  approved: boolean
  conflicts: boolean
  checks: 'pending' | 'passed' | 'failed'
  failedChecks: string[]
  greptileScore: number | null
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
  // Whether the design still sits in factory/ready on the base, so its move to factory/done is still owed. A design
  // whose PRs are all merged but that is still in factory/ready was never moved by a last-PR build and needs the owner.
  designAwaitingDone(design: string): boolean
  openPullRequest(worktree: string, branch: string, base: string, title: string, body: string): PullRequest
  // The pull request GitHub still shows as merged into `base` from this head branch, or null. Found even after the
  // branch is deleted on merge (GitHub keeps the PR by its head ref), so an already-merged PR is recognised when the
  // local store has lost track of it. Carries the title so the caller can tell whether it is still the planned work.
  mergedPullRequest(branch: string, base: string): MergedPullRequest | null
  // Changes whenever evidence is recorded again.
  evidenceStamp(worktree: string): string
  publishEvidence(worktree: string, number: number): void
  pullRequestState(number: number): PullRequestState
  answerReview(worktree: string, prompt: string, step: string): Promise<ReviewWave>
  push(worktree: string, branch: string): void
  // Marks a comment as seen with an eyes reaction.
  acknowledge(item: ReviewItem): void
  reply(number: number, item: ReviewItem, body: string, resolve: boolean): void
  requestReview(number: number): void
  merge(number: number, head: string): void
  // Removes a merged PR's worktree, local branch, and scratch folder; leaves it if it still has unpushed commits.
  discardWorktree(worktree: string, branch: string, base: string): void
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
const schema = (name: string) => path.join(import.meta.dirname, '..', 'schemas', `${name}.json`)

// The account that authors the factory's commits and opens its PRs, so the owner can review and approve them.
const AUTHOR = { login: 'marge-watson', name: 'Marge', email: '263082108+marge-watson@users.noreply.github.com' }
// The only account whose approval lets a PR merge.
const OWNER = 'briankeane'
const GREPTILE = 'greptile-apps'
const POLL_MS = 2 * 60 * 1000
const AUTHOR_ENV = { GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email }

function authorToken(): string {
  try {
    return execFileSync('gh', ['auth', 'token', '--user', AUTHOR.login], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error(`gh is not signed in as ${AUTHOR.login}. Run: gh auth login, sign in as ${AUTHOR.login}, then gh auth switch to go back to your own account.`)
  }
}

const asAuthor = (cwd: string) => ({ cwd, encoding: 'utf8' as const, env: { ...process.env, GH_TOKEN: authorToken() } })
const gh = (...args: string[]) => execFileSync('gh', args, asAuthor(process.cwd())).trim()

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

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

export function realWorkshop(repo: string, repoId: string, worktreesDir: string, runDir: string, model: string): Workshop {
  const writer = (schemaName: string, cwd: string, prompt: string, step: string) => {
    const tmpdir = scratchDir(worktreesDir, cwd)
    fs.mkdirSync(tmpdir, { recursive: true })
    return runAgent({ vendor: 'claude', model, prompt, schemaFile: schema(schemaName), cwd, runDir, step, canWrite: true, timeoutMs: IMPLEMENT_TIMEOUT_MS, env: { ...AUTHOR_ENV, TMPDIR: tmpdir } })
  }
  const reviewer = (schemaName: string, cwd: string, prompt: string, step: string) =>
    runAgent({ vendor: 'codex', model: DEFAULT_MODEL.codex, prompt, schemaFile: schema(schemaName), cwd, runDir, step, timeoutMs: REVIEW_TIMEOUT_MS })
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
      execFileSync('git', ['-C', worktree, 'commit', '-m', `chore: mark design ${design} as built`], { env: { ...process.env, ...AUTHOR_ENV } })
      return true
    },
    // baseView keeps worktreesDir/base checked out to origin/base, so this reflects whether base still holds the design in ready.
    designAwaitingDone: (design) => fs.existsSync(path.join(worktreesDir, 'base', 'factory', 'ready', design)),
    openPullRequest(worktree, branch, base, title, body) {
      const options = asAuthor(worktree)
      const gh = (...args: string[]) => execFileSync('gh', args, options).trim()
      this.push(worktree, branch)
      const existing = JSON.parse(gh('pr', 'list', '-R', repoId, '--head', branch, '--state', 'open', '--json', 'number,url'))[0] as PullRequest | undefined
      const url = existing?.url ?? gh('pr', 'create', '-R', repoId, '--head', branch, '--base', base, '--title', title, '--body', body)
      const pullRequest = { number: Number(url.split('/').pop()), url }
      this.publishEvidence(worktree, pullRequest.number)
      return pullRequest
    },
    mergedPullRequest(branch, base) {
      const rows = JSON.parse(gh('pr', 'list', '-R', repoId, '--head', branch, '--base', base, '--state', 'merged', '--json', 'number,url,title')) as MergedPullRequest[]
      return rows[0] ?? null
    },
    evidenceStamp(worktree) {
      const artifacts = path.join(worktree, '.qa-artifacts')
      if (!fs.existsSync(artifacts)) return ''
      return fs.readdirSync(artifacts).sort().map((id) => path.join(artifacts, id, 'result.json')).filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    },
    publishEvidence(worktree, number) {
      const makefile = path.join(worktree, 'Makefile')
      if (!fs.existsSync(makefile) || !/^ux-evidence-publish:/m.test(fs.readFileSync(makefile, 'utf8'))) return
      execFileSync('make', ['ux-evidence-publish', `PR=${number}`], asAuthor(worktree))
    },
    push(worktree, branch) {
      execFileSync('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', `https://github.com/${repoId}.git`, branch], asAuthor(worktree))
    },
    pullRequestState(number) {
      const [owner, name] = repoId.split('/')
      const pr = JSON.parse(gh('api', 'graphql', '-f', `query=${STATE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`)).data.repository.pullRequest
      const checks: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[] = pr.commits.nodes[0].commit.statusCheckRollup?.contexts.nodes ?? []
      const pending = checks.some((check) => (check.status ?? 'COMPLETED') !== 'COMPLETED' || ['PENDING', 'EXPECTED'].includes(check.state ?? ''))
      const failedChecks = checks
        .filter((check) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE', 'STALE'].includes(check.conclusion ?? check.state ?? ''))
        .map((check) => check.name ?? check.context ?? 'a check')
        .filter((check) => !/greptile/i.test(check))
      const login = (node: { author: { login: string } | null }) => node.author?.login ?? ''
      const verdict = pr.reviews.nodes.filter((review: any) => login(review) === OWNER && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)).at(-1)
      const greptile = pr.comments.nodes.filter((comment: any) => login(comment) === GREPTILE).at(-1)
      const threads: ReviewItem[] = pr.reviewThreads.nodes
        .filter((thread: any) => !thread.isResolved && login(thread.comments.nodes.at(-1)) !== AUTHOR.login)
        .map((thread: any) => ({
          id: thread.id,
          kind: 'thread',
          latest: thread.comments.nodes.at(-1).id,
          fromOwner: thread.comments.nodes.some((comment: any) => login(comment) === OWNER),
          where: `${thread.path}${thread.line ? `:${thread.line}` : ''}`,
          text: thread.comments.nodes.map((comment: any) => `${login(comment)}: ${comment.body}`).join('\n\n'),
        }))
      const comments: ReviewItem[] = [...pr.comments.nodes, ...pr.reviews.nodes]
        .filter((comment: any) => login(comment) === OWNER && comment.body.trim() !== '')
        .map((comment: any) => ({ id: comment.id, kind: 'comment', latest: comment.id, fromOwner: true, text: comment.body }))
      return {
        state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
        head: pr.headRefOid,
        approved: verdict?.state === 'APPROVED' && verdict.commit?.oid === pr.headRefOid,
        conflicts: pr.mergeable === 'CONFLICTING',
        checks: pending ? 'pending' : failedChecks.length > 0 ? 'failed' : 'passed',
        failedChecks,
        greptileScore: greptile ? Number(/Confidence Score: (\d)\/5/.exec(greptile.body)?.[1] ?? NaN) : null,
        items: [...threads, ...comments],
      }
    },
    answerReview: (worktree, prompt, step) => writer('review-fix', worktree, prompt, step) as Promise<ReviewWave>,
    acknowledge: (item) => void gh('api', 'graphql', '-f', 'query=mutation($subject:ID!){addReaction(input:{subjectId:$subject,content:EYES}){reaction{id}}}', '-f', `subject=${item.latest}`),
    reply(number, item, body, resolve) {
      if (item.kind === 'comment') {
        gh('pr', 'comment', String(number), '-R', repoId, '--body', `> ${item.text.split('\n')[0]}\n\n${body}`)
        return
      }
      gh('api', 'graphql', '-f', 'query=mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}', '-f', `thread=${item.id}`, '-f', `body=${body}`)
      if (resolve) gh('api', 'graphql', '-f', 'query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id}}}', '-f', `thread=${item.id}`)
    },
    requestReview: (number) => void gh('pr', 'comment', String(number), '-R', repoId, '--body', '@greptile review this'),
    merge: (number, head) => void gh('pr', 'merge', String(number), '-R', repoId, '--merge', '--match-head-commit', head),
    discardWorktree: (worktree, branch, base) => void removeWorktree(repo, worktreesDir, worktree, branch, base, true),
    wait: () => new Promise((resolve) => setTimeout(resolve, POLL_MS)),
  }
}
