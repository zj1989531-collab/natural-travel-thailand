import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { getBangkokDate } from '../lib/format'
import { Show79View } from './Show79View'

describe('79 show reporting screen', () => {
  it('shows standalone headcounts, real profit and the two agreed payees', () => {
    const date = getBangkokDate()
    const row: TicketRecord = { id: '79', userId: 'user', guestName: '<b>jimmy</b>', issueDate: date, supplierId: 'supplier', supplierName: '供货商', projectId: 'project', projectName: '79秀', subItemName: '门票', personCount: 2, amountBasis: 'per_person', agentPriceThb: 650, costThb: 600, note: '', createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z`, deletedAt: null, syncStatus: 'synced' }
    const html = renderToStaticMarkup(<Show79View tickets={[row]} projects={[]} onSave={async () => {}} onDelete={async () => {}} onRefund={() => {}} onCancelRefund={() => {}} onManageProjects={() => {}} />)
    for (const text of ['当日人数', '月人数', '月实际利润', 'jimmy · 40%', '大狗二狗合计 · 60%', '฿100.00', '฿40.00', '฿60.00', '预订单号留空', '一句话填写']) expect(html).toContain(text)
    expect(html).toContain('&lt;b&gt;jimmy&lt;/b&gt;')
    expect(html).not.toContain('<b>jimmy</b>')
    expect(html).toContain('不会向供应商下单')
  })
})
