import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { isObject, isText, unknownFields } from './settings.ts'

export interface AfterPush {
  command: string
  whenChanged?: string
}

export interface RepoRules {
  afterPush: AfterPush | null
  qaRules: string | null
}

export const NO_RULES: RepoRules = { afterPush: null, qaRules: null }

const CONFIG_FILE = 'factory/config.json'
const QA_RULES_FILE = 'factory/qa-rules.md'

export function checkRepoConfig(json: unknown): { config: { afterPush: AfterPush | null } } | { problems: string[] } {
  if (!isObject(json)) return { problems: ['the config must be a JSON object'] }
  const problems: string[] = []
  unknownFields(json, ['afterPush'], '', problems, 'field')
  if (json.afterPush === undefined) return problems.length > 0 ? { problems } : { config: { afterPush: null } }
  if (!isObject(json.afterPush)) return { problems: [...problems, 'afterPush must be an object with command and, optionally, whenChanged'] }

  const { command, whenChanged } = json.afterPush
  unknownFields(json.afterPush, ['command', 'whenChanged'], 'afterPush.', problems, 'field')
  if (command === undefined) problems.push('afterPush.command is missing: the shell command run in the PR\'s worktree once the PR is open')
  else if (!isText(command)) problems.push('afterPush.command must be a non-empty string: the shell command run in the PR\'s worktree')
  if (whenChanged !== undefined) {
    if (!isText(whenChanged)) problems.push('afterPush.whenChanged must be a non-empty string: a glob of files in the worktree')
    else if (path.isAbsolute(whenChanged) || whenChanged.split(/[\\/]/).includes('..')) {
      problems.push(`afterPush.whenChanged must be a path inside the repo, relative to its root, not ${whenChanged}`)
    }
  }
  if (problems.length > 0) return { problems }
  return { config: { afterPush: { command: command as string, ...(whenChanged === undefined ? {} : { whenChanged: whenChanged as string }) } } }
}

// Reads the repo's rules from the factory's checkout of the base, never from a PR's worktree, so a PR cannot change the rules it is held to.
export function readRepoRules(view: string, base: string): RepoRules {
  const configFile = path.join(view, CONFIG_FILE)
  let afterPush: AfterPush | null = null
  if (fs.existsSync(configFile)) {
    let json: unknown
    try {
      json = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    } catch (error) {
      throw new Error(`${CONFIG_FILE} on ${base} is not valid JSON: ${(error as Error).message}`)
    }
    const checked = checkRepoConfig(json)
    if ('problems' in checked) throw new Error(checked.problems.map((problem) => `${CONFIG_FILE} on ${base}: ${problem}`).join('\n'))
    afterPush = checked.config.afterPush
  }
  const qaFile = path.join(view, QA_RULES_FILE)
  const qaRules = fs.existsSync(qaFile) ? fs.readFileSync(qaFile, 'utf8').trim() : ''
  return { afterPush, qaRules: qaRules || null }
}

// A hash of the relative path and contents of every file the glob matches, in sorted order; null when nothing matches.
export function fingerprint(worktree: string, glob: string): string | null {
  const files = fs.globSync(glob, { cwd: worktree }).filter((file) => fs.statSync(path.join(worktree, file)).isFile()).sort()
  if (files.length === 0) return null
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(worktree, file))).update('\0')
  return hash.digest('hex')
}
