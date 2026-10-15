import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildReport, type ReportQuery } from '../lib/reports'
import type { Project, TicketRecord } from '../types'
import { ReportPreview, ReportView } from './ReportView'

const record: TicketRecord = {
  id: 'test-ticket', userId: 'test-user', guestName: '李湘光、龙粉萍', issueDate: '2026-10-13', issueTime: '09:35', supplierId: 'test-supplier', supplierName: '测试供货商',
  projectId: 'test-project', projectName: '测试项目', subItemName: '成人票', personCount: 3, amountBasis: 'per_person',
  agentPriceThb: 650, costThb: 600, note: '测试备注', createdAt: '2026-10-13T02:35:00Z', updatedAt: '2026-10-13T02:35:00Z', deletedAt: null, syncStatus: 'synced'
}
const query: ReportQuery = { mode: 'month', month: '2026-10', date: '2026-10-13', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '' }
const render = (records: TicketRecord[], filter = query) => renderToStaticMarkup(<ReportPreview report={buildReport(records, filter)} supplierName="全部供货商" pendingCount={1} generatedAt="2026-10-13 22:00" />)

describe('online formatted report preview', () => {
  it('shows remaining ticket quantity and net profit after refund without leaking sales or costs', () => {
    const html = render([{ ...record, refunds: [{ id: 'refund-test', userId: record.userId, ticketId: record.id, personCount: 1, isFull: false, refundRevenueThb: 650, returnedCostThb: 550, refundDate: '2026-10-14', refundTime: '10:00', note: '', cancelledAt: null, createdAt: record.createdAt, updatedAt: record.updatedAt, syncStatus: 'synced' }] }])
    for (const text of ['门票 2 张', '已退1人', '฿50.00', '原出票日期']) expect(html).toContain(text)
    for (const text of ['฿1,300.00', '฿1,250.00', '总成本', '总销售额']) expect(html).not.toContain(text)
  })
  it('renders a named report, period, supplier summary, details, totals and sync warning', () => {
    const html = render([record])
    for (const text of ['出票盈利月报', '2026-10-01 — 2026-10-31', '客户姓名', '李湘光、龙粉萍', '供货商汇总', '报表记录明细', '测试项目 · 票', '测试备注', '09:35 曼谷', '已录人数', '门票 3 张', '待同步', '฿150.00']) expect(html).toContain(text)
    expect(html).toContain('<thead>')
    expect(html).toContain('<tfoot>')
    expect(html).toContain('scope="col"')
  })

  it.each(['day', 'month', 'range', 'all'] as const)('shows only financial profit in %s reports, including commission detail and print markup', (mode) => {
    const html = render([record, { ...record, id: 'commission', entryMode: 'profit_only', manualProfitThb: 50 }], { ...query, mode })
    for (const text of ['总代理售价', '总售价', '总成本', '总供货商成本', '฿1,950.00', '฿1,800.00']) expect(html).not.toContain(text)
    expect(html).toContain('฿150.00')
    expect(html).toContain('colSpan="4"')
    expect(html).not.toContain('colSpan="5"')
  })

  it('labels excluded daily commission separately and does not treat manual-only profit as sales', () => {
    const html = render([{ ...record, entryMode: 'profit_only', manualProfitThb: 50 }], { ...query, mode: 'day' })
    expect(html).toContain('月结项目另列 · 不计入日报合计')
    expect(html).toContain('当日月结记录（不计入日报合计）')
    expect(html).toContain('฿150.00')
    expect(html).toContain('当前范围没有计入本报表的记录')
  })

  it('handles empty reports and escapes record text instead of executing it', () => {
    expect(render([])).toContain('没有符合当前报表条件的记录')
    const html = render([{ ...record, note: '<script>alert(1)</script>' }])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('provides period and supplier controls and a user-triggered print button', () => {
    const html = renderToStaticMarkup(<ReportView tickets={[]} suppliers={[]} />)
    for (const text of ['格式化报表', '日报', '月报', '自定义日期范围', '全部日期（累计）', '客户姓名', '查询项目', '报表供货商', '导出当前报表 Excel', '打印 / 保存 PDF', '手机上可左右滑动表格']) expect(html).toContain(text)
    expect(html).toContain('type="month"')
  })

  it('shows a project query quantity even when that project profit is excluded from the daily total', () => {
    const html = render([{ ...record, projectName: '泰拳' }, { ...record, id: 'unknown', projectName: '泰拳', personCount: null }], { ...query, mode: 'day', projectName: '泰拳' })
    for (const text of ['项目：泰拳', '项目出票数量查询', '门票 3 张', '每日出票数量', '以上数量仅为已录部分', '月结项目另列']) expect(html).toContain(text)
    expect(html).not.toContain('3 张票')
  })

  it('lists unbooked catalogue projects and historical projects, grouping packages into one parent choice', () => {
    const catalog: Project = { id: 'catalog', userId: record.userId, name: '泰拳', normalizedName: '泰拳', supplierId: record.supplierId, supplierName: record.supplierName, subItemName: '成人', normalizedSubItemName: '成人', defaultCostThb: 600, defaultAgentPriceThb: 650, createdAt: record.createdAt, updatedAt: record.updatedAt, syncStatus: 'synced' }
    const html = renderToStaticMarkup(<ReportView tickets={[record]} suppliers={[]} projects={[catalog, { ...catalog, id: 'child', subItemName: '儿童' }]} />)
    expect(html.match(/<option value="泰拳">/g)).toHaveLength(1)
    expect(html).toContain('<option value="测试项目">')
  })

  it('shows missing customer names explicitly and preserves names on separately listed monthly rows', () => {
    const html = render([{ ...record, guestName: '  ' }, { ...record, id: 'monthly', guestName: 'Aditya', settlementMode: 'monthly' }], { ...query, mode: 'day' })
    expect(html).toContain('未填写')
    expect(html).toContain('有 1 条记录未填写客户姓名')
    expect(html).toContain('Aditya')
    expect(html).toContain('当日月结记录（不计入日报合计）')
  })

  it('escapes customer names and does not guess names from notes', () => {
    const html = render([{ ...record, guestName: '<img src=x onerror=alert(1)>' }])
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(render([{ ...record, guestName: undefined, note: '客户可能叫张三' }])).toContain('class="muted">未填写</span>')
  })
})
