import { describe, expect, it } from 'vitest'
import type { Project, TicketInput } from '../types'
import { applyTicketCommand, parseTicketCommand } from './ticket-command'

const project = (id: string, name: string, overrides: Partial<Project> = {}): Project => ({
  id, userId: 'owner', supplierId: 'official', supplierName: '官方', name, normalizedName: name,
  subItemName: '', normalizedSubItemName: '', defaultAgentPriceThb: 500, defaultCostThb: 450,
  createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', syncStatus: 'synced', ...overrides
})
const show = project('79', '79秀')
const boxing = project('boxing', '泰拳', { subItemName: '普通票' })
const vip = project('vip', '泰拳', { subItemName: 'VIP', defaultAgentPriceThb: 900, defaultCostThb: 700 })
const vipOther = project('vip-b', '泰拳', { subItemName: 'VIP', supplierId: 'supplier-b', supplierName: '自然旅行社', defaultAgentPriceThb: 850 })
const goods = project('goods', '药品', { quantityUnit: 'item', defaultAgentPriceThb: 120, defaultCostThb: 100 })
const commission = project('commission', '旅行社月结返佣', { entryMode: 'profit_only', defaultAmountBasis: 'total' })
const catalogue = [show, boxing, vip, vipOther, goods, commission]
const current: TicketInput = {
  guestName: '上次客户', issueDate: '2026-10-14', issueTime: '08:30', personCount: 9,
  supplierName: '旧供应商', projectId: 'old', projectName: '旧项目', subItemName: '旧套餐',
  agentPriceThb: 999, costThb: 888, amountBasis: 'total', settlementMode: 'daily', manualProfitThb: 999, note: '原备注'
}
const parse = (text: string, projects = catalogue, today = '2026-10-15') => parseTicketCommand(text, projects, today)

describe('catalogue ticket command parsing', () => {
  it.each(['69', '79', '89', '99'])('maps standalone %s to its show catalogue entry without confusing money or quantities', code => {
    const shows = ['69', '79', '89', '99'].map(value => project(value, `${value}秀`))
    const parsed = parse(`${code} 张三 今天 2人 售价79 成本69`, shows)
    expect(parsed.candidates.map(item => item.id)).toEqual([code])
    expect(parsed.fields).toMatchObject({ guestName: '张三', personCount: 2, agentPriceThb: 79, costThb: 69 })
    expect(parse(`${code} 张三 今天 人数89`, shows).candidates.map(item => item.id)).toEqual([code])
    expect(parse(`${code} 张三 今天 99人`, shows).candidates.map(item => item.id)).toEqual([code])
  })

  it('recognizes the labelled multi-person template, preserving every customer and date without a year', () => {
    const parsed = parse('69出票格式\n日期：10月23\n名字（所有人）：韩廷富,邵建华,江华兴\n人数：3', [project('69', '69秀')])
    expect(parsed.candidates.map(item => item.id)).toEqual(['69'])
    expect(parsed.fields).toMatchObject({ issueDate: '2026-10-23', guestName: '韩廷富 邵建华 江华兴', personCount: 3 })
  })

  it('does not infer a show from explicit monetary or quantity fields', () => {
    const shows = ['69', '79', '89', '99'].map(value => project(value, `${value}秀`))
    expect(() => parse('张三 今天 人数69 售价79 成本89', shows)).toThrow('未找到目录')
    expect(() => parse('张三 今天 69人 售价79 成本89', shows)).toThrow('未找到目录')
  })

  it.each(['李湘光 龙粉萍 今天 2个79', '79 李湘光 龙粉萍 2人 今天', '７９\n李湘光 龙粉萍\n２位\n今天'])('parses 79 commands in flexible order: %s', (text) => {
    const parsed = parse(text)
    expect(parsed.candidates.map((item) => item.id)).toEqual(['79'])
    expect(parsed.fields).toMatchObject({ guestName: '李湘光 龙粉萍', personCount: 2, issueDate: '2026-10-15' })
    const result = applyTicketCommand(current, parsed, show)
    expect(result).toMatchObject({ projectId: show.id, supplierName: '官方', agentPriceThb: 500, costThb: 450, amountBasis: 'per_person', settlementMode: 'monthly' })
  })

  it('does not interpret the project number before a 张 surname as the quantity', () => {
    expect(parse('79 张三 2人 今天').fields).toMatchObject({ guestName: '张三', personCount: 2 })
  })

  it.each(['79show', '79 SHOW', 'Imagine 79Show', '79秀'])('recognizes existing 79 aliases: %s', (alias) => {
    expect(parse(`${alias} Aditya 1名 今天`).candidates.map((item) => item.id)).toEqual(['79'])
    expect(() => parse(`${alias} Aditya 1名 今天`, [boxing])).toThrow('未找到目录')
  })

  it('keeps all supplier and package candidates until the user specifies a valid option', () => {
    const ambiguous = parse('泰拳 Jimmy 明天 2人')
    expect(ambiguous.candidates.map((item) => item.id)).toEqual(['boxing', 'vip', 'vip-b'])
    expect(ambiguous.warnings.join(' ')).toContain('多个匹配')
    const parsed = parse('泰拳 Jimmy 明天 2人 VIP 售价800 成本650')
    expect(parsed.candidates.map((item) => item.id)).toEqual(['vip', 'vip-b'])
    expect(parsed.fields).toMatchObject({ guestName: 'Jimmy', issueDate: '2026-10-16', personCount: 2, agentPriceThb: 800, costThb: 650 })
    expect(applyTicketCommand(current, parsed, vipOther)).toMatchObject({ projectId: 'vip-b', supplierName: '自然旅行社', agentPriceThb: 800, costThb: 650, amountBasis: 'per_person' })
    expect(parse('自然旅行社 泰拳 VIP Jimmy 今天 2人').candidates.map((item) => item.id)).toEqual(['vip-b'])
  })

  it('uses longest project names and matches original or cleaned adult labels', () => {
    const course = project('course', '泰拳课程')
    expect(parse('泰拳课程 Jimmy 今天 2人', [...catalogue, course]).candidates.map((item) => item.id)).toEqual(['course'])
    const adult = project('adult', '景点成人', { subItemName: '成人' })
    const child = project('child', '景点', { subItemName: '儿童' })
    expect(parse('景点成人 张三 今天 2人', [adult, child]).candidates.map((item) => item.id)).toEqual(['adult'])
    expect(parse('景点 张三 今天 2人', [adult, child]).candidates).toHaveLength(2)
    expect(parse('景点 成人 张三 今天 2人', [adult, child]).candidates.map((item) => item.id)).toEqual(['adult'])
    expect(() => parse('景点成人2儿童1 今天', [adult, child])).toThrow('多个套餐')
  })

  it.each([
    ['2026/10/14', '2026-10-14'], ['2026-10-14', '2026-10-14'], ['2026年10月14日', '2026-10-14'],
    ['明天', '2026-10-16'], ['后天', '2026-10-17'], ['今日', '2026-10-15']
  ])('recognizes viewing date %s', (input, expected) => {
    expect(parse(`79 Jimmy ${input} 1人`).fields.issueDate).toBe(expected)
  })

  it('uses the supplied Bangkok date across month/year boundaries and parses explicit time', () => {
    expect(parse('79 Jimmy 明天 1人 9:05', catalogue, '2026-12-31').fields).toMatchObject({ issueDate: '2027-01-01', issueTime: '09:05' })
    expect(parse('79 Jimmy 后天 1人', catalogue, '2024-02-28').fields.issueDate).toBe('2024-03-01')
    expect(parse('79 客户：Jimmy 观看日期：2026/10/15 时间：18:30 人数：2人').fields).toMatchObject({ guestName: 'Jimmy', issueDate: '2026-10-15', issueTime: '18:30', personCount: 2 })
    expect(parse('🎟️79 Jimmy 日期今天 数量2').fields).toMatchObject({ guestName: 'Jimmy', issueDate: '2026-10-15', personCount: 2 })
  })

  it.each(['人', '位', '名', '张', '个'])('recognizes quantity unit %s', (unit) => {
    expect(parse(`79 Jimmy 今天 3${unit}`).fields.personCount).toBe(3)
  })

  it.each(['件', '瓶', '盒'])('preserves item-based catalogue rules for %s', (unit) => {
    const parsed = parse(`药品 Jimmy 今天 4${unit}`)
    expect(applyTicketCommand(current, parsed, goods)).toMatchObject({ personCount: 4, quantityUnit: 'item', amountBasis: 'per_person', settlementMode: 'daily' })
  })

  it('prioritizes explicit customer labels and keeps notes out of project/date/quantity/money parsing', () => {
    const parsed = parse('79 客户姓名：Jimmy 今天 1人 备注：泰拳 明天 99人 售价999 成本888')
    expect(parsed.candidates.map((item) => item.id)).toEqual(['79'])
    expect(parsed.fields).toEqual({ issueDate: '2026-10-15', personCount: 1, guestName: 'Jimmy', note: '泰拳 明天 99人 售价999 成本888' })
    expect(parse('79 Jimmy 今天 1人 备注泰拳 明天 99人 售价999').fields.note).toBe('泰拳 明天 99人 售价999')
  })

  it('clears an unidentified customer instead of retaining the previous guest, preserving other missing fields with warnings', () => {
    const parsed = parse('泰拳 VIP 官方')
    expect(parsed.candidates.map((item) => item.id)).toEqual(['vip'])
    expect(parsed.warnings.join(' ')).toContain('未识别日期')
    expect(parsed.warnings.join(' ')).toContain('未识别客户姓名')
    expect(parsed.warnings.join(' ')).toContain('未识别人数')
    expect(applyTicketCommand(current, parsed, vip)).toMatchObject({ guestName: '', issueDate: '2026-10-14', issueTime: '08:30', personCount: 9, note: '原备注', agentPriceThb: 900, costThb: 700 })
  })

  it.each(['Vipin', 'José', 'Jose\u0301', 'O’Connor', 'สมชาย', 'कुमार'])('recognizes international customer %s without confusing a substring with VIP', name => {
    for (const label of ['', '客户姓名：']) {
      const parsed = parse(`泰拳 ${label}${name} 今天 60人`, [boxing, vip])
      expect(parsed.fields.guestName).toBe(name.normalize('NFKC'))
      expect(applyTicketCommand(current, parsed, boxing)).toMatchObject({ guestName: name.normalize('NFKC'), personCount: 60 })
    }
  })

  it('does not silently create projects, absorb unknown packages into names or interpret bare money', () => {
    expect(() => parse('不存在项目 Jimmy 今天 2人')).toThrow('未找到目录')
    const parsed = parse('泰拳 Jimmy 今天 2人 SVIP 800 650')
    expect(parsed.fields.guestName).toBe('Jimmy')
    expect(parsed.fields.agentPriceThb).toBeUndefined()
    expect(parsed.fields.costThb).toBeUndefined()
    expect(parsed.warnings.join(' ')).toContain('SVIP 800 650')
    const unknownPackage = parse('泰拳 张三 今天 2人 豪华座位')
    expect(unknownPackage.fields.guestName).toBe('张三')
    expect(unknownPackage.warnings.join(' ')).toContain('豪华座位')
    expect(() => parse('药品 Jimmy 今天 2瓶 VIP')).toThrow('没有匹配的套餐')
    expect(() => parse('79 Jimmy 今天 2人 自然旅行社')).toThrow('没有匹配的套餐／供货商')
  })

  it('never auto-fills a manual selling price without an explicit sale amount', () => {
    const manual = project('manual', '手填价格门票', { manualAgentPrice: true, defaultAgentPriceThb: 0 })
    const missing = applyTicketCommand(current, parse('手填价格门票 Jimmy 今天 2人', [manual]), manual)
    expect(missing.agentPriceThb).toBeNaN()
    expect(missing.costThb).toBe(450)
    expect(applyTicketCommand(current, parse('手填价格门票 Jimmy 今天 2人 售价700', [manual]), manual).agentPriceThb).toBe(700)
  })

  it('applies total/per-person overrides without inferring two bare prices', () => {
    const total = parse('79 Jimmy 今天 2人 总售价1000 总成本900')
    expect(applyTicketCommand(current, total, show)).toMatchObject({ amountBasis: 'total', agentPriceThb: 1000, costThb: 900 })
    const perPerson = parse('79 Jimmy 今天 2人 单人售价500 单人成本450')
    expect(applyTicketCommand(current, perPerson, show)).toMatchObject({ amountBasis: 'per_person', agentPriceThb: 500, costThb: 450 })
    expect(parse('79 Jimmy 今天 2人 售价500/人 成本450/人').fields.amountBasis).toBe('per_person')
    expect(parse('79 Jimmy 今天 2人 总售价1,000 总成本900').fields.agentPriceThb).toBe(1000)
    expect(parse('79 Jimmy 今天 2人 售价500，成本450').fields).toMatchObject({ agentPriceThb: 500, costThb: 450 })
    expect(() => applyTicketCommand(current, parse('79 Jimmy 今天 2人 整单售价1000'), show)).toThrow('同时填写')
    const whole = project('whole', '包车', { defaultAmountBasis: 'total' })
    expect(() => applyTicketCommand(current, parse('包车 Jimmy 今天 2人 单人售价500', [whole]), whole)).toThrow('同时填写')
  })

  it('applies profit-only projects through manual profit, not selling price or cost', () => {
    const parsed = parse('旅行社月结返佣 客户Jimmy 今天 利润75.25')
    expect(parsed.fields).toMatchObject({ guestName: 'Jimmy', manualProfitThb: 75.25 })
    expect(parsed.fields.agentPriceThb).toBeUndefined()
    expect(parsed.fields.costThb).toBeUndefined()
    expect(applyTicketCommand(current, parsed, commission)).toMatchObject({ entryMode: 'profit_only', amountBasis: 'total', settlementMode: 'monthly', manualProfitThb: 75.25, agentPriceThb: 0, costThb: 0 })
    expect(() => applyTicketCommand(current, parse('旅行社月结返佣 Jimmy 今天 售价100'), commission)).toThrow('仅录利润')
    expect(() => applyTicketCommand(current, parse('79 Jimmy 今天 利润50'), show)).toThrow('普通出票')
    expect(parse('旅行社月结返佣 2人 今天 利润50').fields.personCount).toBe(2)
    const shortCommission = project('short-commission', '返佣', { entryMode: 'profit_only' })
    expect(parse('返佣 2人 今天 利润50', [shortCommission]).fields.personCount).toBe(2)
  })

  it.each([
    ['79 Jimmy 今天 明天 2人', '多个日期'],
    ['79 Jimmy 2026/02/30 2人', '日期无效'],
    ['79 Jimmy 今天 2人 25:00', '时间无效'],
    ['79 Jimmy 今天 2人 10:00 11:00', '多个时间'],
    ['79 泰拳 Jimmy 今天 2人', '多个项目'],
    ['泰拳 Jimmy 今天 2人 3人', '多个人数'],
    ['泰拳 Jimmy 今天 成人2儿童1', '多个套餐'],
    ['泰拳 Jimmy 今天 普通票 VIP 2人', '多个套餐'],
    ['79 Jimmy 今天 0人', '大于 0'],
    ['79 Jimmy 今天 -2人', '大于 0'],
    ['79 Jimmy 今天 −2人', '大于 0'],
    ['79 Jimmy 今天 - 2人', '大于 0'],
    ['79 Jimmy 今天 1.5人', '大于 0'],
    ['79 Jimmy 今天 人数无', '大于 0'],
    ['79 Jimmy 今天 2人 售价-5', '非负数字'],
    ['79 Jimmy 今天 2人 成本450.123', '两位小数'],
    ['79 Jimmy 今天 2人 售价5e2', '完整有效数字'],
    ['79 Jimmy 今天 2人 售价500abc', '完整有效数字'],
    ['79 Jimmy 今天 2人 售价1,00', '完整有效数字'],
    ['79 Jimmy 今天 .5人', '大于 0'],
    ['79 Jimmy 今天 2e1人', '大于 0'],
    ['79 Jimmy 今天 人数2e1', '大于 0'],
    ['79 Jimmy 今天 数量2abc', '大于 0'],
    ['79 Jimmy 今天 2人 售价500 售价600', '重复金额'],
    ['79 Jimmy 今天 2人 单人售价500 总成本900', '不能混填']
  ])('rejects unsafe ambiguous or invalid input: %s', (text, message) => {
    expect(() => parse(text)).toThrow(message)
  })

  it('does not mutate source projects, current inputs or parsed fields, and rejects unrelated selections', () => {
    const before = structuredClone(catalogue)
    const beforeCurrent = structuredClone(current)
    const parsed = parse('泰拳 Jimmy 今天 2人 VIP 售价800')
    const beforeParsed = structuredClone(parsed)
    applyTicketCommand(current, parsed, vip)
    expect(catalogue).toEqual(before)
    expect(current).toEqual(beforeCurrent)
    expect(parsed).toEqual(beforeParsed)
    expect(() => applyTicketCommand(current, parsed, show)).toThrow('本次识别结果')
  })
})
