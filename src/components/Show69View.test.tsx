import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { getBangkokDate } from '../lib/format'
import { Show69View } from './Show69View'

const record = (overrides: Partial<TicketRecord> = {}): TicketRecord => {
  const date = getBangkokDate()
  return { id: '69', userId: 'user', guestName: '韩廷富,邵建华,江华兴', issueDate: date, supplierId: 'internal-supplier', supplierName: '内部供应商不可展示', projectId: 'internal-project', projectName: '69秀', subItemName: '独立记录', personCount: 3, amountBasis: 'total', agentPriceThb: 9999, costThb: 8888, note: '内部财务备注不可展示', createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z`, deletedAt: null, syncStatus: 'synced', ...overrides }
}
const render = (tickets: TicketRecord[]) => renderToStaticMarkup(<Show69View tickets={tickets} onSave={async () => tickets[0]} onDelete={async () => {}} />)

describe('69秀独立记录页面', () => {
  it('provides only the requested date, all names and headcount without ticket generation or money fields', () => {
    const html = render([record()])
    for (const value of ['69秀', '一键填写信息', '日期', '名字（所有人）', '人数', '保存记录', '不计入主账本每日统计', '韩廷富,邵建华,江华兴', '3 人']) expect(html).toContain(value)
    for (const value of ['确认单', '生成图片', '打印', '供货商', '售价', '成本', '月度分账', '内部供应商不可展示', '内部财务备注不可展示', '9999', '8888']) expect(html).not.toContain(value)
    expect(html).toContain('type="date"')
    expect(html).toContain('type="number"')
    expect(html).toContain('全部记录')
  })

  it('shows only active 69秀 records in the current month and escapes every guest name', () => {
    const html = render([
      record({ guestName: '<b>张三</b>,李四' }),
      record({ id: '79', projectName: '79秀', guestName: '其他项目姓名' }),
      record({ id: 'deleted', guestName: '已删除姓名', deletedAt: '2026-01-01T00:00:00Z' }),
      record({ id: 'old', issueDate: '2020-01-01', guestName: '其他月份姓名' })
    ])
    expect(html).toContain('&lt;b&gt;张三&lt;/b&gt;,李四')
    expect(html).not.toContain('<b>张三</b>')
    for (const value of ['其他项目姓名', '已删除姓名', '其他月份姓名']) expect(html).not.toContain(value)
    expect(html).toContain('当前范围 1 条记录')
  })

  it('keeps legacy records with refund history read-only', () => {
    const html = render([record({ refunds: [{ id: 'refund', userId: 'user', ticketId: '69', personCount: 1, isFull: false, refundRevenueThb: 1, returnedCostThb: 1, refundDate: getBangkokDate(), refundTime: '12:00', note: '', cancelledAt: null, createdAt: '', updatedAt: '', syncStatus: 'synced' }] })])
    expect(html).toContain('此记录已有退票明细，保留原记录。')
    expect(html).toContain('disabled="">编辑</button>')
    expect(html).toContain('disabled="">删除</button>')
  })

  it('prefills all three fields when the main entry routes recognized 69秀 information here', () => {
    const html = renderToStaticMarkup(<Show69View tickets={[]} initialInput={{ date: '2026-11-02', guestName: '王一,王二,王三', people: 3 }} onSave={async () => record()} onDelete={async () => {}} />)
    expect(html).toContain('已填入69秀信息，请核对日期、所有人姓名和人数后保存。')
    expect(html).toContain('value="2026-11-02"')
    expect(html).toContain('王一,王二,王三</textarea>')
    expect(html).toContain('step="1" value="3"')
  })
})
