import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { runAgent } from './agents.ts'
import type { Workshop } from './implement.ts'
import type { Implementation } from './store.ts'

const IMPLEMENT_TIMEOUT_MS = 4 * 60 * 60 * 1000
const SCHEMA = path.join(import.meta.dirname, '..', 'schemas', 'implementation.json')

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

export function realWorkshop(repo: string, worktreesDir: string, runDir: string, model: string): Workshop {
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
    implement: (worktree, prompt, step) =>
      runAgent({ vendor: 'claude', model, prompt, schemaFile: SCHEMA, cwd: worktree, runDir, step, canWrite: true, timeoutMs: IMPLEMENT_TIMEOUT_MS }) as Promise<Implementation>,
    commitMessages: (worktree, base) => git(worktree, 'log', '--format=%B%x00', `origin/${base}..HEAD`).split('\0').map((message) => message.trim()).filter(Boolean),
    uncommittedFiles: (worktree) => git(worktree, 'status', '--porcelain').split('\n').filter(Boolean),
  }
}
