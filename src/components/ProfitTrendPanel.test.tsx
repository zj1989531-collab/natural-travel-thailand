import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { ProfitTrendChart, ProfitTrendPanel } from './ProfitTrendPanel'
import { buildProfitTrend } from '../lib/profit-trend'

const row: TicketRecord = { id: 't', userId: 'u', supplierId: 's', supplierName: '供货商', projectId: 'p', projectName: '普通票', subItemName: '', issueDate: '2026-10-15', amountBasis: 'per_person', personCount: 3, agentPriceThb: 650, costThb: 600, note: '', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deletedAt: null, syncStatus: 'synced' }
describe('profit-only analysis card', () => {
  it('offers historical months, two separate series and accessible exact date details without exposing sales/costs', () => {
    const html = renderToStaticMarkup(<ProfitTrendPanel tickets={[row]} today="2026-10-15" />)
    for (const text of ['利润走势与对比', '分析月份', 'max="2026-10"', '返回本月', '2026-09-15', '日结利润', '月结利润', '非累计', 'role="img"', '查看日期', '展开每日明细', '不代表已到账', '未来日期记录', '฿150.00']) expect(html).toContain(text)
    for (const text of ['售价', '成本', '฿1,950.00', '฿1,800.00', 'NaN', 'Infinity']) expect(html).not.toContain(text)
    expect(html).not.toContain('<option value="2026-10-16"')
    expect(html).toContain('trend-monthly-line'); expect(html).toContain('trend-daily-line')
  })
  it('explains empty or offline data and pending changes instead of pretending they are cloud-confirmed', () => {
    const html = renderToStaticMarkup(<ProfitTrendPanel tickets={[]} today="2026-10-15" offline pendingCount={2} />)
    for (const text of ['本月截至今天暂无记录', '当前离线', '2 条资料待同步', '上期无记录', '฿0.00']) expect(html).toContain(text)
    expect(html).not.toContain('NaN'); expect(html).not.toContain('Infinity'); expect(html).not.toContain('0.0%')
  })
  it('explains a prior loss without showing an invalid percent, while showing valid negative current profit', () => {
    const html = renderToStaticMarkup(<ProfitTrendPanel tickets={[{ ...row, amountBasis: 'total', agentPriceThb: 0, costThb: 50 }, { ...row, id: 'prior', issueDate: '2026-09-15', amountBasis: 'total', agentPriceThb: 0, costThb: 100 }]} today="2026-10-15" />)
    expect(html).toContain('上期为亏损'); expect(html).toContain('-฿50.00'); expect(html).toContain('+฿50.00'); expect(html).not.toContain('%）')
  })
  it.each([[], [{ ...row, agentPriceThb: 500 }], [row], [row, { ...row, id: 'monthly', settlementMode: 'monthly' as const, agentPriceThb: 500 }]].map(rows => ({ rows })))('renders finite chart coordinates for zero, negative and mixed series', ({ rows }) => {
    const trend = buildProfitTrend(rows, '2026-10', '2026-10-15')
    const html = renderToStaticMarkup(<ProfitTrendChart trend={trend} selectedDate="2026-10-15" onSelect={() => {}} />)
    expect(html).not.toMatch(/NaN|Infinity/)
    expect(html).toContain('trend-zero')
  })
})
