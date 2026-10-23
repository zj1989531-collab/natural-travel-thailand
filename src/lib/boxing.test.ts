import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { isBoxingCommand, isBoxingProject, parseBoxingCommand } from './boxing'
import { mainLedgerTickets, buildShow79Report } from './show79'
import { ticketsForDailyStats, ticketsInMonth, ticketsInYear } from './stats'
import { buildReport } from './reports'
import { buildProfitTrend } from './profit-trend'
import { createLedgerBackup } from './export'

const row = (id: string, projectName: string): TicketRecord => ({
  id, projectName, userId: 'owner', supplierId: 'supplier', supplierName: '供货商', projectId: 'project', subItemName: '',
  issueDate: '2026-10-23', issueTime: '10:00', guestName: '张三', personCount: 3, amountBasis: 'per_person', settlementMode: 'daily',
  agentPriceThb: 500, costThb: 400, note: '', createdAt: '', updatedAt: '', deletedAt: null, syncStatus: 'synced'
})
const template = '泰拳记录格式\n日期：10月23\n名字（所有人）：韩廷富,邵建华,江华兴\n人数：3'

describe('independent boxing records', () => {
  it.each(['泰拳', 'MAX 泰拳', 'ＭＡＸ 泰拳', 'MAX泰拳', '芭提雅泰拳', '芭堤雅 MAX 泰拳', '泰拳比赛 VIP', 'MAX 泰拳（亚洲面孔）', 'MAX泰拳/月结返佣', '泰拳 · 月结'])('classifies the saved project %s', name => {
    expect(isBoxingProject(name)).toBe(true)
  })
  it.each(['泰拳课程', '泰拳培训', '泰拳教学', '不含泰拳', '79秀', '普通门票', '泰拳课程门票'])('keeps unrelated projects %s out of the independent ledger', name => {
    expect(isBoxingProject(name)).toBe(false)
  })
  it('parses the supplied three-field format and keeps every name', () => {
    expect(parseBoxingCommand(template, '2026-10-23')).toEqual({ date: '2026-10-23', guestName: '韩廷富,邵建华,江华兴', people: 3 })
    expect(parseBoxingCommand(template.replace('泰拳记录格式\n', ''), '2027-01-01').date).toBe('2027-10-23')
  })
  it.each(['泰拳', 'MAX 泰拳', '芭提雅泰拳', '泰拳比赛 VIP', 'MAX泰拳/月结返佣', 'MAX 泰拳（亚洲面孔）'])('handles standalone marker %s with natural date and counts', product => {
    expect(parseBoxingCommand(`${product} 张三 明天 2人`, '2026-12-31')).toEqual({ date: '2027-01-01', guestName: '张三', people: 2 })
    expect(isBoxingCommand(`${product} 张三 明天 2人`)).toBe(true)
  })
  it('protects project-like words in explicitly labelled names and within a name', () => {
    expect(parseBoxingCommand('泰拳\n日期：10月23\n名字（所有人）：泰拳,MAX 泰拳,李泰拳\n人数：3', '2026-10-23').guestName).toBe('泰拳,MAX 泰拳,李泰拳')
    expect(parseBoxingCommand('泰拳 李泰拳 今天 1人', '2026-10-23').guestName).toBe('李泰拳')
    expect(isBoxingCommand('79\n名字（所有人）：泰拳,李泰拳\n日期：10月23\n人数：2')).toBe(false)
    expect(isBoxingCommand('79 客户：泰拳 今天 2人')).toBe(false)
    expect(isBoxingCommand('李泰拳 今天 1人')).toBe(false)
  })
  it.each(['备注：泰拳', '说明：MAX 泰拳', 'note: 泰拳'])('does not route based on %s', suffix => {
    expect(isBoxingCommand(`79 张三 今天 2人 ${suffix}`)).toBe(false)
    expect(isBoxingCommand(`泰拳 张三 今天 2人 ${suffix}`)).toBe(true)
    expect(() => parseBoxingCommand(`泰拳 张三 今天 2人 ${suffix}`, '2026-10-23')).toThrow('请移除备注')
  })
  it.each(['79 张三 今天 售价69 成本99 2人', '日期：2026年10月23日\n名字：张三\n人数：69', '泰拳课程 张三 今天 2人'])('does not identify numeric data or another product in %s as boxing', text => {
    expect(isBoxingCommand(text)).toBe(false)
  })
  it.each(['69 张三 今天 2人', '79 张三 今天 2人', '泰拳课程 张三 今天 2人', '泰拳 张三 今天 明天 2人', '泰拳 张三 今天 2人 3人', '泰拳 张三 2月30 2人', '泰拳 张三 今天 0人', '泰拳 张三 今天 -2人', '泰拳 张三 今天 2.5人', '泰拳 今天 2人'])('rejects invalid, ambiguous or mixed product input %s', text => {
    expect(() => parseBoxingCommand(text, '2026-10-23')).toThrow()
  })
  it('isolates boxing even with a historical daily snapshot, while preserving all backup and 79 data', () => {
    const rows = [row('69', '69秀'), row('79', '79秀'), row('boxing', 'MAX 泰拳'), row('ordinary', '普通门票')]
    expect(mainLedgerTickets(rows).map(item => item.id)).toEqual(['ordinary'])
    expect(ticketsForDailyStats(rows, '2026-10-23').map(item => item.id)).toEqual(['ordinary'])
    expect(ticketsInMonth(rows, '2026-10').map(item => item.id)).toEqual(['ordinary'])
    expect(ticketsInYear(rows, '2026').map(item => item.id)).toEqual(['ordinary'])
    for (const mode of ['day', 'month', 'range', 'all'] as const) {
      const report = buildReport(rows, { mode, date: '2026-10-23', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '' })
      expect(report.records.map(item => item.id)).toEqual(['ordinary'])
      expect(report.quantity.peopleCount).toBe(3)
      expect(report.summary.profitThb).toBe(300)
      expect(report.supplierStats[0].profitThb).toBe(300)
    }
    expect(buildProfitTrend(rows, '2026-10', '2026-10-23').current.totalProfitThb).toBe(300)
    expect(buildShow79Report(rows, '2026-10-23', '2026-10').records.map(item => item.id)).toEqual(['79'])
    expect(createLedgerBackup({ tickets: rows, projects: [], suppliers: [] }).tickets).toHaveLength(4)
  })
})
