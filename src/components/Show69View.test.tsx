import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Project, TicketRecord } from '../types'
import { formatThb, getBangkokDate } from '../lib/format'
import { parseBoxingCommand } from '../lib/boxing'
import { Show69View } from './Show69View'

const record = (overrides: Partial<TicketRecord> = {}): TicketRecord => {
  const date = getBangkokDate()
  return { id: '69', userId: 'user', guestName: '韩廷富,邵建华,江华兴', issueDate: date, supplierId: 'internal-supplier', supplierName: '内部供应商不可展示', projectId: 'internal-project', projectName: '69秀', subItemName: '独立记录', personCount: 3, amountBasis: 'total', agentPriceThb: 9999, costThb: 8888, note: '内部财务备注不可展示', createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z`, deletedAt: null, syncStatus: 'synced', ...overrides }
}
const render = (tickets: TicketRecord[], kind: 'show69' | 'boxing' = 'show69') => renderToStaticMarkup(<Show69View kind={kind} tickets={tickets} onSave={async () => tickets[0]} onDelete={async () => {}} />)

describe('69秀独立记录页面', () => {
  it('provides record fields and automatic read-only prices without ticket generation or settlement', () => {
    const html = render([record()])
    for (const value of ['69秀', '一键填写信息', '日期', '名字（所有人）', '人数', '保存记录', '不计入主账本每日统计', '韩廷富,邵建华,江华兴', '3 人']) expect(html).toContain(value)
    for (const value of ['确认单', '生成图片', '打印', '月度分账', '内部供应商不可展示', '内部财务备注不可展示']) expect(html).not.toContain(value)
    expect(html).toContain('自动匹配价格')
    expect(html).toContain('净售价 ' + formatThb(9999))
    expect(html).toContain('净成本 ' + formatThb(8888))
    expect(html).toContain('type="date"')
    expect(html).toContain('type="number"')
    expect(html).toContain('全部记录')
  })

  it('shows only active 69秀 records in the current month and escapes every guest name', () => {
    const html = render([
      record({ guestName: '<b>张三</b>,李四' }),
      record({ id: '79', projectName: '79秀', guestName: '其他项目姓名' }),
      record({ id: 'boxing', projectName: '泰拳', guestName: '泰拳客户姓名' }),
      record({ id: 'deleted', guestName: '已删除姓名', deletedAt: '2026-01-01T00:00:00Z' }),
      record({ id: 'old', issueDate: '2020-01-01', guestName: '其他月份姓名' })
    ])
    expect(html).toContain('&lt;b&gt;张三&lt;/b&gt;,李四')
    expect(html).not.toContain('<b>张三</b>')
    for (const value of ['其他项目姓名', '泰拳客户姓名', '已删除姓名', '其他月份姓名']) expect(html).not.toContain(value)
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

describe('泰拳独立记录页面', () => {
  it('uses the shared three-field form with boxing labels and isolates its records from both shows', () => {
    const html = render([
      record({ id: 'boxing', projectName: '泰拳', guestName: '泰拳客户甲,泰拳客户乙', personCount: 2 }),
      record({ id: '69', guestName: '六九客户' }),
      record({ id: '79', projectName: '79秀', guestName: '七九客户' }),
      record({ id: 'deleted', projectName: '泰拳', guestName: '已删除泰拳客户', deletedAt: '2026-01-01T00:00:00Z' }),
      record({ id: 'old', projectName: '泰拳', issueDate: '2020-01-01', guestName: '其他月份泰拳客户' })
    ], 'boxing')
    for (const value of ['<h1>泰拳</h1>', '新增泰拳记录', '泰拳记录格式', '泰拳客户甲,泰拳客户乙', '2 人', '当前范围 1 条记录', '不计入主账本每日统计']) expect(html).toContain(value)
    for (const value of ['69秀', '79秀', '六九客户', '七九客户', '已删除泰拳客户', '其他月份泰拳客户', '确认单', '内部供应商不可展示', '内部财务备注不可展示']) expect(html).not.toContain(value)
    expect(html).toContain('aria-describedby="boxing-command-help"')
  })

  it('prefills the shared form from a pasted boxing template without changing its names or count', () => {
    const initialInput = parseBoxingCommand('泰拳记录格式\n日期：10月23\n名字（所有人）：韩廷富,邵建华,江华兴\n人数：3', '2026-10-23')
    const html = renderToStaticMarkup(<Show69View kind="boxing" tickets={[]} initialInput={initialInput} onSave={async () => record({ projectName: '泰拳' })} onDelete={async () => {}} />)
    expect(html).toContain('已填入泰拳信息，请核对日期、所有人姓名和人数后保存。')
    expect(html).toContain('value="2026-10-23"')
    expect(html).toContain('韩廷富,邵建华,江华兴</textarea>')
    expect(html).toContain('step="1" value="3"')
    expect(html).toContain('当前范围没有泰拳记录。')
    expect(html).not.toContain('69秀')
    expect(html).toContain('请选择亚洲人或欧美人票种，系统将自动带入对应价格。')
  })
})

describe('主账本月结项目页面', () => {
  it.each([
    { kind: 'kohlarn' as const, title: '格兰岛一日游', name: '格兰岛跟团一日游', subItemName: 'C套餐', agentPriceThb: 850, costThb: 720 },
    { kind: 'carnival' as const, title: '东方嘉年华', name: '东方嘉年华', subItemName: 'VIP', agentPriceThb: 1200, costThb: 990 }
  ])('uses the same paste-first monthly form for $title while keeping it in the main ledger', ({ kind, title, name, subItemName, agentPriceThb, costThb }) => {
    const monthlyProject = project({ id: kind, name, normalizedName: name, subItemName, normalizedSubItemName: subItemName, defaultAgentPriceThb: agentPriceThb, defaultCostThb: costThb })
    const html = renderToStaticMarkup(<Show69View kind={kind} tickets={[]} projects={[monthlyProject]} initialInput={{ date: getBangkokDate(), guestName: '向绍平', people: 1, projectId: kind }} onSave={async () => record({ projectName: name, subItemName })} onDelete={async () => {}} />)
    for (const value of [title, '一键填写信息', '日期', '名字（所有人）', '人数', '主账本 · 月结', '计入所属月报和年报', '价格套餐：星光旅行社', subItemName, formatThb(agentPriceThb), formatThb(costThb)]) expect(html).toContain(value)
    expect(html).not.toContain('不计入主账本每日统计、月报、年报及排行')
  })
})

const project = (overrides: Partial<Project> = {}): Project => ({ id: 'show69-price', userId: 'user', name: '69秀', normalizedName: '69秀', supplierId: 'starlight', supplierName: '星光旅行社', subItemName: '', normalizedSubItemName: '', defaultAgentPriceThb: 430, defaultCostThb: 400, defaultAmountBasis: 'per_person', entryMode: 'standard', quantityUnit: 'person', settlementMode: 'monthly', createdAt: '', updatedAt: '', syncStatus: 'synced', ...overrides })
const priceProjects = [project(), project({ id: 'asian-price', name: '泰拳', normalizedName: '泰拳', subItemName: '亚洲面孔', normalizedSubItemName: '亚洲面孔', defaultAgentPriceThb: 650, defaultCostThb: 620 }), project({ id: 'western-price', name: '泰拳', normalizedName: '泰拳', subItemName: '欧美面孔', normalizedSubItemName: '欧美面孔', defaultAgentPriceThb: 900, defaultCostThb: 850 })]

describe('月结票价格匹配与历史金额', () => {
  it('automatically matches the real 69秀 project and multiplies its unit prices by all three people', () => {
    const html = renderToStaticMarkup(<Show69View tickets={[]} projects={priceProjects} initialInput={{ date: getBangkokDate(), guestName: '甲,乙,丙', people: 3 }} onSave={async () => record()} onDelete={async () => {}} />)
    expect(html).toContain('价格套餐：星光旅行社 · 69秀')
    expect(html).toContain('3 人合计')
    for (const amount of [430, 400, 30, 1290, 1200, 90]) expect(html).toContain(formatThb(amount))
    expect(html).not.toContain('请选择本次价格套餐')
  })

  it('uses the fixed 69秀 prices when there is no real price catalogue', () => {
    const html = renderToStaticMarkup(<Show69View tickets={[]} initialInput={{ date: getBangkokDate(), guestName: '甲,乙', people: 2 }} onSave={async () => record()} onDelete={async () => {}} />)
    for (const amount of [430, 400, 30, 860, 800, 60]) expect(html).toContain(formatThb(amount))
  })

  it('requires a category for boxing without inferring it from the guests names', () => {
    const html = renderToStaticMarkup(<Show69View kind="boxing" tickets={[]} projects={priceProjects} initialInput={{ date: getBangkokDate(), guestName: '张三,John Smith', people: 2 }} onSave={async () => record({ projectName: '泰拳' })} onDelete={async () => {}} />)
    expect(html).toContain('请选择亚洲人或欧美人票种')
    expect(html).toContain('<option value="" disabled="" selected="">请选择亚洲人或欧美人</option>')
    expect(html).not.toContain('aria-label="自动匹配价格"')
  })

  it.each([
    { category: 'asian' as const, people: 3, unit: [650, 620, 30], totals: [1950, 1860, 90], label: '亚洲面孔' },
    { category: 'western' as const, people: 2, unit: [900, 850, 50], totals: [1800, 1700, 100], label: '欧美面孔' }
  ])('matches the $category boxing category and calculates headcount totals', ({ category, people, unit, totals, label }) => {
    const html = renderToStaticMarkup(<Show69View kind="boxing" tickets={[]} projects={priceProjects} initialInput={{ date: getBangkokDate(), guestName: '甲,乙', people, boxingCategory: category }} onSave={async () => record({ projectName: '泰拳' })} onDelete={async () => {}} />)
    expect(html).toContain(`价格套餐：星光旅行社 · 泰拳 · ${label}`)
    expect(html).toContain(`<option value="${category}" selected="">`)
    expect(html).toContain(`${people} 人合计`)
    for (const amount of [...unit, ...totals]) expect(html).toContain(formatThb(amount))
  })

  it('prefills explicit boxing category from the pasted template and matches its price', () => {
    const initialInput = parseBoxingCommand('泰拳记录格式\n日期：10月23\n名字（所有人）：韩廷富,邵建华,江华兴\n人数：3\n票种：亚洲人', '2026-10-23')
    const html = renderToStaticMarkup(<Show69View kind="boxing" tickets={[]} projects={priceProjects} initialInput={initialInput} onSave={async () => record({ projectName: '泰拳' })} onDelete={async () => {}} />)
    expect(html).toContain('<option value="asian" selected="">亚洲人</option>')
    expect(html).toContain(formatThb(1950))
    expect(html).toContain(formatThb(1860))
    expect(html).toContain(formatThb(90))
  })

  it('asks the user to choose a supplier package when several real project prices match', () => {
    const html = renderToStaticMarkup(<Show69View tickets={[]} projects={[project(), project({ id: 'second-price', supplierId: 'another', supplierName: '另一旅行社' })]} onSave={async () => record()} onDelete={async () => {}} />)
    expect(html).toContain('供货商套餐')
    expect(html).toContain('请选择本次价格套餐')
    expect(html).toContain('星光旅行社 · 69秀')
    expect(html).toContain('另一旅行社 · 69秀')
  })

  it.each([
    { label: 'a unique real supplier', projects: [project()] },
    { label: 'the fixed preset without a catalogue', projects: [] }
  ])('offers an explicit price reset for a stale project seed so it can recover to $label', ({ projects }) => {
    const initialInput = { date: getBangkokDate(), guestName: '甲,乙', people: 2, projectId: 'deleted-or-old-synthetic' }
    const html = renderToStaticMarkup(<Show69View tickets={[]} projects={projects} initialInput={initialInput} onSave={async () => record()} onDelete={async () => {}} />)
    expect(html).toContain('所选供货商或套餐价格已变化，请重新选择当前票种的有效价格。')
    expect(html).toContain('type="button" class="secondary-button">重新匹配价格</button>')
    expect(html).not.toContain('aria-label="自动匹配价格"')

    const resetHtml = renderToStaticMarkup(<Show69View tickets={[]} projects={projects} initialInput={{ ...initialInput, projectId: undefined }} onSave={async () => record()} onDelete={async () => {}} />)
    expect(resetHtml).not.toContain('重新匹配价格</button>')
    expect(resetHtml).toContain('aria-label="自动匹配价格"')
    expect(resetHtml).toContain('甲,乙</textarea>')
    for (const amount of [430, 400, 30, 860, 800, 60]) expect(resetHtml).toContain(formatThb(amount))
    if (projects.length) expect(resetHtml).toContain('价格套餐：星光旅行社 · 69秀')
  })

  it('displays historical saved totals and refund net amounts instead of repricing from today catalogue', () => {
    const old = record({ amountBasis: 'per_person', personCount: 2, agentPriceThb: 500, costThb: 350 })
    const refunded = record({ id: 'refunded', amountBasis: 'per_person', personCount: 3, agentPriceThb: 600, costThb: 500, refunds: [{ id: 'r', userId: 'user', ticketId: 'refunded', personCount: 1, isFull: false, refundRevenueThb: 600, returnedCostThb: 500, refundDate: getBangkokDate(), refundTime: '12:00', note: '', cancelledAt: null, createdAt: '', updatedAt: '', syncStatus: 'synced' }] })
    const html = renderToStaticMarkup(<Show69View tickets={[old, refunded]} projects={priceProjects} onSave={async () => old} onDelete={async () => {}} />)
    for (const value of ['净售价 ' + formatThb(1000), '净成本 ' + formatThb(700), '净利润 ' + formatThb(300), '净售价 ' + formatThb(1200), '净成本 ' + formatThb(1000), '净利润 ' + formatThb(200)]) expect(html).toContain(value)
  })
})
