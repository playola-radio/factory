import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
const gitOk = (dir: string, ...args: string[]) => {
  try {
    git(dir, ...args)
    return true
  } catch {
    return false
  }
}

// The factory-owned scratch folder for one PR's agents, kept beside the worktree under the factory home but never
// inside it, so build output there never shows up as uncommitted changes and can be deleted with the worktree.
export function scratchDir(worktreesDir: string, worktree: string): string {
  return path.join(worktreesDir, '.scratch', path.basename(worktree))
}

// True when the branch has commits that are not on its pushed remote branch, so removing it would lose work. Checked
// from the main repo rather than the worktree, so it is still correct when the worktree folder was deleted by hand
// (git keeps the branch ref) — otherwise a missing folder would let `git branch -D` destroy unpushed commits.
function hasUnpushedCommits(repo: string, branch: string, base: string): boolean {
  if (!gitOk(repo, 'rev-parse', '--verify', `refs/heads/${branch}`)) return false
  const head = git(repo, 'rev-parse', `refs/heads/${branch}`)
  // Compare against the branch's own remote tip. When it was never pushed (or was deleted on merge), fall back to the
  // freshly fetched base: a merged branch's HEAD is an ancestor of base, while unmerged, unpushed commits are not.
  let against: string
  if (gitOk(repo, 'fetch', 'origin', branch)) {
    against = git(repo, 'rev-parse', 'FETCH_HEAD')
  } else {
    gitOk(repo, 'fetch', 'origin', base)
    against = `origin/${base}`
  }
  return !gitOk(repo, 'merge-base', '--is-ancestor', head, against)
}

// Removes one PR's worktree, its local branch, and its scratch folder. Leaves everything in place and returns false
// when the branch still has commits that are not on its remote; otherwise force-removes it (clearing build junk) and
// returns true.
export function removeWorktree(repo: string, worktreesDir: string, worktree: string, branch: string, base: string): boolean {
  if (hasUnpushedCommits(repo, branch, base)) return false
  if (fs.existsSync(worktree)) git(repo, 'worktree', 'remove', '--force', worktree)
  else gitOk(repo, 'worktree', 'prune')
  gitOk(repo, 'branch', '-D', branch)
  fs.rmSync(scratchDir(worktreesDir, worktree), { recursive: true, force: true })
  return true
}

interface WorktreeEntry {
  worktree: string
  branch: string
}

function listWorktrees(repo: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current = ''
  for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (line.startsWith('branch ')) entries.push({ worktree: current, branch: line.slice('branch refs/heads/'.length) })
  }
  return entries
}

// Removes every worktree of a design when it is abandoned, keeping any that still hold unpushed commits.
export function removeDesignWorktrees(repo: string, worktreesDir: string, design: string, base: string): { removed: string[]; kept: string[] } {
  const prefix = `factory/${design}/`
  // Git lists worktrees by their canonical path, so match against the canonical worktrees dir and require a real
  // directory boundary (not a bare string prefix, which would also match a sibling like `<dir>-backup`). Don't
  // realpath the worktree itself — the folder may have been deleted by hand, and git still lists its branch.
  const home = fs.existsSync(worktreesDir) ? fs.realpathSync(worktreesDir) : worktreesDir
  const removed: string[] = []
  const kept: string[] = []
  for (const { worktree, branch } of listWorktrees(repo)) {
    if (!branch.startsWith(prefix) || !worktree.startsWith(home + path.sep)) continue
    ;(removeWorktree(repo, worktreesDir, worktree, branch, base) ? removed : kept).push(branch)
  }
  return { removed, kept }
}
