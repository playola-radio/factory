import fs from 'node:fs'
import path from 'node:path'

export interface Settings {
  owner: string
  bot: { login: string; name: string; email: string }
  greptile: { reReviewBelow: number } | null
  models: { claude?: string; codex?: string }
}

export const DEFAULT_RE_REVIEW_BELOW = 4

const FIX_HINT = 'Run "factory init" to fix it.'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

function unknownFields(value: Json, known: string[], prefix: string, problems: string[]) {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue
    const close = known.find((name) => name.toLowerCase() === key.toLowerCase())
    problems.push(`${prefix}${key} is not a setting${close ? ` (did you mean ${prefix}${close}?)` : ''}`)
  }
}

function text(value: Json, key: string, prefix: string, meaning: string, problems: string[]): string {
  if (value[key] === undefined) problems.push(`${prefix}${key} is missing: ${meaning}`)
  else if (!isText(value[key])) problems.push(`${prefix}${key} must be a non-empty string: ${meaning}`)
  else return value[key]
  return ''
}

export function checkSettings(json: unknown): { settings: Settings } | { problems: string[] } {
  if (!isObject(json)) return { problems: ['the settings must be a JSON object'] }
  const problems: string[] = []
  unknownFields(json, ['owner', 'bot', 'greptile', 'models'], '', problems)

  const owner = text(json, 'owner', '', 'the GitHub login whose approval merges a PR', problems)

  let bot = { login: '', name: '', email: '' }
  if (json.bot === undefined) problems.push('bot is missing: the GitHub account that writes commits, opens PRs and replies')
  else if (!isObject(json.bot)) problems.push('bot must be an object with login, name and email')
  else {
    unknownFields(json.bot, ['login', 'name', 'email'], 'bot.', problems)
    bot = {
      login: text(json.bot, 'login', 'bot.', 'the GitHub login of the bot account, signed in to gh', problems),
      name: text(json.bot, 'name', 'bot.', "the git author name for the bot's commits", problems),
      email: text(json.bot, 'email', 'bot.', "the git author email for the bot's commits", problems),
    }
  }
  if (owner && bot.login && owner.toLowerCase() === bot.login.toLowerCase()) {
    problems.push('bot.login must not be the owner: GitHub does not let anyone approve their own PR')
  }

  let greptile: Settings['greptile'] = null
  if (json.greptile !== undefined) {
    if (!isObject(json.greptile)) problems.push('greptile must be an object (use {} for the defaults)')
    else {
      unknownFields(json.greptile, ['reReviewBelow'], 'greptile.', problems)
      const below = json.greptile.reReviewBelow === undefined ? DEFAULT_RE_REVIEW_BELOW : json.greptile.reReviewBelow
      if (typeof below !== 'number' || !Number.isInteger(below) || below < 1 || below > 5) {
        problems.push('greptile.reReviewBelow must be a whole number from 1 to 5: ask Greptile to review again when its last score was below it')
      } else greptile = { reReviewBelow: below }
    }
  }

  const models: Settings['models'] = {}
  if (json.models !== undefined) {
    if (!isObject(json.models)) problems.push('models must be an object with claude and/or codex')
    else {
      unknownFields(json.models, ['claude', 'codex'], 'models.', problems)
      for (const vendor of ['claude', 'codex'] as const) {
        const model = json.models[vendor]
        if (model === undefined) continue
        if (!isText(model)) problems.push(`models.${vendor} must be a non-empty string: the model passed to the ${vendor} CLI`)
        else models[vendor] = model
      }
    }
  }

  return problems.length > 0 ? { problems } : { settings: { owner, bot, greptile, models } }
}

export const settingsFile = (home: string) => path.join(home, 'settings.json')

export function readSettingsFile(home: string): { found: false } | { found: true; json: unknown } | { found: true; error: string } {
  const file = settingsFile(home)
  if (!fs.existsSync(file)) return { found: false }
  try {
    return { found: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { found: true, error: `${file} is not valid JSON: ${(error as Error).message}` }
  }
}

export function loadSettings(home: string): Settings {
  const file = settingsFile(home)
  const read = readSettingsFile(home)
  if (!read.found) throw new Error(`${file} does not exist. ${FIX_HINT}`)
  if ('error' in read) throw new Error(`${read.error}. ${FIX_HINT}`)
  const checked = checkSettings(read.json)
  if ('problems' in checked) throw new Error(`${file} has problems:\n${checked.problems.map((problem) => `- ${problem}`).join('\n')}\n${FIX_HINT}`)
  return checked.settings
}
