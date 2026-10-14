import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { SummaryPanel } from './SummaryPanel'

const ticket: TicketRecord = { id: 'test-ticket', userId: 'test-user', issueDate: '2026-10-14', supplierId: 'test-supplier', supplierName: '测试供货商', projectId: null, projectName: '测试门票', subItemName: '', personCount: 2, amountBasis: 'per_person', agentPriceThb: 1550, costThb: 1450, note: '', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', deletedAt: null, syncStatus: 'synced' }

describe('profit-only homepage summaries', () => {
  it.each(['今日概览', '本月月报', '年度年报'])('shows only profit as money in %s, retaining ticket count and period notes', (title) => {
    const html = renderToStaticMarkup(<SummaryPanel title={title} subtitle="2026-10" tickets={[ticket]} note="按出票日期统计" />)
    for (const text of [title, '利润', '฿200.00', '门票 2 张', '2026-10', '按出票日期统计']) expect(html).toContain(text)
    for (const text of ['代理售价', '供货商成本', '฿3,100.00', '฿2,900.00']) expect(html).not.toContain(text)
    expect(html.match(/class="metric-card/g)).toHaveLength(1)
    expect(ticket.agentPriceThb).toBe(1550)
    expect(ticket.costThb).toBe(1450)
  })
  it('shows a loss clearly without hiding a negative profit or exposing original amounts', () => {
    const html = renderToStaticMarkup(<SummaryPanel title="今日概览" subtitle="TODAY" tickets={[{ ...ticket, agentPriceThb: 1350 }]} />)
    expect(html).toContain('metric-card loss')
    expect(html).toContain('-฿200.00')
    expect(html).not.toContain('฿2,900.00')
  })
  it('shows zero profit for an empty period', () => {
    const html = renderToStaticMarkup(<SummaryPanel title="今日概览" subtitle="TODAY" tickets={[]} />)
    expect(html).toContain('฿0.00')
    expect(html).toContain('0 张')
  })
})
