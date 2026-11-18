import fs from 'node:fs'
import path from 'node:path'
import type { Design } from './types.ts'

const PROMPTS_DIR = path.join(import.meta.dirname, '..', 'prompts')

export function renderPrompt(name: string, values: Record<string, string>): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8')
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Prompt ${name} needs a value for ${key}`)
    return values[key]
  })
}

export function designValues(design: Design): Record<string, string> {
  return {
    design_dir: design.dir,
    design_files: design.files.map((file) => `\`${file}\``).join(', '),
  }
}
