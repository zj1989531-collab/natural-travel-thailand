import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TicketRecord } from '../types'
import type { Show79SettlementRecord } from '../lib/show79-settlement'
import { Show79SettlementPanel } from './Show79SettlementPanel'

const ticket: TicketRecord = { id: 'ticket', userId: 'user', issueDate: '2026-10-15', projectId: 'project', projectName: '79秀', subItemName: '门票', supplierId: 'supplier', supplierName: '供货商', agentPriceThb: 100, costThb: 0, amountBasis: 'total', personCount: 2, note: '', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', deletedAt: null, syncStatus: 'synced' }
const payment: Show79SettlementRecord = { id: 'payment', userId: 'user', month: '2026-10', snapshotProfitThb: 100, snapshotJimmyThb: 40, snapshotPartnersThb: 60, jimmyPaidThb: 40, partnersPaidThb: 60, paymentDate: '2026-10-16', note: '<script>付款备注</script>', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', syncStatus: 'synced' }

describe('79 show settlement panel', () => {
  it('starts compact and shows computed shares without creating a payment', () => {
    const onSave = vi.fn(async () => {})
    const html = renderToStaticMarkup(<Show79SettlementPanel tickets={[ticket]} records={[]} month="2026-10" onSave={onSave} />)
    for (const text of ['本月结算：未结算', 'jimmy · 40%', '大狗二狗合计 · 60%', '฿40.00', '฿60.00', '尚应付', '累计净已付', '登记本次分账', '尚未登记分账', '不会自动转账']) expect(html).toContain(text)
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[ =])/)
    expect(onSave).not.toHaveBeenCalled()
  })
  it('preserves adjustment controls and history after a month has been settled', () => {
    const html = renderToStaticMarkup(<Show79SettlementPanel tickets={[ticket]} records={[payment]} month="2026-10" onSave={async () => {}} />)
    for (const text of ['本月结算：已结清', '实际付款日期', '2026/10/16', '登记时快照', '本次实际金额', '登记本次分账', '填入当前差额']) expect(html).toContain(text)
    expect(html).toContain('&lt;script&gt;付款备注&lt;/script&gt;')
    expect(html).not.toContain('<script>付款备注</script>')
    expect(html).not.toContain('disabled=""')
  })
  it('labels overpaid balances as recoveries and keeps original snapshots visible', () => {
    const html = renderToStaticMarkup(<Show79SettlementPanel tickets={[{ ...ticket, agentPriceThb: 50 }]} records={[payment]} month="2026-10" onSave={async () => {}} />)
    for (const text of ['本月结算：待调整', '应收回', '฿20.00', '฿30.00', '登记时快照', '฿100.00', '负数表示已收回或冲正']) expect(html).toContain(text)
    expect(html).toContain('value="-20.00"')
    expect(html).toContain('value="-30.00"')
  })
  it('does not count unconfirmed legacy history as paid and keeps it visibly separate', () => {
    const pending = { ...payment, id: 'legacy-local', syncStatus: 'pending' as const }
    const html = renderToStaticMarkup(<Show79SettlementPanel tickets={[ticket]} records={[pending]} financialReviewMessage="历史 79 分账 2026-10-16 的云端回执与本机记录不一致；请先人工核对。" month="2026-10" onSave={async () => {}} />)
    expect(html).toContain('本月结算：未结算')
    expect(html).toContain('待核对的历史分账 · 1 笔')
    expect(html).toContain('未计入“累计净已付”或本月差额')
    expect(html).toContain('新的分账登记已暂时锁定')
    expect(html).toContain('历史分账需要人工核对')
    expect(html).toContain('value="40.00"')
    expect(html).toContain('value="60.00"')
    expect(html).not.toContain('本月结算：已结清')
    expect(html).not.toContain('登记本次分账')
  })
  it('disables registration while unavailable and handles an invalid month visibly', () => {
    const html = renderToStaticMarkup(<Show79SettlementPanel tickets={[]} records={[]} month="2026-10" disabled onSave={async () => {}} />)
    expect(html).toContain('<fieldset disabled="">')
    expect(html).toContain('当前暂不能登记')
    const invalid = renderToStaticMarkup(<Show79SettlementPanel tickets={[]} records={[]} month="" onSave={async () => {}} />)
    expect(invalid).toContain('本月结算：无法计算')
    expect(invalid).toContain('role="alert"')
  })
})
