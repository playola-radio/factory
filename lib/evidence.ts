import fs from 'node:fs'
import path from 'node:path'

import type { EvidenceFile, PublishedEvidence } from './store.ts'

// Posts one PR comment with every file attached (`gh pr comment --attach`), returning the comment's address and its
// body as GitHub stored it, where each local file reference has been rewritten to the address GitHub hosts it at.
export type EvidencePost = (body: string, attachments: string[]) => { url: string; body: string }

const MANIFEST = 'evidence.json'
const KINDS = ['functional', 'visual']
const HOSTED = /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[\w.-]+/g

// Where an implementer working with `TMPDIR` set to `scratch` saves its recordings and their manifest.
export const evidenceDir = (scratch: string) => path.join(scratch, 'evidence')

// The manifest's text plus each listed file's modification time, so it changes whenever evidence is recorded again.
export function evidenceStampOf(dir: string): string {
  const manifest = path.join(dir, MANIFEST)
  if (!fs.existsSync(manifest)) return ''
  let times: number[] = []
  try {
    times = readManifest(dir).map(({ file }) => fs.statSync(path.join(dir, file)).mtimeMs)
  } catch {
    // An invalid manifest is stamped by its text alone; publishing it reports what is wrong.
  }
  return [fs.readFileSync(manifest, 'utf8'), ...times].join('\n')
}

function readManifest(dir: string): EvidenceFile[] {
  const manifest = path.join(dir, MANIFEST)
  if (!fs.existsSync(manifest)) return []
  let files: unknown
  try {
    files = JSON.parse(fs.readFileSync(manifest, 'utf8')).files
  } catch (error) {
    throw new Error(`${manifest} is not valid JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(files)) throw new Error(`${manifest} must hold a "files" list.`)
  return files.map((entry: EvidenceFile) => {
    if (typeof entry?.file !== 'string' || typeof entry.caption !== 'string' || !KINDS.includes(entry.kind)) {
      throw new Error(`${manifest} has an entry without a file, a caption, and a kind of ${KINDS.join(' or ')}: ${JSON.stringify(entry)}`)
    }
    // Anything else (a space, a bracket) breaks the Markdown link GitHub rewrites, which would misplace hosted addresses.
    if (!/^[\w./-]+$/.test(entry.file)) throw new Error(`${manifest} names ${JSON.stringify(entry.file)}; use only letters, digits, dots, dashes and underscores.`)
    const full = path.resolve(dir, entry.file)
    if (!fs.existsSync(full)) throw new Error(`${manifest} names ${entry.file}, which is not in ${dir}.`)
    // Resolved through symlinks, so a link to a private file elsewhere on the machine is never uploaded.
    if (!fs.realpathSync(full).startsWith(fs.realpathSync(dir) + path.sep)) throw new Error(`${manifest} names ${entry.file}, which is outside ${dir}.`)
    return { file: entry.file, kind: entry.kind, caption: entry.caption }
  })
}

const isVideo = (file: string) => /\.(mp4|mov|webm)$/i.test(file)

function comment(files: EvidenceFile[]): string {
  const blocks = files.map(({ file, kind, caption }) => `**${caption}** (${kind})\n\n![${isVideo(file) ? '' : caption}](./${file})`)
  return ['## Demo evidence', ...blocks].join('\n\n')
}

// Posts the evidence an implementer listed in `<dir>/evidence.json` to the PR and returns where GitHub hosts each
// file. Null when there is no manifest or it lists nothing, so a PR without UX evidence is never held up.
export function publishEvidenceFiles(dir: string, post: EvidencePost): PublishedEvidence | null {
  const files = readManifest(dir)
  if (files.length === 0) return null
  const posted = post(comment(files), files.map(({ file }) => path.join(dir, file)))
  const urls = posted.body.match(HOSTED) ?? []
  if (urls.length !== files.length) {
    throw new Error(`GitHub hosted ${urls.length} of the ${files.length} evidence files posted in ${posted.url}.`)
  }
  return { comment: posted.url, files: files.map((file, index) => ({ ...file, url: urls[index] })) }
}
