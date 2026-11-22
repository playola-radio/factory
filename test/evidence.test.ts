import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { evidenceDir, evidenceStampOf, publishEvidenceFiles } from '../lib/evidence.ts'
import type { EvidencePost } from '../lib/evidence.ts'

const COMMENT_URL = 'https://github.com/owner/app/pull/7#issuecomment-99'

function scratch(manifest?: unknown, files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-evidence-'))
  fs.mkdirSync(path.join(dir, 'shots'))
  for (const file of files) fs.writeFileSync(path.join(dir, file), 'media')
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'evidence.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return dir
}

// Stands in for `gh pr comment --attach`: GitHub rewrites each local reference in the body to its hosted address.
function fakeGitHub() {
  const posts: { body: string; attachments: string[] }[] = []
  const post: EvidencePost = (body, attachments) => {
    posts.push({ body, attachments })
    let n = 0
    return { url: COMMENT_URL, body: body.replace(/\]\(\.\/[^)]+\)/g, () => `](https://github.com/user-attachments/assets/a${++n})`) }
  }
  return { posts, post }
}

const MANIFEST = {
  files: [
    { file: 'demo.mp4', kind: 'functional', caption: 'Saving a new show from start to finish' },
    { file: 'shots/empty.png', kind: 'visual', caption: 'The empty schedule' },
  ],
}

test('the canonical evidence folder is evidence/ inside the scratch folder', () => {
  assert.equal(evidenceDir('/scratch/pr-1'), path.join('/scratch/pr-1', 'evidence'))
})

test('with no evidence folder at all nothing is posted', () => {
  const github = fakeGitHub()
  assert.equal(publishEvidenceFiles(path.join(os.tmpdir(), 'factory-evidence-missing', 'evidence'), github.post), null)
  assert.equal(github.posts.length, 0)
})

test('a manifest that lists no files posts nothing', () => {
  const github = fakeGitHub()
  assert.equal(publishEvidenceFiles(scratch({ files: [] }), github.post), null)
  assert.equal(github.posts.length, 0)
})

test('every file in the manifest is attached to one comment, captioned in manifest order, and returned with its hosted address', () => {
  const github = fakeGitHub()
  const dir = scratch(MANIFEST, ['demo.mp4', 'shots/empty.png'])
  const published = publishEvidenceFiles(dir, github.post)
  assert.equal(github.posts.length, 1)
  const [{ body, attachments }] = github.posts
  assert.deepEqual(attachments, [path.join(dir, 'demo.mp4'), path.join(dir, 'shots/empty.png')])
  assert.match(body, /Saving a new show from start to finish[\s\S]*!\[\]\(\.\/demo\.mp4\)[\s\S]*The empty schedule[\s\S]*!\[The empty schedule\]\(\.\/shots\/empty\.png\)/)
  assert.deepEqual(published, {
    comment: COMMENT_URL,
    files: [
      { ...MANIFEST.files[0], url: 'https://github.com/user-attachments/assets/a1' },
      { ...MANIFEST.files[1], url: 'https://github.com/user-attachments/assets/a2' },
    ],
  })
})

test('a manifest naming a file that was never recorded fails before posting', () => {
  const github = fakeGitHub()
  assert.throws(() => publishEvidenceFiles(scratch(MANIFEST, ['demo.mp4']), github.post), /shots\/empty\.png/)
  assert.equal(github.posts.length, 0)
})

test('a manifest naming a file outside the evidence folder, directly or through a link, fails before posting', () => {
  const github = fakeGitHub()
  const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-secret-')), 'secret.png')
  fs.writeFileSync(secret, 'private')
  const dir = scratch({ files: [{ file: `../${path.basename(path.dirname(secret))}/secret.png`, kind: 'visual', caption: 'x' }] })
  assert.throws(() => publishEvidenceFiles(dir, github.post), /outside/)
  const linked = scratch({ files: [{ file: 'secret.png', kind: 'visual', caption: 'x' }] })
  fs.symlinkSync(secret, path.join(linked, 'secret.png'))
  assert.throws(() => publishEvidenceFiles(linked, github.post), /outside/)
  assert.equal(github.posts.length, 0)
})

test('a file name that would break its Markdown link fails before posting', () => {
  const github = fakeGitHub()
  const manifest = { files: [{ file: 'Save dialog.png', kind: 'visual', caption: 'x' }] }
  assert.throws(() => publishEvidenceFiles(scratch(manifest, ['Save dialog.png']), github.post), /Save dialog\.png/)
  assert.equal(github.posts.length, 0)
})

test('a manifest that is not valid fails with its path', () => {
  const github = fakeGitHub()
  assert.throws(() => publishEvidenceFiles(scratch('{ nope'), github.post), /evidence\.json/)
  assert.throws(() => publishEvidenceFiles(scratch({ files: [{ file: 'demo.mp4', kind: 'movie', caption: 'x' }] }, ['demo.mp4']), github.post), /kind/)
})

test('GitHub not hosting every attachment is reported instead of storing wrong addresses', () => {
  const post: EvidencePost = () => ({ url: COMMENT_URL, body: 'nothing rewritten' })
  assert.throws(() => publishEvidenceFiles(scratch(MANIFEST, ['demo.mp4', 'shots/empty.png']), post), /issuecomment-99/)
})

test('the evidence stamp is empty with no manifest and changes when a file is recorded again', () => {
  assert.equal(evidenceStampOf(scratch()), '')
  const dir = scratch(MANIFEST, ['demo.mp4', 'shots/empty.png'])
  const before = evidenceStampOf(dir)
  fs.utimesSync(path.join(dir, 'demo.mp4'), new Date(), new Date(Date.now() + 60_000))
  assert.notEqual(evidenceStampOf(dir), before)
})
