export type Vendor = 'claude' | 'outside'

export interface Design {
  name: string
  dir: string
  files: string[]
  screenshots: string[]
  doneWhen: string[]
}

export interface PlannedPr {
  number: number
  title: string
  goal: string
  changes: string[]
  tests: string[]
  dependsOn: number[]
  screenshots: string[]
  doneWhen: number[]
  hard: boolean
}

export interface Finding {
  severity: 'P1' | 'P2' | 'P3'
  where: string
  problem: string
  fix: string
}

export interface PlanContent {
  summary: string
  prs: PlannedPr[]
}

export interface Review {
  findings: Finding[]
}
