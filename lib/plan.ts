import type { ApprovedPlan, Design } from './types.ts'

const TITLE_PREFIX = /^(feature|bugfix|chore): \S/

export type PlanContent = Omit<ApprovedPlan, 'designHash'>

function assignedExactlyOnce<T>(what: string, expected: T[], assigned: T[]): string[] {
  const problems: string[] = []
  for (const item of expected) {
    const count = assigned.filter((value) => value === item).length
    if (count !== 1) problems.push(`${what} ${item} is assigned to ${count} PRs; it must be assigned to exactly one.`)
  }
  for (const item of new Set(assigned.filter((value) => !expected.includes(value)))) {
    problems.push(`${what} ${item} is not in the design.`)
  }
  return problems
}

export function checkPlan(plan: Pick<PlanContent, 'prs'>, design: Design): string[] {
  const problems: string[] = []
  if (plan.prs.length === 0) problems.push('The plan has no PRs.')
  plan.prs.forEach((pr, index) => {
    if (pr.number !== index + 1) problems.push(`PR in position ${index + 1} is numbered ${pr.number}; number PRs 1, 2, 3 in build order.`)
    if (!TITLE_PREFIX.test(pr.title)) problems.push(`PR ${pr.number} title "${pr.title}" must start with feature:, bugfix: or chore:.`)
    for (const dependency of pr.dependsOn) {
      if (!(dependency >= 1 && dependency < pr.number)) problems.push(`PR ${pr.number} depends on PR ${dependency}, which is not an earlier PR.`)
    }
  })
  const checklistNumbers = design.doneWhen.map((_, index) => index + 1)
  problems.push(...assignedExactlyOnce('"Done when" item', checklistNumbers, plan.prs.flatMap((pr) => pr.doneWhen)))
  problems.push(...assignedExactlyOnce('Screenshot', design.screenshots, plan.prs.flatMap((pr) => pr.screenshots)))
  return problems
}

const INTRO = 'The design files beside this plan are the truth; this plan only says how to build them.'
const TABLE_HEAD = '| PR | Title | Depends on | Hard |\n|---|---|---|---|'
const LISTS = ['**Changes**', '**Tests**', '**Screenshots it must match**', '**"Done when" items it delivers**']

export function renderPlan(plan: PlanContent, design: Design): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n') || '- none'
  const table = plan.prs
    .map((pr) => `| ${pr.number} | ${pr.title} | ${pr.dependsOn.join(', ') || '—'} | ${pr.hard ? 'yes' : 'no'} |`)
    .join('\n')
  const sections = plan.prs.map((pr) => {
    const lists = [
      pr.changes,
      pr.tests,
      pr.screenshots.map((name) => `\`screenshots/${name}\``),
      pr.doneWhen.map((n) => `${n}. ${design.doneWhen[n - 1]}`),
    ]
    return [`## PR ${pr.number} — ${pr.title}`, pr.goal, ...LISTS.map((title, index) => `${title}\n\n${list(lists[index])}`)].join('\n\n')
  })
  return [`# ${design.name} — Implementation plan`, INTRO, plan.summary, `${TABLE_HEAD}\n${table}`, ...sections].join('\n\n') + '\n'
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export function tidyPlan(plan: PlanContent): PlanContent {
  return {
    summary: plan.summary.trim(),
    prs: plan.prs.map((pr) => ({
      ...pr,
      title: oneLine(pr.title),
      goal: pr.goal.trim(),
      changes: pr.changes.map(oneLine),
      tests: pr.tests.map(oneLine),
    })),
  }
}

function unreadable(why: string): never {
  throw new Error(`ImplementationPlan.md cannot be read: ${why}`)
}

export function parsePlan(text: string): PlanContent {
  const [head, ...sections] = text.split(/^## PR (?=\d+ — )/m)
  const tableAt = head.lastIndexOf(TABLE_HEAD)
  if (!head.startsWith('# ') || tableAt < 0) {
    unreadable(`it must start with a "# " title, and have this table before the first PR section:\n${TABLE_HEAD}`)
  }
  const rows = new Map<number, { dependsOn: number[]; hard: boolean }>()
  for (const line of head.slice(tableAt + TABLE_HEAD.length).split('\n')) {
    const row = /^\| (\d+) \| .* \| ([^|]*) \| (yes|no) \|$/.exec(line)
    if (row) rows.set(Number(row[1]), { dependsOn: /\d/.test(row[2]) ? row[2].split(',').map(Number) : [], hard: row[3] === 'yes' })
  }
  const prs = sections.map((section) => {
    const heading = /^(\d+) — (.*)\n/.exec(section) ?? unreadable('a PR heading is malformed.')
    const number = Number(heading[1])
    const row = rows.get(number) ?? unreadable(`PR ${number} is not in the PR table.`)
    let rest = section.slice(heading[0].length - 1)
    const lists: string[][] = []
    for (const title of [...LISTS].reverse()) {
      const at = rest.lastIndexOf(`\n\n${title}\n\n`)
      if (at < 0) unreadable(`PR ${number} has no ${title} list.`)
      const lines = rest.slice(at + title.length + 4).trim().split('\n')
      lists.unshift(lines.filter((line) => line !== '- none').map((line) => line.slice(2)))
      rest = rest.slice(0, at)
    }
    return {
      number,
      title: heading[2],
      goal: rest.trim(),
      changes: lists[0],
      tests: lists[1],
      dependsOn: row.dependsOn,
      screenshots: lists[2].map((item) => item.replace(/^`?(screenshots\/)?|`$/g, '')),
      doneWhen: lists[3].map((item) => Number.parseInt(item, 10)),
      hard: row.hard,
    }
  })
  return { summary: head.slice(head.indexOf('\n'), tableAt).replace(INTRO, '').trim(), prs }
}
