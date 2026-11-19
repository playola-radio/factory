import fs from 'node:fs'

import { checkSettings, DEFAULT_RE_REVIEW_BELOW, readSettingsFile, settingsFile } from './settings.ts'
import type { Settings } from './settings.ts'

export interface InitDeps {
  // Asks one question; an empty answer comes back as ''.
  ask(question: string): Promise<string>
  say(line: string): void
  // Runs gh and returns its trimmed output; throws when gh fails.
  gh(args: string[]): string
}

const shown = (fallback: string | undefined) => (fallback ? ` [${fallback}]` : '')

async function askWithDefault(deps: InitDeps, question: string, fallback?: string): Promise<string> {
  return (await deps.ask(`${question}${shown(fallback)}: `)).trim() || fallback || ''
}

function existingSettings(home: string): Settings | null {
  const file = settingsFile(home)
  const read = readSettingsFile(home)
  if (!read.found) return null
  const checked = 'error' in read ? { problems: [read.error] } : checkSettings(read.json)
  if ('problems' in checked) {
    throw new Error(
      `${file} exists but is not valid factory settings, so it was left alone:\n${checked.problems.map((problem) => `- ${problem}`).join('\n')}\n` +
        'Fix or move that file, or set FACTORY_HOME to use another folder.',
    )
  }
  return checked.settings
}

export async function runInit(home: string, deps: InitDeps): Promise<Settings> {
  const file = settingsFile(home)
  const before = existingSettings(home)
  deps.say(before ? `Updating ${file}. Press Enter to keep what is shown in brackets.` : `Writing ${file}.`)

  let signedIn = ''
  try {
    signedIn = deps.gh(['api', 'user', '-q', '.login'])
  } catch {
    // no default to offer
  }
  const owner = await askWithDefault(deps, 'Your GitHub login (the account whose approval merges a PR)', before?.owner || signedIn)

  const login = await askWithDefault(deps, 'The bot account\'s GitHub login (a second account that writes commits and opens PRs)', before?.bot.login)
  if (login.toLowerCase() === owner.toLowerCase()) {
    throw new Error('The bot account must be a different account from yours: GitHub does not let anyone approve their own PR. Nothing was written.')
  }
  try {
    deps.gh(['auth', 'token', '--user', login])
  } catch {
    throw new Error(
      `gh is not signed in as ${login}. Sign it in with:\n  gh auth login   (sign in as ${login})\n  gh auth switch  (go back to your own account)\nthen run "factory init" again. Nothing was written.`,
    )
  }
  const name = await askWithDefault(deps, 'Name for the bot\'s commits', before?.bot.login === login ? before.bot.name : login)
  let id: string
  try {
    id = deps.gh(['api', `users/${login}`, '-q', '.id'])
  } catch {
    throw new Error(`Could not look up ${login} on GitHub to work out its commit email. Nothing was written.`)
  }
  const email = `${id}+${login}@users.noreply.github.com`

  const usesGreptile = ((await askWithDefault(deps, 'Does Greptile review your repos? (y/n)', before ? (before.greptile ? 'y' : 'n') : 'n')).toLowerCase()).startsWith('y')
  let greptile: Settings['greptile'] = null
  if (usesGreptile) {
    const below = await askWithDefault(deps, 'Ask Greptile to review again when its last score is below (1-5)', String(before?.greptile?.reReviewBelow ?? DEFAULT_RE_REVIEW_BELOW))
    greptile = { reReviewBelow: Number(below) }
  }

  const models: Settings['models'] = {}
  for (const [vendor, label] of [['claude', 'Claude'], ['codex', 'Codex']] as const) {
    const answer = await askWithDefault(deps, `${label} model (blank for the CLI's default${before?.models[vendor] ? '; "-" to clear' : ''})`, before?.models[vendor])
    if (answer && answer !== '-') models[vendor] = answer
  }

  const json = { owner, bot: { login, name, email }, ...(greptile ? { greptile } : {}), ...(Object.keys(models).length > 0 ? { models } : {}) }
  const checked = checkSettings(json)
  if ('problems' in checked) {
    throw new Error(`These answers would not make valid settings, so nothing was written:\n${checked.problems.map((problem) => `- ${problem}`).join('\n')}`)
  }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  deps.say(`Wrote ${file}.`)
  return checked.settings
}
