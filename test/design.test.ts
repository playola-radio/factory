import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readDesign } from '../lib/design.ts'

function repoWith(designText: string, screenshots = ['a--default.png']): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-design-'))
  const dir = path.join(repo, 'designs', 'ready', '001-example')
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  for (const name of screenshots) fs.writeFileSync(path.join(dir, 'screenshots', name), '')
  fs.writeFileSync(path.join(dir, 'Design.md'), designText)
  fs.writeFileSync(path.join(dir, 'ApiContract.md'), '# contract')
  return repo
}
const GOOD = '# 001\n\n![a](screenshots/a--default.png)\n\n## Done when\n\n- [ ] first outcome\n- [ ] second outcome\n'

test('reads the checklist, screenshots and optional files of a design', () => {
  assert.deepEqual(readDesign(repoWith(GOOD), '1'), {
    name: '001-example',
    dir: 'designs/ready/001-example',
    files: ['Design.md', 'ApiContract.md'],
    screenshots: ['a--default.png'],
    doneWhen: ['first outcome', 'second outcome'],
  })
})

test('refuses a design whose screenshot is never shown in Design.md', () => {
  assert.throws(() => readDesign(repoWith(GOOD, ['a--default.png', 'b--empty.png']), '001'), /never shows.*b--empty/)
})

test('refuses a design with no Done when checklist', () => {
  assert.throws(() => readDesign(repoWith('![a](screenshots/a--default.png)\n'), '001'), /Done when/)
})

test('refuses a number that matches no folder', () => {
  assert.throws(() => readDesign(repoWith(GOOD), '002'), /found 0/)
})
