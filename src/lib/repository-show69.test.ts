import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { getTicketAmounts } from './ticket-amounts'
import { assertLedgerOwner, type LedgerOwnerContext, type TicketCreateOperation } from './ledger-account'

const state = vi.hoisted(() => ({
  settings: { localUserId: 'local-user', lastCloudUserId: null as string | null, activeCloudUserId: null as string | null },
  suppliers: new Map<string, Supplier>(), projects: new Map<string, Project>(), tickets: new Map<string, TicketRecord>(),
  refunds: [] as RefundRecord[], operations: new Map<string, TicketCreateOperation>(),
  beforeTicketWrite: null as null | (() => Promise<void>), beforeProjectRead: null as null | (() => Promise<void>)
}))
const copy = <T,>(value: T): T => structuredClone(value)
const guard = (owner: LedgerOwnerContext, userId = owner.userId) => assertLedgerOwner(state.settings, owner, userId)
const key = (owner: LedgerOwnerContext, id: string) => JSON.stringify([owner.userId, id])

vi.mock('./supabase', () => ({ getSupabase: () => ({}) }))
vi.mock('./db', () => ({ db: {
  getSettings: async () => ({ ...state.settings }), getOrCreateSettings: async () => ({ ...state.settings }),
  activateAccount: async (userId: string | null, cloud: boolean, isCurrent: () => boolean) => {
    if (!isCurrent()) throw new Error('账号已切换')
    state.settings.activeCloudUserId = cloud ? userId : null
    state.settings.lastCloudUserId = userId
    return { ...state.settings }
  },
  getSuppliers: async () => [...state.suppliers.values()].map(copy),
  getProjects: async () => { await state.beforeProjectRead?.(); return [...state.projects.values()].map(copy) },
  putSupplier: async (row: Supplier, owner: LedgerOwnerContext) => { guard(owner, row.userId); state.suppliers.set(row.id, copy(row)) },
  putProject: async (row: Project, owner: LedgerOwnerContext) => { guard(owner, row.userId); state.projects.set(row.id, copy(row)) },
  getTicket: async (id: string) => { const row = state.tickets.get(id); return row && copy(row) },
  getRefunds: async () => state.refunds.map(copy),
  putTicket: async (row: TicketRecord, owner: LedgerOwnerContext) => { await state.beforeTicketWrite?.(); guard(owner, row.userId); state.tickets.set(row.id, copy(row)) },
  getTicketCreateOperation: async (id: string, owner: LedgerOwnerContext) => {
    guard(owner)
    const receipt = state.operations.get(key(owner, id))
    return receipt && { receipt: copy(receipt), ticket: copy(state.tickets.get(receipt.ticketId) ?? receipt.acceptedRecord) }
  },
  putNewTicketOnce: async (row: TicketRecord, fingerprint: string, owner: LedgerOwnerContext) => {
    await state.beforeTicketWrite?.()
    guard(owner, row.userId)
    const receipt = state.operations.get(key(owner, row.id))
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error('这次提交已经保存过不同内容')
      return copy(state.tickets.get(receipt.ticketId) ?? receipt.acceptedRecord)
    }
    if (state.tickets.has(row.id)) throw new Error('此提交编号已有其他记录')
    state.tickets.set(row.id, copy(row))
    state.operations.set(key(owner, row.id), { id: key(owner, row.id), userId: owner.userId, ticketId: row.id, fingerprint, acceptedRecord: copy(row) })
    return copy(row)
  }
} }))

import { ledgerRepository } from './repository'

const input = { date: '2026-10-23', guestName: '韩廷富,邵建华,江华兴', people: 3 }
const asianInput = { ...input, boxingCategory: 'asian' as const }
const westernInput = { ...input, boxingCategory: 'western' as const }
const historical = (): TicketRecord => ({
  id: 'old69', userId: 'user-1', issueDate: '2026-10-22', issueTime: '17:45', guestName: '旧姓名', personCount: 2,
  supplierId: 'old-supplier', supplierName: '原供货商', projectId: null, projectName: '69成人秀', subItemName: '旧套餐',
  agentPriceThb: 1300, costThb: 1100, amountBasis: 'total', entryMode: 'standard', quantityUnit: 'person',
  settlementMode: 'daily', manualProfitThb: null, note: '保留原始财务快照',
  createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', deletedAt: null, syncStatus: 'synced'
})
const seedCatalogue = (overrides: Partial<Project> & Pick<Project, 'id' | 'name' | 'defaultAgentPriceThb' | 'defaultCostThb'>): Project => {
  const userId = overrides.userId ?? 'user-1'
  const project: Project = {
    userId, supplierId: `agency-${userId}`, supplierName: '星光旅行社', normalizedName: overrides.name, subItemName: '', normalizedSubItemName: '',
    defaultAmountBasis: 'per_person', settlementMode: 'monthly', entryMode: 'standard', quantityUnit: 'person',
    createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', syncStatus: 'synced', ...overrides
  }
  state.suppliers.set(project.supplierId, { id: project.supplierId, userId, name: project.supplierName, normalizedName: project.supplierName, createdAt: project.createdAt, updatedAt: project.updatedAt, syncStatus: 'synced' })
  state.projects.set(project.id, project)
  return project
}

beforeEach(async () => {
  vi.useRealTimers()
  state.suppliers.clear(); state.projects.clear(); state.tickets.clear(); state.operations.clear()
  state.refunds = []; state.beforeTicketWrite = null; state.beforeProjectRead = null
  await ledgerRepository.activateAccount(null)
  await ledgerRepository.activateAccount('user-1')
})

describe.each([
  { projectName: '69秀', historicalName: '69成人秀', save: ledgerRepository.createOrUpdateShow69Record },
  { projectName: '泰拳', historicalName: '泰拳比赛 VIP', save: ledgerRepository.createOrUpdateBoxingRecord }
])('$projectName independent record persistence', ({ projectName, historicalName, save }) => {
  const recordInput = projectName === '泰拳' ? asianInput : input
  const subItemName = projectName === '泰拳' ? '亚洲面孔' : '独立记录'
  const agentPriceThb = projectName === '泰拳' ? 650 : 430
  const costThb = projectName === '泰拳' ? 620 : 400
  const historicalRecord = () => ({ ...historical(), projectName: historicalName, subItemName })
  it('uses the preset per-person price when the account has no matching catalogue', async () => {
    const record = await save(recordInput, undefined, 'save69')
    expect(record).toMatchObject({ id: 'save69', userId: 'user-1', issueDate: input.date, guestName: input.guestName, personCount: 3, projectName, subItemName, agentPriceThb, costThb, entryMode: 'standard', quantityUnit: 'person', settlementMode: 'monthly', syncStatus: 'pending' })
    expect(record.supplierName).toBe(`${projectName}独立记录`)
    expect(record.issueTime).toMatch(/^\d{2}:\d{2}$/)
    expect(state.suppliers.size).toBe(1)
    expect(state.projects.size).toBe(1)
    expect(state.tickets.size).toBe(1)
  })

  it('deduplicates concurrent saves and retries after time or catalogue changes', async () => {
    const [first, concurrent] = await Promise.all([
      save(recordInput, undefined, 'same-operation'),
      save(recordInput, undefined, 'same-operation')
    ])
    expect(concurrent).toEqual(first)
    expect(state.suppliers.size).toBe(1)
    expect(state.projects.size).toBe(1)
    expect(state.tickets.size).toBe(1)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-01T12:00:00Z'))
    state.suppliers.clear(); state.projects.clear()
    expect(await save(recordInput, undefined, 'same-operation')).toEqual(first)
    expect(state.suppliers.size).toBe(0)
    await expect(save({ ...recordInput, people: 4 }, undefined, 'same-operation')).rejects.toThrow('不同内容')
    expect(state.tickets.size).toBe(1)
  })

  it('changes only the requested fields on a historical record with no remaining catalogue', async () => {
    const original = historicalRecord()
    state.tickets.set(original.id, original)
    const updated = await save(recordInput, original)
    expect(updated).toEqual({ ...original, issueDate: input.date, guestName: input.guestName, personCount: input.people, updatedAt: updated.updatedAt, syncStatus: 'pending', refunds: [] })
    expect(updated.updatedAt).not.toBe(original.updatedAt)
    expect(state.suppliers.size).toBe(0)
    expect(state.projects.size).toBe(0)
  })

  it('rejects editing a refunded record, including a cancelled refund', async () => {
    const original = historicalRecord()
    state.tickets.set(original.id, original)
    state.refunds.push({ id: 'refund', userId: 'user-1', ticketId: original.id, cancelledAt: '2026-10-23T00:00:00Z' } as RefundRecord)
    await expect(save(recordInput, original)).rejects.toThrow('已有退票')
    expect(state.tickets.get(original.id)).toEqual(original)
  })

  it('does not resurrect a deleted record or overwrite a stale financial snapshot', async () => {
    const stale = historicalRecord()
    const current = { ...stale, agentPriceThb: 1500, note: '另一台设备已更新' }
    state.tickets.set(current.id, current)
    const updated = await save(recordInput, stale)
    expect(updated.agentPriceThb).toBe(1500)
    expect(updated.note).toBe(current.note)
    const deleted = { ...updated, deletedAt: '2026-10-23T00:00:00Z' }
    state.tickets.set(current.id, deleted)
    await expect(save(recordInput, stale)).rejects.toThrow('无法编辑')
    expect(state.tickets.get(current.id)).toEqual(deleted)
  })

  it('keeps a pending save pinned to the initiating account when account switches before storage', async () => {
    state.beforeTicketWrite = () => ledgerRepository.activateAccount('user-2')
    await expect(save(recordInput, undefined, 'switch-operation')).rejects.toThrow('账号已切换')
    expect(state.tickets.size).toBe(0)
    expect(state.operations.size).toBe(0)
    expect([...state.suppliers.values()].every(row => row.userId === 'user-1')).toBe(true)
  })

  it('does not create a project for the new account if account switches during catalogue preparation', async () => {
    state.beforeProjectRead = () => ledgerRepository.activateAccount('user-2')
    await expect(save(recordInput, undefined, 'catalogue-switch')).rejects.toThrow('账号已切换')
    expect(state.projects.size).toBe(0)
    expect(state.tickets.size).toBe(0)
  })

  it('rejects foreign edits and operation IDs while giving each account its own catalogue', async () => {
    const first = await save(recordInput, undefined, 'account-operation')
    await ledgerRepository.activateAccount('user-2')
    await expect(save(recordInput, first)).rejects.toThrow('当前账号')
    await expect(save(recordInput, undefined, 'account-operation')).rejects.toThrow('提交编号已有其他记录')
    const second = await save(recordInput, undefined, 'second-operation')
    expect(second.userId).toBe('user-2')
    expect(second.supplierId).not.toBe(first.supplierId)
    expect(second.projectId).not.toBe(first.projectId)
    expect(state.tickets.get(first.id)?.userId).toBe('user-1')
  })

  it('rejects incomplete or invalid three-field records without writing catalogue or ticket rows', async () => {
    for (const invalid of [{ ...recordInput, guestName: '' }, { ...recordInput, date: '2026-02-30' }, { ...recordInput, people: 0 }, { ...recordInput, people: 1.5 }]) {
      await expect(save(invalid)).rejects.toThrow()
    }
    expect(state.suppliers.size).toBe(0)
    expect(state.projects.size).toBe(0)
    expect(state.tickets.size).toBe(0)
  })
})

describe('independent record channel isolation', () => {
  it('prepares separate catalogues for concurrent 69秀 and boxing saves', async () => {
    const [show69, boxing] = await Promise.all([
      ledgerRepository.createOrUpdateShow69Record(input, undefined, 'show69-channel'),
      ledgerRepository.createOrUpdateBoxingRecord(asianInput, undefined, 'boxing-channel')
    ])
    expect(show69.projectName).toBe('69秀')
    expect(boxing.projectName).toBe('泰拳')
    expect(boxing.supplierId).not.toBe(show69.supplierId)
    expect(boxing.projectId).not.toBe(show69.projectId)
    expect(state.suppliers.size).toBe(2)
    expect(state.projects.size).toBe(2)
    expect(state.tickets.size).toBe(2)
  })

  it('does not reuse an accepted operation or edit a saved record through the other channel', async () => {
    const show69 = await ledgerRepository.createOrUpdateShow69Record(input, undefined, 'show69-operation')
    await expect(ledgerRepository.createOrUpdateBoxingRecord(asianInput, undefined, 'show69-operation')).rejects.toThrow('不同内容')
    await expect(ledgerRepository.createOrUpdateBoxingRecord(asianInput, show69)).rejects.toThrow('无法编辑')
    const boxing = await ledgerRepository.createOrUpdateBoxingRecord(asianInput, undefined, 'boxing-operation')
    await expect(ledgerRepository.createOrUpdateShow69Record(input, undefined, 'boxing-operation')).rejects.toThrow('不同内容')
    await expect(ledgerRepository.createOrUpdateShow69Record(input, boxing)).rejects.toThrow('无法编辑')
    expect(state.tickets.get(show69.id)?.projectName).toBe('69秀')
    expect(state.tickets.get(boxing.id)?.projectName).toBe('泰拳')
    expect(state.tickets.size).toBe(2)
  })
})

describe('monthly record pricing persistence', () => {
  it('uses the real agency catalogue instead of the old synthetic zero-price catalogue', async () => {
    seedCatalogue({ id: 'zero69', name: '69秀', subItemName: '独立记录', supplierId: 'synthetic69', supplierName: '69秀独立记录', defaultAgentPriceThb: 0, defaultCostThb: 0 })
    const real = seedCatalogue({ id: 'agency69', name: '69秀', defaultAgentPriceThb: 430, defaultCostThb: 400 })
    const record = await ledgerRepository.createOrUpdateShow69Record(input, undefined, 'real69')
    expect(record).toMatchObject({ supplierId: real.supplierId, supplierName: '星光旅行社', projectId: real.id, subItemName: '', agentPriceThb: 430, costThb: 400, amountBasis: 'per_person', settlementMode: 'monthly' })
    expect(getTicketAmounts(record)).toEqual({ agentPriceThb: 1290, costThb: 1200, profitThb: 90 })
    expect(state.suppliers.size).toBe(2)
    expect(state.projects.size).toBe(2)
    expect(state.projects.get('zero69')?.defaultAgentPriceThb).toBe(0)
  })

  it('matches both agency boxing categories and calculates actual per-person profits', async () => {
    seedCatalogue({ id: 'agency-asian', name: '泰拳', subItemName: '亚洲面孔', defaultAgentPriceThb: 650, defaultCostThb: 620 })
    seedCatalogue({ id: 'agency-western', name: '泰拳', subItemName: '欧美面孔', defaultAgentPriceThb: 900, defaultCostThb: 850 })
    const asian = await ledgerRepository.createOrUpdateBoxingRecord(asianInput, undefined, 'asian')
    const western = await ledgerRepository.createOrUpdateBoxingRecord(westernInput, undefined, 'western')
    expect(asian).toMatchObject({ projectId: 'agency-asian', subItemName: '亚洲面孔', supplierName: '星光旅行社', agentPriceThb: 650, costThb: 620 })
    expect(western).toMatchObject({ projectId: 'agency-western', subItemName: '欧美面孔', supplierName: '星光旅行社', agentPriceThb: 900, costThb: 850 })
    expect(getTicketAmounts(asian)).toEqual({ agentPriceThb: 1950, costThb: 1860, profitThb: 90 })
    expect(getTicketAmounts(western)).toEqual({ agentPriceThb: 2700, costThb: 2550, profitThb: 150 })
    expect(state.projects.size).toBe(2)
    expect(state.suppliers.size).toBe(1)
  })

  it('creates separate preset boxing packages when the agency catalogue is missing', async () => {
    const asian = await ledgerRepository.createOrUpdateBoxingRecord(asianInput, undefined, 'preset-asian')
    const western = await ledgerRepository.createOrUpdateBoxingRecord(westernInput, undefined, 'preset-western')
    expect(asian).toMatchObject({ subItemName: '亚洲面孔', agentPriceThb: 650, costThb: 620 })
    expect(western).toMatchObject({ subItemName: '欧美面孔', agentPriceThb: 900, costThb: 850 })
    expect(western.projectId).not.toBe(asian.projectId)
    expect(western.supplierId).toBe(asian.supplierId)
    expect(state.projects.size).toBe(2)
  })

  it('upgrades only the zero-price synthetic 69 catalogue and leaves every historical ticket untouched', async () => {
    const synthetic = seedCatalogue({ id: 'zero69', name: '69秀', subItemName: '独立记录', supplierId: 'synthetic69', supplierName: '69秀独立记录', defaultAgentPriceThb: 0, defaultCostThb: 0 })
    const old = { ...historical(), projectId: synthetic.id, supplierId: synthetic.supplierId, supplierName: synthetic.supplierName, agentPriceThb: 0, costThb: 0 }
    state.tickets.set(old.id, copy(old))
    const record = await ledgerRepository.createOrUpdateShow69Record(input, undefined, 'priced-new69')
    expect(record).toMatchObject({ projectId: synthetic.id, agentPriceThb: 430, costThb: 400 })
    expect(state.projects.get(synthetic.id)).toMatchObject({ defaultAgentPriceThb: 430, defaultCostThb: 400, syncStatus: 'pending' })
    expect(state.tickets.get(old.id)).toEqual(old)
  })

  it('requires a category for a new boxing record while permitting edits of unclassified legacy records', async () => {
    await expect(ledgerRepository.createOrUpdateBoxingRecord(input, undefined, 'missing-category')).rejects.toThrow('请选择泰拳票种')
    expect(state.tickets.size).toBe(0)
    const legacy = { ...historical(), projectName: '泰拳', agentPriceThb: 0, costThb: 0 }
    state.tickets.set(legacy.id, legacy)
    const updated = await ledgerRepository.createOrUpdateBoxingRecord(input, legacy)
    expect(updated).toMatchObject({ agentPriceThb: 0, costThb: 0, subItemName: '旧套餐', personCount: 3 })
    await expect(ledgerRepository.createOrUpdateBoxingRecord(asianInput, legacy)).rejects.toThrow('保留原票种')
  })

  it('requires a choice between multiple real prices and stores the selected agency snapshot', async () => {
    seedCatalogue({ id: 'agency69-a', name: '69秀', defaultAgentPriceThb: 430, defaultCostThb: 400 })
    const selected = seedCatalogue({ id: 'agency69-b', name: '69秀', supplierId: 'second-agency', supplierName: '第二旅行社', defaultAgentPriceThb: 440, defaultCostThb: 410 })
    await expect(ledgerRepository.createOrUpdateShow69Record(input, undefined, 'ambiguous')).rejects.toThrow('多个')
    expect(state.tickets.size).toBe(0)
    const record = await ledgerRepository.createOrUpdateShow69Record({ ...input, projectId: selected.id }, undefined, 'selected-agency')
    expect(record).toMatchObject({ supplierId: 'second-agency', supplierName: '第二旅行社', projectId: selected.id, agentPriceThb: 440, costThb: 410 })
  })

  it('rejects foreign, wrong-project and wrong-category catalogue selections', async () => {
    seedCatalogue({ id: 'foreign69', userId: 'user-2', name: '69秀', defaultAgentPriceThb: 430, defaultCostThb: 400 })
    seedCatalogue({ id: 'wrong-kind', name: '79秀', defaultAgentPriceThb: 430, defaultCostThb: 400 })
    seedCatalogue({ id: 'agency-western', name: '泰拳', subItemName: '欧美面孔', defaultAgentPriceThb: 900, defaultCostThb: 850 })
    for (const projectId of ['foreign69', 'wrong-kind', 'missing']) await expect(ledgerRepository.createOrUpdateShow69Record({ ...input, projectId })).rejects.toThrow('当前账号')
    await expect(ledgerRepository.createOrUpdateBoxingRecord({ ...asianInput, projectId: 'agency-western' })).rejects.toThrow('当前票种')
    expect(state.tickets.size).toBe(0)
  })

  it('rejects a real catalogue with an unavailable supplier rather than manufacturing a replacement', async () => {
    const real = seedCatalogue({ id: 'agency69', name: '69秀', defaultAgentPriceThb: 430, defaultCostThb: 400 })
    state.suppliers.delete(real.supplierId)
    await expect(ledgerRepository.createOrUpdateShow69Record(input)).rejects.toThrow('供货商已变化')
    expect(state.suppliers.size).toBe(0)
    expect(state.tickets.size).toBe(0)
  })

  it('keeps accepted prices when a catalogue price changes and rejects a different selected project or category on retry', async () => {
    const real = seedCatalogue({ id: 'agency69-a', name: '69秀', defaultAgentPriceThb: 430, defaultCostThb: 400 })
    const selectedInput = { ...input, projectId: real.id }
    const first = await ledgerRepository.createOrUpdateShow69Record(selectedInput, undefined, 'stable-price')
    state.projects.set(real.id, { ...real, defaultAgentPriceThb: 500, defaultCostThb: 450 })
    expect(await ledgerRepository.createOrUpdateShow69Record(selectedInput, undefined, 'stable-price')).toEqual(first)
    await expect(ledgerRepository.createOrUpdateShow69Record({ ...selectedInput, projectId: 'different-project' }, undefined, 'stable-price')).rejects.toThrow('不同内容')
    const boxing = await ledgerRepository.createOrUpdateBoxingRecord(asianInput, undefined, 'stable-category')
    await expect(ledgerRepository.createOrUpdateBoxingRecord(westernInput, undefined, 'stable-category')).rejects.toThrow('不同内容')
    expect(state.tickets.get(boxing.id)?.agentPriceThb).toBe(650)
  })

  it('returns an accepted legacy three-field 69 request without repricing or creating a catalogue', async () => {
    const original = { ...historical(), id: 'legacy-operation', agentPriceThb: 0, costThb: 0 }
    const receiptId = JSON.stringify(['user-1', original.id])
    state.tickets.set(original.id, original)
    state.operations.set(receiptId, { id: receiptId, userId: 'user-1', ticketId: original.id, acceptedRecord: original, fingerprint: JSON.stringify({ kind: 'show69_record', date: input.date, guestName: input.guestName, people: input.people }) })
    const retried = await ledgerRepository.createOrUpdateShow69Record(input, undefined, original.id)
    expect(retried).toMatchObject({ id: original.id, agentPriceThb: 0, costThb: 0 })
    expect(state.projects.size).toBe(0)
    expect(state.suppliers.size).toBe(0)
    expect(state.tickets.size).toBe(1)
  })

  it('preserves original boxing prices during an edit and rejects category or catalogue changes', async () => {
    const original = { ...historical(), projectId: 'historical-asian', projectName: '泰拳', subItemName: '亚洲面孔', agentPriceThb: 600, costThb: 575, amountBasis: 'per_person' as const }
    state.tickets.set(original.id, original)
    const updated = await ledgerRepository.createOrUpdateBoxingRecord({ ...asianInput, projectId: original.projectId }, original)
    expect(updated).toMatchObject({ projectId: original.projectId, agentPriceThb: 600, costThb: 575, personCount: 3 })
    expect(getTicketAmounts(updated)).toEqual({ agentPriceThb: 1800, costThb: 1725, profitThb: 75 })
    await expect(ledgerRepository.createOrUpdateBoxingRecord(westernInput, original)).rejects.toThrow('保留原票种')
    await expect(ledgerRepository.createOrUpdateBoxingRecord({ ...asianInput, projectId: 'new-project' }, original)).rejects.toThrow('保留原价格套餐')
  })

  it('rejects amounts beyond storage precision both on creation and when editing the headcount', async () => {
    await expect(ledgerRepository.createOrUpdateBoxingRecord({ ...westernInput, people: 2147483647 }, undefined, 'too-large')).rejects.toThrow('金额或人数过大')
    expect(state.tickets.size).toBe(0)
    expect(state.operations.size).toBe(0)
    const original = { ...historical(), projectName: '泰拳', subItemName: '欧美面孔', agentPriceThb: 900, costThb: 850, amountBasis: 'per_person' as const }
    state.tickets.set(original.id, original)
    await expect(ledgerRepository.createOrUpdateBoxingRecord({ ...westernInput, people: 2147483647 }, original)).rejects.toThrow('金额或人数过大')
    expect(state.tickets.get(original.id)).toEqual(original)
  })
})
