import fs from 'node:fs'
import path from 'node:path'
import type { Design } from './types.ts'

const OPTIONAL_FILES = ['ApiContract.md', 'ModelChanges.md']

// A design sits in factory/ready until the last PR built from it moves it to factory/done.
function findDesignFolder(repo: string, number: string): string {
  const prefix = `${number.padStart(3, '0')}-`
  const matches = ['ready', 'done'].flatMap((state) => {
    const dir = path.join(repo, 'factory', state)
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).map((name) => path.join('factory', state, name)) : []
  })
  if (matches.length !== 1) {
    throw new Error(`Expected one factory/ready/${prefix}* folder in ${repo}, found ${matches.length}: ${matches.join(', ')}`)
  }
  return matches[0]
}

function doneWhenItems(designText: string): string[] {
  const section = designText.split(/^## Done when\s*$/m)[1]
  if (!section) return []
  return section
    .split(/^## /m)[0]
    .split('\n')
    .map((line) => line.match(/^- \[[ x]\] (.+)$/))
    .filter((match) => match !== null)
    .map((match) => match[1].trim())
}

function linkedImages(designText: string): string[] {
  return [...designText.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
}

export function readDesign(repo: string, number: string): Design {
  const dir = findDesignFolder(repo, number)
  const absolute = path.join(repo, dir)
  const designFile = path.join(absolute, 'Design.md')
  if (!fs.existsSync(designFile)) throw new Error(`${dir} has no Design.md`)
  const designText = fs.readFileSync(designFile, 'utf8')

  const screenshotsDir = path.join(absolute, 'screenshots')
  const screenshots = fs.existsSync(screenshotsDir)
    ? fs.readdirSync(screenshotsDir).filter((name) => name.endsWith('.png')).sort()
    : []
  if (screenshots.length === 0) throw new Error(`${dir}/screenshots has no PNG files`)

  const linked = linkedImages(designText)
  const broken = linked.filter((link) => !fs.existsSync(path.join(absolute, link)))
  if (broken.length > 0) throw new Error(`${dir}/Design.md links to missing images: ${broken.join(', ')}`)
  const undescribed = screenshots.filter((name) => !linked.includes(`screenshots/${name}`))
  if (undescribed.length > 0) throw new Error(`${dir}/Design.md never shows these screenshots: ${undescribed.join(', ')}`)

  const doneWhen = doneWhenItems(designText)
  if (doneWhen.length === 0) throw new Error(`${dir}/Design.md has no "## Done when" checklist`)

  return {
    name: path.basename(dir),
    dir,
    files: ['Design.md', ...OPTIONAL_FILES.filter((file) => fs.existsSync(path.join(absolute, file)))],
    screenshots,
    doneWhen,
  }
}
