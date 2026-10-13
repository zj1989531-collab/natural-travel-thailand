import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RefundRecord, TicketRecord } from '../types'
import { RefundHistory, RefundSheet } from './RefundSheet'

const ticket: TicketRecord = { id: 'ticket-test', userId: 'user-test', issueDate: '2026-10-13', personCount: 3, amountBasis: 'per_person', projectId: null, projectName: '测试门票', subItemName: '', supplierId: 'supplier-test', supplierName: '测试供货商', agentPriceThb: 650, costThb: 600, note: '', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', deletedAt: null, syncStatus: 'synced' }
const refund: RefundRecord = { id: 'refund-test', userId: ticket.userId, ticketId: ticket.id, personCount: 3, isFull: true, refundRevenueThb: 1950, returnedCostThb: 1800, refundDate: '2026-10-14', refundTime: '10:00', note: '<script>test</script>', cancelledAt: null, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, syncStatus: 'synced' }

describe('refund form and preserved history', () => {
  it('provides the original-ticket choice, Bangkok date/time and editable actual total amounts', () => {
    const html = renderToStaticMarkup(<RefundSheet tickets={[ticket]} initialTicketId={ticket.id} onClose={() => {}} onSave={async () => {}} />)
    for (const label of ['办理退票', '原出票记录', '退票时间（曼谷）', '退票范围', '部分退票', '本次退给代理（THB，总额）', '本次供货商返还（THB，总额）', '将重算', '2026-10-13', '不会实际转账', '退票后原票利润']) expect(html).toContain(label)
    expect(html).toContain('value="1950"')
    expect(html).toContain('value="1800"')
    expect(html).toContain('aria-modal="true"')
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
})
