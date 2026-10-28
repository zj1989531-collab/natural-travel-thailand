import { getBangkokDate, isValidCalendarDate, isValidPersonCount } from './format'
import { commandDateMatches, removeCommandDate } from './command-date'

export type BoxingCategory = 'asian' | 'western'
export interface Show69RecordInput { date: string; guestName: string; people: number; boxingCategory?: BoxingCategory; projectId?: string }

// Historical record snapshots are classified without changing their names.
export const isShow69Project = (name: string): boolean => {
  const value = name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return /^(?:69|六九)$/.test(value) || /^(?:69|六九)(?:成人)?秀/.test(value) || /^69show(?:$|[^a-z])/.test(value)
}

export const validateShow69Record = (input: Show69RecordInput) => {
  if (!input.guestName.trim() || input.guestName.trim().length > 100) throw new Error('请填写所有人的姓名，最多100个字符。')
  if (!isValidCalendarDate(input.date)) throw new Error('请填写有效的日期。')
  if (!isValidPersonCount(input.people)) throw new Error('人数必须是大于或等于1的整数。')
}

const trimSeparators = (text: string) => text.replace(/^[\s,，;；、:：|]+|[\s,，;；、:：|]+$/g, '').replace(/\s+/g, ' ').trim()

export const isShow69Command = (text: string): boolean => {
  const remaining = text.normalize('NFKC')
    .replace(/(?:备注|说明|\bnote\s*:)\s*[:：]?\s*[\s\S]*$/i, '')
    .replace(/\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}(?:日|号)?|\d{1,2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{4}|(?<!\d)\d{1,2}\s*月\s*\d{1,2}(?:日|号)?|(?<!\d)\d{1,2}\s*[./]\s*\d{1,2}(?![\d.])|今天|今日|明天|明日|后天|\d{1,2}\s*:\s*\d{2}/g, ' ')
    .replace(/(?:售价|代理价|卖价|总价|成本|进价|利润|返佣)\s*[:：]?\s*(?:THB|฿)?\s*[+-]?\s*\d+(?:[,.]\d+)*/gi, ' ')
    .replace(/(?:人数|数量)\s*[:：]?\s*[+-]?\s*\d+(?:\.\d+)?\s*(?:人|位|名|张|个|件|瓶|盒)?|(?<![\d.A-Za-z])[+-]?\s*\d+(?:\.\d+)?\s*(?:人|位|名|张|个|件|瓶|盒)(?=$|[\s,，;；、]|(?:69|79|89|99)(?:秀|show)?(?=$|[\s,，;；、]))/g, ' ')
  return /(?:^|[\s,，;；、:：|])(?:69(?:\s*成人)?\s*秀?|六九(?:\s*成人)?\s*秀?|69\s*show)(?=$|[\s,，;；、:：|]|(?:出票|记录)?格式)/i.test(remaining)
}

// This only fills the editable record. Persistence is a separate user action.
export function parseShow69Command(text: string, today = getBangkokDate()): Show69RecordInput {
  let remaining = text.normalize('NFKC').replace(/[‐‑‒–—−﹣－]/g, '-').trim()
  if (!remaining) throw new Error('请先输入或黏贴日期、所有人姓名和人数。')
  if (/(?:备注|说明|\bnote\s*:)\s*[:：]?/i.test(remaining)) throw new Error('69秀仅记录日期、所有人姓名和人数，请移除备注或说明后再填写。')
  remaining = remaining.replace(/^(?:69(?:\s*成人)?\s*秀?|六九(?:\s*成人)?\s*秀?)(?:\s*出票|\s*记录)?\s*格式\s*[:：]?\s*(?:\r?\n|$)/i, '')
  const dates = commandDateMatches(remaining, today)
  if (dates.length !== 1) throw new Error('请填写一个日期，例如“10月23”“今天”或“2026/10/23”；不要同时填写多个日期。')
  const date = dates[0].date
  remaining = removeCommandDate(remaining, dates[0])
  // Strip the product before looking for 张 counts: “69 张三” names a guest.
  const product = /(^|[\s,，;；、:：|])(?:69\s*show|69(?:\s*成人)?\s*秀?|六九(?:\s*成人)?\s*秀?)(?=$|[\s,，;；、:：|])/gi
  remaining = remaining.replace(product, ' ')
  if (/(?:^|[\s,，;；、:：|])(?:79|89|99)(?:\s*成人)?\s*(?:秀|show)?(?=$|[\s,，;；、:：|])/i.test(remaining)) {
    throw new Error('这里仅记录69秀，请核对项目名称。')
  }
  const counts = [...remaining.matchAll(/人数\s*[:：]?\s*([+-]?\s*\d+(?:\.\d+)?)(?![\d.A-Za-z])[ \t]*(?:人|位|名|张|个)?|(?<![\d.A-Za-z])([+-]?\s*\d+(?:\.\d+)?)\s*(?:人|位|名|张|个)/g)]
  if (counts.length !== 1) throw new Error('请填写一个人数，例如“人数：3”或“3人”；不要同时填写多个人数。')
  const people = Number((counts[0][1] ?? counts[0][2]).replace(/\s/g, ''))
  if (!isValidPersonCount(people)) throw new Error('人数必须是大于或等于1的整数。')
  remaining = remaining.replace(counts[0][0], ' ').replace(product, ' ')
  remaining = remaining.replace(/(?:观看日期|出行日期|出票日期|日期|项目名称|项目)\s*[:：]?/g, ' ')
  const labels = [...remaining.matchAll(/(?:客户姓名|姓名|名字|客户)(?:\s*\(\s*所有人\s*\))?\s*[:：]?/g)]
  if (labels.length > 1) throw new Error('检测到多个姓名字段，请将所有人的姓名放在同一个字段中。')
  if (labels.length) {
    const before = trimSeparators(remaining.slice(0, labels[0].index))
    if (before) throw new Error(`未能识别内容：${before}，请核对后重试。`)
    remaining = remaining.slice(labels[0].index! + labels[0][0].length)
  }
  const guestName = trimSeparators(remaining)
  // Do not silently absorb a second count, an unknown product or a bad date.
  if (/[\d:：/]|人数|日期|格式/.test(guestName)) throw new Error('未能识别所有人的姓名，请核对日期、项目和人数。')
  const input = { date, guestName, people }
  validateShow69Record(input)
  return input
}
