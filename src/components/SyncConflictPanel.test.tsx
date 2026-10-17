import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Project, RefundRecord, Supplier, TicketRecord } from '../types'
import type { SyncConflictRecord } from '../lib/sync-conflicts'
import { SyncConflictPanel, syncConflictLocalText, syncConflictSnapshotFields } from './SyncConflictPanel'

const ticket: TicketRecord = {
  id: 'ticket-a', userId: 'owner-a', guestName: '李湘光、龙粉萍', issueDate: '2026-10-16', issueTime: '09:35',
  supplierId: 'supplier-a', supplierName: '供货商甲', projectId: 'project-a', projectName: '泰拳', subItemName: 'VIP',
  personCount: 3, amountBasis: 'per_person', agentPriceThb: 650, costThb: 600, note: '本机备注',
  createdAt: '2026-10-16T02:35:00Z', updatedAt: '2026-10-16T03:00:00Z', deletedAt: null, syncStatus: 'pending', refunds: []
}
const refund: RefundRecord = {
  id: 'refund-a', userId: ticket.userId, ticketId: ticket.id, personCount: 1, isFull: false,
  refundRevenueThb: 650, returnedCostThb: 600, refundDate: '2026-10-16', refundTime: '10:15', note: '退一位',
  cancelledAt: null, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, syncStatus: 'pending'
}
const conflict: SyncConflictRecord = {
  id: 'conflict-a', userId: ticket.userId, table: 'tickets', recordId: ticket.id, reason: 'remote_newer',
  message: '另一台设备已更新', localRecord: ticket, remoteRecord: { ...ticket, guestName: 'Aditya', personCount: 2, note: '云端备注', syncStatus: 'synced' },
  createdAt: '2026-10-16T03:01:00Z', resolvedAt: null
}

describe('sync conflict comparison panel', () => {
  it('shows both business snapshots and explains the manual resolution without performing a write', () => {
    const onResolve = vi.fn(async () => {})
    const html = renderToStaticMarkup(<SyncConflictPanel records={[conflict]} onClose={() => {}} onResolve={onResolve} />)
    for (const text of ['role="dialog"', 'aria-modal="true"', '同步冲突核对', '本机保存的修改副本', '核对时取得的云端记录', '李湘光、龙粉萍', 'Aditya', '2026-10-16', '09:35', '泰拳', 'VIP', '供货商甲', '本机备注', '云端备注', '云端已有更新', '另一台设备已更新', '复制本机内容', '保留当前账本并标记已核对', '不会自动用本机内容覆盖云端', '从活动账本移除', '之后已再编辑的内容保留', '当前设备']) expect(html).toContain(text)
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('starts with pending copies and keeps processed history separate', () => {
    const resolved: SyncConflictRecord = { ...conflict, id: 'processed', localRecord: { ...ticket, guestName: '已核对客户' }, resolvedAt: '2026-10-16T04:00:00Z' }
    const html = renderToStaticMarkup(<SyncConflictPanel records={[conflict, resolved]} onClose={() => {}} onResolve={async () => {}} />)
    expect(html).toContain('待核对 · 1')
    expect(html).toContain('已处理历史 · 1')
    expect(html).not.toContain('已核对客户')
    expect(renderToStaticMarkup(<SyncConflictPanel records={[resolved]} onClose={() => {}} onResolve={async () => {}} />)).toContain('没有待核对的副本')
  })

  it('does not confuse a missing cloud snapshot with a deleted cloud record or render text as HTML', () => {
    const row: SyncConflictRecord = { ...conflict, reason: 'refund_locked', message: '<script>bad()</script>', remoteRecord: null, localRecord: { ...ticket, note: '<img src=x onerror=bad()>' } }
    const html = renderToStaticMarkup(<SyncConflictPanel records={[row]} onClose={() => {}} onResolve={async () => {}} />)
    expect(html).toContain('未取得可显示的云端记录')
    expect(html).toContain('这不代表云端记录已删除')
    expect(html).toContain('原票已有退票，修改未被接受')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
  })

  it('shows actual refund-adjusted totals and preserves legacy whole-order amounts', () => {
    const partial = Object.fromEntries(syncConflictSnapshotFields({ ...ticket, refunds: [refund] }))
    expect(partial).toMatchObject({ '原人数／数量': '3 人', '有效人数／数量': '2 人', '每人售价': '฿650.00', '实际总售价': '฿1,300.00', '实际总成本': '฿1,200.00', '实际利润': '฿100.00', '退票状态': '部分退票 · 已退 1 人' })
    const legacy = Object.fromEntries(syncConflictSnapshotFields({ ...ticket, amountBasis: undefined }))
    expect(legacy).toMatchObject({ '计价方式': '整单总额', '实际总售价': '฿650.00', '实际总成本': '฿600.00', '实际利润': '฿50.00' })
    const incomplete = Object.fromEntries(syncConflictSnapshotFields({ ...ticket, agentPriceThb: Number.NaN }))
    expect(incomplete['每人售价']).toBe('未填写')
    expect(incomplete['实际利润']).toBe('金额或数量未填完整')
  })

  it('labels missing refund details as unknown and copies original amounts instead of claiming a net profit', () => {
    const row = { ...conflict, reason: 'refund_locked' as const, localRecord: { ...ticket, refunds: undefined } }
    const fields = Object.fromEntries(syncConflictSnapshotFields(row.localRecord))
    expect(fields).toMatchObject({ '原票总售价': '฿1,950.00', '原票总成本': '฿1,800.00', '原票利润': '฿150.00', '退票状态': '未附退票明细，待核对', '净额说明': '此副本未包含退票明细，请以当前订单核对净额' })
    expect(fields['实际利润']).toBeUndefined()
    expect(fields['实际总售价']).toBeUndefined()
    expect(syncConflictLocalText(row)).toContain('原票利润：฿150.00')
    expect(syncConflictLocalText(row)).not.toContain('实际利润：')
    expect(syncConflictLocalText(row)).not.toContain('退票状态：未退票')
  })

  it('distinguishes commission, goods and refund fields instead of multiplying every amount by people', () => {
    const commission = Object.fromEntries(syncConflictSnapshotFields({ ...ticket, entryMode: 'profit_only', manualProfitThb: 20 }))
    expect(commission).toMatchObject({ '填写的利润': '฿20.00', '实际利润': '฿60.00', '有效人数／数量': '仅录利润，不计人数／数量' })
    expect(commission['每人售价']).toBeUndefined()
    expect(Object.fromEntries(syncConflictSnapshotFields({ ...ticket, quantityUnit: 'item', personCount: 0 }))).toMatchObject({ '原人数／数量': '0 件', '每件成本': '฿600.00' })
    const refundFields = Object.fromEntries(syncConflictSnapshotFields(refund))
    expect(refundFields).toMatchObject({ '原票编号': ticket.id, '退给代理': '฿650.00', '供货商返还': '฿600.00', '本次利润影响': '-฿50.00', '退票状态': '有效' })
    expect(Object.fromEntries(syncConflictSnapshotFields({ ...refund, cancelledAt: ticket.updatedAt }))['本次利润影响']).toBe('已撤销，不计影响')
  })

  it('displays project and supplier conflicts with their own catalogue fields and copies only the local snapshot', () => {
    const project: Project = { id: 'project-a', userId: ticket.userId, supplierId: ticket.supplierId, supplierName: ticket.supplierName, name: '药品', normalizedName: '药品', subItemName: '试剂盒', normalizedSubItemName: '试剂盒', quantityUnit: 'item', manualAgentPrice: true, defaultAgentPriceThb: 0, defaultCostThb: 120, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, syncStatus: 'pending' }
    expect(Object.fromEntries(syncConflictSnapshotFields(project))).toMatchObject({ '项目': '药品', '套餐': '试剂盒', '数量单位': '件', '默认售价': '需手动填写', '默认成本': '฿120.00' })
    const supplier: Supplier = { id: 'supplier-a', userId: ticket.userId, name: '供货商新名称', normalizedName: '供货商新名称', createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, syncStatus: 'pending' }
    expect(Object.fromEntries(syncConflictSnapshotFields(supplier))['供货商名称']).toBe('供货商新名称')
    const text = syncConflictLocalText(conflict)
    expect(text).toContain('客户姓名：李湘光、龙粉萍')
    expect(text).toContain('实际利润：฿150.00')
    expect(text).toContain('备注：本机备注')
    expect(text).not.toContain('云端备注')
    expect(text).not.toContain('Aditya')
  })
})
