import type { AmountBasis, Project, TicketInput } from '../types'
import { getBangkokDate, isValidIssueTime, isValidPersonCount } from './format'
import { commandDateMatches, removeCommandDate } from './command-date'
import { cleanProjectLabel } from './project-labels'
import { chooseProjectOption } from './project-selection'
import { resolveProjectRules } from './project-rules'

export interface ParsedTicketCommand {
  candidates: Project[]
  warnings: string[]
  fields: Partial<TicketInput>
}

type TextMatch = { start: number; end: number; value: string }
// iOS and copied chat messages often replace a hyphen with a typographic dash.
// Normalize every common dash before parsing dates, quantities and prices.
const normalized = (value: string) => value.normalize('NFKC').replace(/[‐‑‒–—−﹣－]/g, '-').trim()
const key = (value: string) => normalized(value).replace(/\s+/g, '').toLowerCase()
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const occurrences = (text: string, label: string): TextMatch[] => {
  const compact = key(label)
  if (!compact) return []
  const expression = new RegExp([...compact].map(escapeRegex).join('\\s*'), 'gi')
  return [...text.matchAll(expression)].filter((match) => {
    const start = match.index!
    const before = text[start - 1] ?? ''
    const after = text[start + match[0].length] ?? ''
    return !(/[a-z0-9]/i.test(compact[0]) && /[a-z0-9]/i.test(before)) &&
      !(/[a-z0-9]/i.test(compact.at(-1)!) && /[a-z0-9]/i.test(after))
  }).map((match) => ({ start: match.index!, end: match.index! + match[0].length, value: match[0] }))
}
const remove = (text: string, matches: TextMatch[]) => {
  const characters = text.split('')
  // Match offsets use UTF-16 indices, as do slice and regular expressions.
  for (const match of matches) for (let i = match.start; i < match.end; i++) characters[i] = ' '
  return characters.join('')
}
const strip = (value: string) => value.replace(/^[\s,，;；、:：|/]+|[\s,，;；、:：|/]+$/g, '').replace(/\s+/g, ' ')
const projectKey = (project: Project) => key(cleanProjectLabel(project.name))
const projectAliases = (project: Project) => {
  const aliases = [project.name, cleanProjectLabel(project.name)]
  // This is the commonly used customer-facing name for the catalogue entry.
  // Keep it as an input-only alias so historical project names stay unchanged.
  if (projectKey(project) === '格兰岛跟团一日游') aliases.push('格兰岛出海一日游')
  const show = projectKey(project).match(/^(69|79|89|99)(?:秀|show)?$/)
  if (show) aliases.push(show[1], `${show[1]}秀`, `${show[1]}show`)
  if (/^(?:imagine)?79(?:秀|show)?$/.test(projectKey(project))) aliases.push('79', '79秀', '79show', 'imagine79show')
  return [...new Set(aliases.filter(Boolean))]
}
const packageAliases = (value: string) => {
  const cleaned = cleanProjectLabel(value)
  const aliases = [value, cleaned]
  const code = /^([a-h])\s*套餐(?:[·・\s].*)?$/i.exec(cleaned)
  if (code) aliases.push(code[1])
  return [...new Set(aliases.filter(Boolean))]
}
const priceValue = (value: string) => {
  if (!/^\+?\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 999999999999.99) {
    throw new Error('金额必须是非负数字，且最多保留两位小数。')
  }
  return Number(value)
}

export const parseTicketCommand = (text: string, projects: Project[], today = getBangkokDate()): ParsedTicketCommand => {
  let remaining = normalized(text)
  if (!remaining) throw new Error('请先输入或黏贴订单文字。')
  remaining = remaining.replace(/^((?:69|79|89|99)(?:\s*成人)?\s*秀?)(?:\s*出票|\s*记录)?\s*格式\s*[:：]?\s*(?:\r?\n|$)/i, '$1\n')
  const fields: Partial<TicketInput> = {}
  const warnings: string[] = []
  const catalogue = projects.filter((project) => !project.mergedIntoId)

  const note = /(?:备注|说明|\bnote\s*:)\s*[:：]?\s*([\s\S]*)$/i.exec(remaining)
  if (note) {
    fields.note = note[1].trim()
    remaining = remaining.slice(0, note.index)
  }
  if (/(?:成人\s*\d+[\s\S]*儿童\s*\d+|儿童\s*\d+[\s\S]*成人\s*\d+)/.test(remaining)) throw new Error('成人和儿童等多个套餐请分别填写订单。')

  const dates = commandDateMatches(remaining, today)
  if (dates.length > 1) throw new Error('检测到多个日期，请每次填写一个观看日期。')
  if (dates.length) {
    fields.issueDate = dates[0].date
    remaining = removeCommandDate(remaining, dates[0])
  } else warnings.push('未识别日期，保留当前日期，请核对。')

  const times = [...remaining.matchAll(/\d{1,2}\s*:\s*\d{2}/g)]
  if (times.length > 1) throw new Error('检测到多个时间，请每次填写一个时间。')
  if (times.length) {
    const time = times[0][0].replace(/\s/g, '').padStart(5, '0')
    if (!isValidIssueTime(time)) throw new Error('时间无效，请使用 00:00 至 23:59。')
    fields.issueTime = time
    remaining = remaining.replace(times[0][0], ' '.repeat(times[0][0].length))
  }

  const bases = new Set<AmountBasis>()
  const money = /((?:单人|单件|每人|每件|整单)?\s*(?:总售价|销售价|代理价|售价|卖价|总价|总成本|成本|总进价|进价|总利润|利润|总返佣|返佣))\s*[:：]?\s*(?:THB|฿)?\s*([+-]?\s*\d+(?:,\d{3})*(?:\.\d+)?)(?![\d.]|,\d)(?:\s*(?:泰铢|铢|THB|฿))?(\s*(?:\/\s*(?:人|件)|每人|每件))?(?![A-Za-z\d.]|,\d)/gi
  const protectedNames = catalogue.flatMap((project) => occurrences(remaining, project.name))
  const monetaryMatches = [...remaining.matchAll(money)].filter((match) => {
    const labelStart = match.index!
    const labelEnd = labelStart + match[1].length
    return !protectedNames.some((name) => name.start <= labelStart && name.end === labelEnd &&
      (name.start < labelStart || /^\s*(?:人|位|名|张|个|件|瓶|盒)/.test(remaining.slice(labelStart + match[0].length))))
  })
  const assigned = new Set<string>()
  for (const match of monetaryMatches) {
    const label = match[1].replace(/\s/g, '')
    const field = /利润|返佣/.test(label) ? 'manualProfitThb' : /成本|进价/.test(label) ? 'costThb' : 'agentPriceThb'
    if (assigned.has(field)) throw new Error('检测到重复金额，请每种金额只填写一次。')
    assigned.add(field)
    fields[field] = priceValue(match[2].replace(/[\s,]/g, ''))
    if (/单人|单件|每人|每件/.test(label) || match[3]) bases.add('per_person')
    if (/整单|总/.test(label)) bases.add('total')
  }
  remaining = remove(remaining, monetaryMatches.map((match) => ({ start: match.index!, end: match.index! + match[0].length, value: match[0] })))
  const basisWords = [...remaining.matchAll(/单人|单件|每人|每件|整单/g)]
  for (const match of basisWords) bases.add(match[0] === '整单' ? 'total' : 'per_person')
  remaining = remove(remaining, basisWords.map((match) => ({ start: match.index!, end: match.index! + match[0].length, value: match[0] })))
  if (bases.size > 1) throw new Error('总价和单人／单件金额不能混填，请统一计价方式。')
  if (bases.size) fields.amountBasis = [...bases][0]

  // Bare show numbers in an explicitly labelled quantity belong to that field.
  // Preserve the original string for count parsing after project matching.
  const quantitySpans = [...remaining.matchAll(/(?:人数|数量)\s*[:：]?\s*[+-]?\s*\d+(?:\.\d+)?(?!\s*[./]\s*\d)\s*(?:人|位|名|张|个|件|瓶|盒)?|(?<![\d.A-Za-z/])[+-]?\s*\d+(?:\.\d+)?\s*(?:人|位|名|张|个|件|瓶|盒)(?=$|[\s,，;；、]|(?:69|79|89|99)(?:秀|show)?(?=$|[\s,，;；、]))/g)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }))
  const projectMatches = catalogue.flatMap((project) => projectAliases(project).flatMap((alias) => occurrences(remaining, alias)
    .filter(match => !/^\d+$/.test(alias) || !quantitySpans.some(span => span.start <= match.start && span.end >= match.end))
    .map((match) => ({ ...match, project, alias }))))
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
  const longest = projectMatches.filter((match) => !projectMatches.some((other) =>
    other.end - other.start > match.end - match.start && other.start <= match.start && other.end >= match.end))
  if (!longest.length) throw new Error('未找到目录中的项目，请填写系统已有的项目名称。')
  const names = new Set(longest.map((match) => projectKey(match.project)))
  if (names.size !== 1) throw new Error('检测到多个项目，请每次只填写一个项目。')
  let candidates = catalogue.filter((project) => names.has(projectKey(project)))
  const rawSpecificNames = new Set(longest.filter((match) => key(match.alias) === key(match.project.name) && key(match.project.name) !== projectKey(match.project)).map((match) => key(match.project.name)))
  if (rawSpecificNames.size > 1) throw new Error('检测到多个套餐，请分别填写订单。')
  if (rawSpecificNames.size) candidates = candidates.filter((project) => rawSpecificNames.has(key(project.name)))
  remaining = remove(remaining, longest)
  if (/(?:总售价|销售价|代理价|售价|卖价|总价|总成本|成本|进价|利润|返佣)\s*[:：]?\s*\S/.test(remaining)) throw new Error('未识别金额，请在金额标签后填写完整有效数字。')

  const counts = [...remaining.matchAll(/(?:人数|数量)\s*[:：]?\s*([+-]?\s*\d+(?:\.\d+)?)(?![\d.A-Za-z]|\s*[./]\s*\d)\s*(人|位|名|张|个|件|瓶|盒)?|(?<![\d.A-Za-z/])([+-]?\s*\d+(?:\.\d+)?)\s*(人|位|名|张|个|件|瓶|盒)/g)]
  if (counts.length > 1) throw new Error('检测到多个人数或数量，请每次只填写一个套餐的数量。')
  if (counts.length) {
    const count = Number((counts[0][1] ?? counts[0][3]).replace(/\s/g, ''))
    if (!isValidPersonCount(count)) throw new Error('人数／数量必须是大于 0 的整数。')
    fields.personCount = count
    remaining = remaining.replace(counts[0][0], ' '.repeat(counts[0][0].length))
  } else {
    if (/(?:人数|数量)\s*[:：]?\s*\S|无人|[\d.][\deE.+-]*\s*(?:人|位|名|张|个|件|瓶|盒)/.test(remaining)) throw new Error('人数／数量必须是大于 0 的整数。')
    warnings.push('未识别人数／数量，保留当前值，请核对。')
  }

  const narrow = (labels: (project: Project) => string[], kind: string) => {
    const matches = candidates.flatMap((project) => labels(project).flatMap((label) => occurrences(remaining, label).map((match) => ({ ...match, project, label }))))
    const longestMatches = matches.filter((match) => !matches.some((other) => other.end - other.start > match.end - match.start && other.start <= match.start && other.end >= match.end))
    const selectedLabels = new Set(longestMatches.map((match) => key(match.label)))
    if (selectedLabels.size > 1) throw new Error(`检测到多个${kind}，请每次只填写一个订单。`)
    if (longestMatches.length) {
      const ids = new Set(longestMatches.map((match) => match.project.id))
      candidates = candidates.filter((project) => ids.has(project.id))
      remaining = remove(remaining, longestMatches)
    }
  }
  narrow((project) => packageAliases(project.subItemName), '套餐')
  narrow((project) => [project.supplierName], '供货商')

  // Strip recognized catalogue labels that do not belong to this choice rather
  // than treating a package or supplier as a customer's name.
  const unmatchedLabels = [...new Set(catalogue.flatMap((project) => [project.subItemName, project.supplierName]).filter(Boolean))]
    .flatMap((label) => occurrences(remaining, label))
  if (unmatchedLabels.length) {
    throw new Error(`此项目没有匹配的套餐／供货商：${[...new Set(unmatchedLabels.map((match) => strip(match.value)))].join('、')}，请核对目录后重新填写。`)
  }
  remaining = remaining.replace(/(?:项目名称|项目|套餐|供货商|供应商|人数|数量|观看日期|出行日期|出票日期|日期|时间|场次)\s*[:：]?/g, ' ')
  const explicitName = /(?:客户姓名|客户|姓名|名字|guest(?:\s*name)?)(?:\s*\(\s*所有人\s*\))?\s*[:：]?/i.exec(remaining)
  let nameText = remaining
  if (explicitName) {
    const before = strip(remaining.slice(0, explicitName.index))
    if (before) warnings.push(`未识别内容：${before}，请手动核对。`)
    nameText = remaining.slice(explicitName.index + explicitName[0].length)
  }
  const segments = nameText.split(/[\s,，;；、|]+/).filter(Boolean)
  const suspicious = /^(?:VIP|VVIP|SVIP|standard|premium|deluxe|luxury|无|不详)$|(?:普通|标准|豪华|钻石|白金|黄金|儿童|成人|套餐|座位|接送|门票|项目|售价|成本|利润|返佣|未知|未填)/i
  const namesFound: string[] = []
  const leftovers: string[] = []
  for (const segment of segments) {
    const token = strip(segment)
    const plausible = !(explicitName ? /^(?:未知|未填|无|不详)$/.test(token) : suspicious.test(token)) && /^[\p{L}][\p{L}\p{M}.'’·-]*$/u.test(token)
    if (plausible) namesFound.push(token)
    else leftovers.push(token)
  }
  if (namesFound.length) {
    const name = namesFound.join(' ')
    if (name.length > 100) throw new Error('客户姓名过长，请控制在 100 个字符以内。')
    fields.guestName = name
    if (!explicitName) warnings.push('客户姓名由剩余文字识别，请核对。')
  } else { fields.guestName = ''; warnings.push('未识别客户姓名，已清空原姓名，请填写本次客户姓名后再核对保存。') }
  if (leftovers.length) warnings.push(`未识别内容：${leftovers.join(' ')}，请手动核对。`)
  if (candidates.length > 1) warnings.push('目录中有多个匹配套餐或供货商，请明确选择后填入。')
  if (fields.agentPriceThb == null && candidates.some((project) => project.manualAgentPrice)) warnings.push('匹配项目包含手动售价项目，未提供售价时仍需手动填写，请核对。')
  if (fields.agentPriceThb == null && fields.costThb == null && fields.manualProfitThb == null) warnings.push('未填写明确金额，将采用所选项目的默认设置，请核对需要手填的金额。')
  return { candidates, warnings, fields }
}

export const applyTicketCommand = (current: TicketInput, parsed: ParsedTicketCommand, project: Project): TicketInput => {
  if (!parsed.candidates.some((candidate) => candidate.id === project.id)) throw new Error('请选择本次识别结果中的项目套餐。')
  const rules = resolveProjectRules(project)
  const selected = chooseProjectOption({ ...current, projectName: project.name }, [project], project.id)
  const fields = { ...parsed.fields }
  if (selected.entryMode === 'profit_only') {
    if (fields.agentPriceThb != null || fields.costThb != null) throw new Error('仅录利润的项目请填写“利润”或“返佣”，不要填写售价和成本。')
    delete fields.agentPriceThb
    delete fields.costThb
  } else {
    if (fields.manualProfitThb != null) throw new Error('普通出票项目请填写售价和成本，不能直接填写返佣利润。')
    if (fields.amountBasis && fields.amountBasis !== rules.defaultAmountBasis && (fields.agentPriceThb == null || fields.costThb == null)) {
      throw new Error('切换整单／单人计价时，请同时填写该单位下的售价和成本，避免混合金额单位。')
    }
  }
  return { ...selected, amountBasis: rules.defaultAmountBasis, settlementMode: rules.settlementMode, ...fields }
}
