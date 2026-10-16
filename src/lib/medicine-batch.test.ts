import { describe, expect, it } from 'vitest'
import type { Project, TicketInput } from '../types'
import { isMedicineProject, validateMedicineBatchShape, type MedicineTicketEntry } from './medicine-batch'

const input = (extra: Partial<TicketInput> = {}): TicketInput => ({
  guestName: 'Jimmy', issueDate: '2026-10-16', issueTime: '15:00', supplierName: '药品供货商', projectId: 'medicine-1', projectName: '药品', subItemName: '青草膏',
  personCount: 2, quantityUnit: 'item', entryMode: 'standard', amountBasis: 'per_person', agentPriceThb: 100, costThb: 80, note: '送酒店', ...extra
})
const entry = (id: string, extra: Partial<TicketInput> = {}): MedicineTicketEntry => ({ operationId: `operation-${id}`, input: input({ projectId: id, ...extra }) })
const medicine = (extra: Partial<Pick<Project, 'name' | 'quantityUnit' | 'entryMode'>> = {}): Pick<Project, 'name' | 'quantityUnit' | 'entryMode'> => ({ name: '药品', quantityUnit: 'item', entryMode: 'standard', ...extra })

describe('medicine project eligibility', () => {
  it('requires the exact cleaned, normalized medicine label and an item quantity unit', () => {
    expect(isMedicineProject(medicine())).toBe(true)
    expect(isMedicineProject(medicine({ name: '　药\t品\n', entryMode: undefined }))).toBe(true)
    expect(isMedicineProject(medicine({ name: '药品（成人）' }))).toBe(true)
  })
  it.each([
    { name: '药品其他' }, { name: '进口药品' }, { name: '79秀' }, { quantityUnit: 'person' },
    { quantityUnit: undefined }, { entryMode: 'profit_only' }
  ] satisfies Partial<Pick<Project, 'name' | 'quantityUnit' | 'entryMode'>>[])('excludes other products and modes: %j', (extra) => {
    expect(isMedicineProject(medicine(extra))).toBe(false)
  })
})

describe('medicine batch shared shape', () => {
  it('accepts one item or different medicines with independent prices and quantities', () => {
    expect(validateMedicineBatchShape([entry('one')])).toBeUndefined()
    expect(validateMedicineBatchShape([entry('one'), entry('two', { subItemName: '鼻通', personCount: 10, agentPriceThb: 80, costThb: 60 })])).toBeUndefined()
  })
  it('allows unnamed customers, optional times and trim-equivalent names/notes', () => {
    expect(() => validateMedicineBatchShape([entry('one', { guestName: undefined, issueTime: undefined, note: ' ' }), entry('two', { guestName: ' ', issueTime: null, note: '' })])).not.toThrow()
    expect(() => validateMedicineBatchShape([entry('one', { guestName: ' Jimmy ', note: ' 送酒店 ' }), entry('two')])).not.toThrow()
  })
  it('does not normalize or mutate submitted records', () => {
    const batch = [entry('one', { guestName: ' Jimmy ', note: ' 送酒店 ' }), entry('two')]
    const before = structuredClone(batch)
    batch.forEach(row => { Object.freeze(row.input); Object.freeze(row) })
    Object.freeze(batch)
    expect(() => validateMedicineBatchShape(batch)).not.toThrow()
    expect(batch).toEqual(before)
  })
  it.each([[], null, undefined, {}])('rejects an empty or missing batch: %j', (batch) => {
    expect(() => validateMedicineBatchShape(batch as MedicineTicketEntry[])).toThrow('请至少选择一种药品')
  })
  it.each([null, {}, { operationId: 'one' }, { operationId: 'one', input: null }])('reports a missing input clearly: %j', (row) => {
    expect(() => validateMedicineBatchShape([row as unknown as MedicineTicketEntry])).toThrow('记录不完整')
  })
  it.each(['', '   ', undefined, 123])('rejects an invalid operation ID: %j', (operationId) => {
    expect(() => validateMedicineBatchShape([{ ...entry('one'), operationId } as MedicineTicketEntry])).toThrow('缺少提交编号')
  })
  it.each(['', '   ', undefined, 123])('rejects an invalid project ID: %j', (projectId) => {
    expect(() => validateMedicineBatchShape([entry('one', { projectId } as Partial<TicketInput>)])).toThrow('未选择有效的药品项目')
  })
  it('rejects duplicate medicines even with separate operation IDs', () => {
    const one = entry('one')
    expect(() => validateMedicineBatchShape([one, { ...one, operationId: 'another-operation' }])).toThrow('同一种药品不能重复添加')
  })
  it('rejects duplicate operation IDs even with different medicine projects', () => {
    expect(() => validateMedicineBatchShape([entry('one'), { ...entry('two'), operationId: 'operation-one' }])).toThrow('提交编号不能重复')
  })
  it.each([
    [{ guestName: 'Aditya' }, '客户姓名'], [{ guestName: undefined }, '客户姓名'], [{ issueDate: '2026-10-17' }, '出票日期'],
    [{ issueDate: ' 2026-10-16 ' }, '出票日期'], [{ issueTime: '16:00' }, '出票时间'], [{ issueTime: '15:00:00' }, '出票时间'],
    [{ issueTime: '' }, '出票时间'], [{ note: '自取' }, '备注']
  ] satisfies [Partial<TicketInput>, string][])('rejects inconsistent shared values: %j', (extra, label) => {
    expect(() => validateMedicineBatchShape([entry('one'), entry('two', extra)])).toThrow(`${label}必须一致`)
  })
  it('leaves single-row date, quantity and amount validation to repository staging', () => {
    expect(() => validateMedicineBatchShape([entry('one', { issueDate: 'invalid', issueTime: 'invalid', personCount: -2, agentPriceThb: 1.001, costThb: -1 })])).not.toThrow()
  })
})
