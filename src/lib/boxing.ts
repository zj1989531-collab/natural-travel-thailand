import type { Project, TicketRecord } from '../types'
import { isShow69Command, parseShow69Command, type BoxingCategory, type Show69RecordInput } from './show69'

const product = '(?:(?:MAX|芭提雅|芭堤雅)\\s*){0,2}泰拳(?:比赛|表演|门票|拳赛|独立记录)?(?:\\s*(?:VVIP|VIP|普通票|成人票|儿童票|亚洲面孔|欧美面孔|亚洲人|欧美人))?(?:\\s*[/／·—-]?\\s*月结[返反]佣)?(?:\\s*[（(]\\s*(?:亚洲面孔|欧美面孔|亚洲人|欧美人)\\s*[）)])?'
const boundary = '[\\s,，;；、:：|()]'
const names = /(?:客户姓名|姓名|名字|客户)(?:\s*\(\s*所有人\s*\))?\s*[:：]?/
const nextField = /(?:观看日期|出行日期|出票日期|日期|人数|数量|票种|票型|人群|类别|套餐(?:类型)?|项目(?:名称)?)\s*[:：]/

const nameSpan = (line: string): { start: number; end: number } | undefined => {
  const label = names.exec(line)
  if (!label) return undefined
  const start = label.index
  const contentStart = start + label[0].length
  const next = nextField.exec(line.slice(contentStart))
  return { start, end: next ? contentStart + next.index : line.length }
}

// Protect the whole explicitly labelled customer field when handling project
// markers. In particular, a customer named “泰拳” must never be removed.
const outsideNames = (text: string, transform: (prefix: string) => string) => text.split('\n').map(line => {
  const span = nameSpan(line)
  return span ? transform(line.slice(0, span.start)) + line.slice(span.start, span.end) + transform(line.slice(span.end)) : transform(line)
}).join('\n')
const withoutNames = (text: string) => text.split('\n').map(line => {
  const span = nameSpan(line)
  return span ? line.slice(0, span.start) + ' ' + line.slice(span.end) : line
}).join('\n')

const categoryWords = '亚洲面孔|亚洲人|亚洲票|亚洲|欧美面孔|欧美人|欧美票|欧美'
const categoryMarkers = () => new RegExp(`(^|[\\s,，;；、:：|()/])(${categoryWords})(?=$|[\\s,，;；、:：|()/])`, 'g')
const categorySource = (text: string) => withoutNames(text.normalize('NFKC').replace(/(?:备注|说明|\bnote\s*:)\s*[:：]?\s*[\s\S]*$/i, ''))
  .replace(new RegExp(`(泰拳(?:比赛|表演|门票|拳赛)?)(?=${categoryWords})`, 'g'), '$1 ')

export const boxingCategoryFromText = (text: string): BoxingCategory | undefined => {
  const categories = new Set([...categorySource(text).matchAll(categoryMarkers())].map(match => match[2].startsWith('亚洲') ? 'asian' as const : 'western' as const))
  if (categories.size > 1) throw new Error('亚洲人和欧美人票种请分开录入，每条记录只能选择一种票种。')
  return [...categories][0]
}

export const boxingCategoryForProject = (project: Pick<Project, 'name' | 'subItemName'>): BoxingCategory | undefined => {
  if (!isBoxingProject(project.name)) return undefined
  try { return boxingCategoryFromText(`${project.name}\n${project.subItemName}`) }
  catch { return undefined } // Mixed historical labels remain unknown, without changing their snapshots.
}

export const boxingCategoryForTicket = (ticket: Pick<TicketRecord, 'projectName' | 'subItemName'>): BoxingCategory | undefined =>
  boxingCategoryForProject({ name: ticket.projectName, subItemName: ticket.subItemName })

export const isBoxingProject = (name: string): boolean => new RegExp(`^(?:${product})(?:\\s*[（(·/／—-].*)?$`, 'i').test(name.normalize('NFKC').trim())

export const isBoxingCommand = (text: string): boolean => {
  const content = withoutNames(text.normalize('NFKC').replace(/(?:备注|说明|\bnote\s*:)\s*[:：]?\s*[\s\S]*$/i, ''))
  return new RegExp(`(?:^|${boundary})(?:${product})(?=$|${boundary}|(?:出票|记录)?格式)`, 'i').test(content)
}

// Reuse the existing strict date/name/headcount parser. Only standalone product
// labels outside customer fields are translated to its internal product label.
export function parseBoxingCommand(text: string, today?: string): Show69RecordInput {
  const normalized = text.normalize('NFKC')
  const boxingCategory = boxingCategoryFromText(normalized)
  const labels = withoutNames(normalized)
  if (isShow69Command(labels) || new RegExp(`(?:^|${boundary})泰拳(?:课程|培训|教学)(?=$|${boundary})`, 'i').test(labels)) {
    throw new Error('这里仅记录泰拳，请核对项目名称。')
  }
  const marker = new RegExp(`(^|${boundary})(?:${product})(?=$|${boundary}|(?:出票|记录)?格式)`, 'gi')
  const prepared = outsideNames(normalized, prefix => prefix.replace(marker, '$1' + '69')
    .replace(categoryMarkers(), '$1')
    .replace(/(?:票种|票型|人群|类别|套餐(?:类型)?)\s*[:：]?/g, ' ')
    .replace(/\(\s*\)/g, ' '))
  try {
    const input = parseShow69Command(prepared, today)
    return boxingCategory ? { ...input, boxingCategory } : input
  }
  catch (error) {
    if (error instanceof Error) throw new Error(error.message.replaceAll('69秀', '泰拳'))
    throw error
  }
}
