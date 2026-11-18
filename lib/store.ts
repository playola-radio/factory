import fs from 'node:fs'
import path from 'node:path'

export interface Claim {
  repo: string
  design: string
  base: string
  startedAt: string
  startedFrom: string
}

export interface FactoryEvent {
  at: string
  repo: string
  design: string
  pr?: number
  type: 'design claimed' | 'design abandoned' | 'pr started' | 'pr implemented' | 'pr needs attention'
}

export interface Implementation {
  status: 'done' | 'blocked'
  summary: string
  checks: { command: string; passed: boolean }[]
  blockers: string[]
}

export interface PrReport {
  state: 'implemented' | 'needs attention'
  number: number
  attempts: number
  branch: string
  worktree: string
  commits: string[]
  problems: string[]
  implementation: Implementation
}

// The only place that knows where factory state lives, so it can move off this disk later.
export interface Store {
  claimFor(repo: string): Claim | null
  claim(claim: Claim): void
  release(repo: string): void
  prReport(repo: string, number: number): PrReport | null
  savePrReport(repo: string, report: PrReport): void
  record(event: FactoryEvent): void
}

export function diskStore(home: string): Store {
  const buildDir = (repo: string) => path.join(home, 'builds', repo.replaceAll('/', '__'))
  const claimFile = (repo: string) => path.join(buildDir(repo), 'claim.json')
  const prFile = (repo: string, number: number) => path.join(buildDir(repo), `pr-${number}.json`)
  return {
    claimFor(repo) {
      const file = claimFile(repo)
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    },
    claim(claim) {
      const file = claimFile(claim.repo)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        fs.writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        throw new Error(`${claim.repo} already has a design in progress: ${this.claimFor(claim.repo)?.design}`)
      }
    },
    release(repo) {
      fs.rmSync(buildDir(repo), { recursive: true, force: true })
    },
    prReport(repo, number) {
      const file = prFile(repo, number)
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    },
    savePrReport(repo, report) {
      fs.writeFileSync(prFile(repo, report.number), `${JSON.stringify(report, null, 2)}\n`)
    },
    record(event) {
      fs.mkdirSync(home, { recursive: true })
      fs.appendFileSync(path.join(home, 'events.jsonl'), `${JSON.stringify(event)}\n`)
    },
  }
}
