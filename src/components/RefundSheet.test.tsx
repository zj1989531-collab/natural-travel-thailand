import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefundInput, RefundRecord, TicketRecord } from '../types'
import { matchesRefundTicketSearch, refundConfirmationText, RefundHistory, RefundSheet } from './RefundSheet'

const ticket: TicketRecord = { id: 'ticket-test', userId: 'user-test', guestName: '李湘光', issueDate: '2026-10-13', personCount: 3, amountBasis: 'per_person', projectId: null, projectName: '测试门票', subItemName: '', supplierId: 'supplier-test', supplierName: '测试供货商', agentPriceThb: 650, costThb: 600, note: '', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', deletedAt: null, syncStatus: 'synced' }
const refund: RefundRecord = { id: 'refund-test', userId: ticket.userId, ticketId: ticket.id, personCount: 3, isFull: true, refundRevenueThb: 1950, returnedCostThb: 1800, refundDate: '2026-10-14', refundTime: '10:00', note: '<script>test</script>', cancelledAt: null, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, syncStatus: 'synced' }

describe('refund form and preserved history', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T03:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('provides the original-ticket choice, Bangkok date/time and editable actual total amounts', () => {
    const html = renderToStaticMarkup(<RefundSheet tickets={[ticket]} initialTicketId={ticket.id} onClose={() => {}} onSave={async () => {}} />)
    for (const label of ['办理退票', '原出票记录', '退票时间（曼谷）', '退票范围', '部分退票', '本次退给代理（THB，总额）', '本次供货商返还（THB，总额）', '将重算', '2026-10-13', '不会实际转账', '退票后原票利润']) expect(html).toContain(label)
    expect(html).toContain('value="1950"')
    expect(html).toContain('value="1800"')
    expect(html).toContain('aria-modal="true"')
  })
  it('keeps independent Koh Larn and carnival tickets available when their dedicated ledger opens the refund sheet', () => {
    const independent = [
      { ...ticket, id: 'koh-larn', projectName: '格兰岛跟团一日游' },
      { ...ticket, id: 'carnival', projectName: '东方嘉年华' }
    ]
    const html = renderToStaticMarkup(<RefundSheet tickets={independent} initialTicketId="koh-larn" onClose={() => {}} onSave={async () => {}} />)
    expect(html).toContain('<option value="koh-larn" selected="">')
    expect(html).toContain('格兰岛跟团一日游')
    expect(html).toContain('东方嘉年华')
    expect(html).toContain('原票归属日期：2026-10-13')
    expect(html).toContain('将更新本独立账本中原出票日期的记录与利润')
  })
  it('does not offer full-refunded, deleted or profit-only records', () => {
    const html = renderToStaticMarkup(<RefundSheet tickets={[{ ...ticket, refunds: [refund] }, { ...ticket, id: 'deleted', deletedAt: ticket.updatedAt }, { ...ticket, id: 'manual', entryMode: 'profit_only' }]} onClose={() => {}} onSave={async () => {}} />)
    expect(html).toContain('没有符合条件的可退票记录')
    expect(html).not.toContain('<option value="ticket-test">')
    expect(html).not.toContain('<option value="deleted">')
    expect(html).not.toContain('<option value="manual">')
  })
  it('retains voided rows without a second void button, escaping notes', () => {
    const html = renderToStaticMarkup(<RefundHistory ticket={{ ...ticket, refunds: [{ ...refund, cancelledAt: ticket.updatedAt }] }} onCancel={() => {}} />)
    expect(html).toContain('已撤销')
    expect(html).toContain('含撤销')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('撤销此退票')
  })
  it('finds a ticket by customer name while retaining date, project, supplier and note searches', () => {
    const named = { ...ticket, guestName: 'Jimmy 李湘光', subItemName: '普通座', note: '接送说明' }
    for (const query of ['李湘', ' jimmy ', 'ＪＩＭＭＹ', '2026-10-13', '测试门票', '普通座', '测试供货商', '接送说明', '']) expect(matchesRefundTicketSearch(named, query)).toBe(true)
    expect(matchesRefundTicketSearch(named, '其他客户')).toBe(false)
  })
  it('shows escaped customer names in both candidate tickets and the selected summary', () => {
    const html = renderToStaticMarkup(<RefundSheet tickets={[{ ...ticket, guestName: '<b>李湘光</b>' }]} initialTicketId={ticket.id} onClose={() => {}} onSave={async () => {}} />)
    expect(html).toMatch(/<option[^>]*>&lt;b&gt;李湘光&lt;\/b&gt; · 2026-10-13/)
    expect(html).toContain('客户：<strong>&lt;b&gt;李湘光&lt;/b&gt;</strong>')
    expect(html).toContain('搜索客户、日期、项目、供货商或备注')
    expect(html).not.toContain('<b>李湘光</b>')
    const unnamed = renderToStaticMarkup(<RefundSheet tickets={[{ ...ticket, guestName: '  ' }]} initialTicketId={ticket.id} onClose={() => {}} onSave={async () => {}} />)
    expect(unnamed).toContain('客户：<strong>姓名未填写</strong>')
  })
  it('defaults a future-viewing ticket refund to actual Bangkok today without the ticket-date minimum', () => {
    const html = renderToStaticMarkup(<RefundSheet tickets={[{ ...ticket, projectName: '79秀', issueDate: '2026-11-20' }]} initialTicketId={ticket.id} onClose={() => {}} onSave={async () => {}} />)
    const dateInput = html.match(/<input type="date"[^>]*>/)?.[0]
    expect(dateInput).toContain('value="2026-10-16"')
    expect(dateInput).toContain('max="2026-10-16"')
    expect(dateInput).not.toContain('min=')
    expect(html).toContain('原票归属日期：2026-11-20')
    expect(html).toContain('可早于观看／出行日期')
    expect(html).toContain('将更新本独立账本中原出票日期的记录与利润')
  })
  it('includes the customer and separate original/actual dates in the final confirmation', () => {
    const input: RefundInput = { ...refund, operationId: refund.id, refundDate: '2026-10-16', note: '' }
    const confirmation = refundConfirmationText({ ...ticket, issueDate: '2026-11-20', projectName: '79秀' }, input, 50)
    for (const text of ['客户：李湘光', '原票：2026-11-20 · 79秀', '实际退款：2026-10-16 10:00（曼谷）', '฿1,950.00', '฿1,800.00', '฿50.00', '将回算原票日期和原月份']) expect(confirmation).toContain(text)
  })
  it('keeps an old future-dated refund visible and available for cancellation without rewriting history', () => {
    const historical = { ...refund, refundDate: '2026-11-20' }
    const html = renderToStaticMarkup(<RefundHistory ticket={{ ...ticket, refunds: [historical] }} onCancel={() => {}} />)
    expect(html).toContain('2026-11-20')
    expect(html).toContain('撤销此退票')
    expect(historical.refundDate).toBe('2026-11-20')
  })
})
