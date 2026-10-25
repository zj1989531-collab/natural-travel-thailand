import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { isShow69Command, isShow69Project, parseShow69Command, validateShow69Record } from './show69'
import { buildShow79Report, mainLedgerTickets } from './show79'
import { ticketsForDailyStats, ticketsInMonth, ticketsInYear } from './stats'
import { buildReport } from './reports'
import { createLedgerBackup } from './export'

const template = '69出票格式\n日期：10月23\n名字（所有人）：韩廷富,邵建华,江华兴\n人数：3'
const row = (id: string, projectName: string): TicketRecord => ({
  id, projectName, userId: 'owner', supplierId: 's', supplierName: '供货商', projectId: 'p', subItemName: '',
  issueDate: '2026-10-23', issueTime: '10:00', guestName: '张三', personCount: 3, amountBasis: 'per_person', settlementMode: 'daily',
  agentPriceThb: 500, costThb: 400, note: '', createdAt: '', updatedAt: '', deletedAt: null, syncStatus: 'synced'
})

describe('69 independent records', () => {
  it.each(['69', '69秀', '６９ 秀', '69成人秀', '69秀 · 月结返佣', '六九', '六九秀', '69 Show'])('classifies historical snapshot %s', name => {
    expect(isShow69Project(name)).toBe(true)
  })
  it.each(['169秀', '69.9元', '69商品', '79秀', '89秀', '99秀'])('does not classify unrelated project %s', name => {
    expect(isShow69Project(name)).toBe(false)
  })
  it('keeps every name and fills the supplied template with the Bangkok current year', () => {
    expect(parseShow69Command(template, '2026-12-31')).toEqual({ date: '2026-10-23', guestName: '韩廷富,邵建华,江华兴', people: 3 })
    expect(parseShow69Command(template.replace('69出票格式\n', ''), '2027-01-01').date).toBe('2027-10-23')
  })
  it.each(['-', '–', '—', '−', '﹣'])('accepts labelled day-month-year dates with %s', (dash) => {
    expect(parseShow69Command(`69出票格式\n日期：25${dash}10${dash}2026\n名字（所有人）：贾帅\n人数：1`)).toEqual({ date: '2026-10-25', guestName: '贾帅', people: 1 })
  })
  it.each([
    ['69 张三 今天 2人', '2026-10-23', '张三', 2],
    ['六九秀 李湘光 龙粉萍 2026年10月24日 2位', '2026-10-24', '李湘光 龙粉萍', 2],
    ['张三 今天2个69', '2026-10-23', '张三', 2],
    ['69show 张三 明天 1名', '2026-10-24', '张三', 1],
    ['69 Show 张三 今天 1人', '2026-10-23', '张三', 1],
    ['日期：2026/10/23\n姓名：张三\n人数：2', '2026-10-23', '张三', 2]
  ])('fills natural and labelled input %s', (text, date, guestName, people) => {
    expect(parseShow69Command(text, '2026-10-23')).toEqual({ date, guestName, people })
  })
  it('uses relative dates over leap days and year boundaries', () => {
    expect(parseShow69Command('69 张三 后天 1人', '2026-12-31').date).toBe('2027-01-02')
    expect(parseShow69Command('69 张三 明天 1人', '2024-02-28').date).toBe('2024-02-29')
  })
  it.each([
    '', '69 张三 今天 明天 2人', '69 张三 今天 2人 3人', '69 张三 2月30 2人', '69 张三 2026/02/29 2人',
    '69 张三 今天 0人', '69 张三 今天 -2人', '69 张三 今天 2.5人', '69 张三 今天 .5人',
    '69 张三 今天 人数2e1', '79 张三 今天 2人', '89秀 张三 今天 2人', '99秀 张三 今天 2人',
    '69 今天 2人', '69 张三 2人', '69 张三 今天', '69 张三 今天 2人 售价100', '69 张三 今天 2人 备注：生日'
  ])('rejects ambiguous, incomplete or other-product input %s', text => {
    expect(() => parseShow69Command(text, '2026-10-23')).toThrow()
  })
  it('validates the persisted record fields', () => {
    expect(() => validateShow69Record({ date: '2026-10-23', guestName: '张三', people: 3 })).not.toThrow()
    expect(() => validateShow69Record({ date: '2026-10-23', guestName: ' ', people: 3 })).toThrow('姓名')
    expect(() => validateShow69Record({ date: '2026-10-23', guestName: '张'.repeat(101), people: 3 })).toThrow('100')
    expect(() => validateShow69Record({ date: '2026-10-23', guestName: '张三', people: 2147483648 })).toThrow('人数')
  })
  it('isolates 69 and 79 from all main reports and retains them in the full backup', () => {
    const rows = [row('69', '69秀'), row('79', '79秀'), row('normal', '普通门票')]
    expect(mainLedgerTickets(rows).map(record => record.id)).toEqual(['normal'])
    expect(ticketsForDailyStats(rows, '2026-10-23').map(record => record.id)).toEqual(['normal'])
    expect(ticketsInMonth(rows, '2026-10').map(record => record.id)).toEqual(['normal'])
    expect(ticketsInYear(rows, '2026').map(record => record.id)).toEqual(['normal'])
    for (const mode of ['day', 'month', 'range', 'all'] as const) {
      const report = buildReport(rows, { mode, date: '2026-10-23', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '' })
      expect(report.records.map(record => record.id)).toEqual(['normal'])
      expect(report.quantity.peopleCount).toBe(3)
      expect(report.supplierStats.map(record => record.profitThb)).toEqual([300])
    }
    expect(buildShow79Report(rows, '2026-10-23', '2026-10').records.map(record => record.id)).toEqual(['79'])
    expect(createLedgerBackup({ tickets: rows, suppliers: [], projects: [] }).tickets).toHaveLength(3)
  })
})

describe('69 command routing', () => {
  it.each([template, '69 张三 今天 2人', '张三 69秀 今天 2人', '张三 今天2个69', '六九秀 张三 今天 2人', '69 Show 张三 今天 2人'])('detects an explicit product in %s', text => {
    expect(isShow69Command(text)).toBe(true)
  })
  it.each(['79 张三 今天 售价69 成本50 2人', '79 张三 今天 售价：69 2人', '79 张三 今天 人数69', '79 张三 今天 69人', '79 张三 2026/6/9 2人', '69商品 张三 今天 2人', '张三 今天 2人 总价 69', 'John69 今天 2人'])('does not route other numeric data in %s', text => {
    expect(isShow69Command(text)).toBe(false)
  })
  it.each(['备注：69', '说明：69秀', 'note: 69'])('ignores product-like text inside %s while routing', note => {
    expect(isShow69Command(`79 张三 今天 2人 ${note}`)).toBe(false)
    expect(isShow69Command(`69 张三 今天 2人 ${note}`)).toBe(true)
    expect(() => parseShow69Command(`69 张三 今天 2人 ${note}`, '2026-10-23')).toThrow('请移除备注')
  })
})
