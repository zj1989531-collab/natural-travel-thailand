import { isValidCalendarDate } from './format'

export interface CommandDateMatch {
  token: string
  date: string
  start: number
  end: number
}

const moneyLabelAtEnd = /(?:总售价|销售价|代理价|售价|卖价|总价|总成本|成本|总进价|进价|总利润|利润|总返佣|返佣|金额|价格|价钱|单价)\s*[:：]?\s*(?:THB|฿)?\s*$/iu
const quantityLabelAtEnd = /(?:人数|数量)\s*[:：]?\s*$/u
const quantityAfter = /^\s*(?:人|位|名|张|个|件|瓶|盒|泰铢|铢|THB|฿)/iu

// Keep the short numeric forms separate from full dates. A date such as 10.18
// is convenient in copied messages, but it must not turn "售价：10.18" or
// "2.5人" into a travel date.
const dateToken = /(?<!\d)(?:(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日|号)?|(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})(?!\d)|(\d{1,2})\s*月\s*(\d{1,2})(?:日|号)?|(今天|今日|明天|明日|后天)|(\d{1,2})\s*[./]\s*(\d{1,2})(?![\d.]))/gu

const linePrefix = (text: string, index: number) => text.slice(text.lastIndexOf('\n', index - 1) + 1, index)
const lineSuffix = (text: string, index: number) => text.slice(index, text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index))

const shortDateIsUnambiguous = (text: string, start: number, end: number) => {
  const prefix = linePrefix(text, start)
  if (moneyLabelAtEnd.test(prefix) || quantityLabelAtEnd.test(prefix) || quantityAfter.test(lineSuffix(text, end))) return false
  // Monetary and quantity contexts are rejected above. Elsewhere a compact
  // numeric token is treated as the user's date attempt so invalid values such
  // as 13/01 receive a clear calendar error instead of being silently ignored.
  return true
}

const relativeDate = (token: string, today: string) => {
  if (!isValidCalendarDate(today)) throw new Error('当前日期无效，请明确填写日期。')
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + (/^明/.test(token) ? 1 : token === '后天' ? 2 : 0))
  return date.toISOString().slice(0, 10)
}

/**
 * Finds dates in pasted order text and resolves them to YYYY-MM-DD.
 *
 * Supported forms include YYYY-MM-DD, DD-MM-YYYY, 10.18, 10/18, 10月18日,
 * 今天、明天 and 后天. Short numeric dates use the supplied Bangkok date's
 * year. Callers deliberately require exactly one returned match.
 */
export const commandDateMatches = (text: string, today: string): CommandDateMatch[] => {
  const matches: CommandDateMatch[] = []
  for (const match of text.matchAll(dateToken)) {
    const start = match.index!
    const token = match[0]
    const [, year, month, day, dayFirst, dayFirstMonth, dayFirstYear, chineseMonth, chineseDay, relative, shortMonth, shortDay] = match
    let date: string

    if (relative) {
      date = relativeDate(relative, today)
    } else {
      const hasExplicitYear = Boolean(year || dayFirstYear)
      const resolvedMonth = Number(month ?? dayFirstMonth ?? chineseMonth ?? shortMonth)
      const resolvedDay = Number(day ?? dayFirst ?? chineseDay ?? shortDay)
      if (shortMonth && shortDay && !shortDateIsUnambiguous(text, start, start + token.length)) continue
      if (!hasExplicitYear && !isValidCalendarDate(today)) throw new Error('当前日期无效，请明确填写年份。')
      const resolvedYear = year ?? dayFirstYear ?? today.slice(0, 4)
      date = `${resolvedYear}-${String(resolvedMonth).padStart(2, '0')}-${String(resolvedDay).padStart(2, '0')}`
    }

    if (!isValidCalendarDate(date)) throw new Error('日期无效，请核对年月日。')
    matches.push({ token, date, start, end: start + token.length })
  }
  return matches
}

export const removeCommandDate = (text: string, match: CommandDateMatch) =>
  `${text.slice(0, match.start)}${' '.repeat(match.end - match.start)}${text.slice(match.end)}`
