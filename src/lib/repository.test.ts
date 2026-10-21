import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@supabase/supabase-js'
import type { Project, RefundInput, RefundRecord, TicketInput, TicketRecord } from '../types'
import { mergeRemoteRecord } from './sync'
import { getTicketAmounts } from './ticket-amounts'
import { getRefundState } from './refunds'
import { reconcileCatalogue } from './catalogue-merge'
import { assertLedgerOwner, type LedgerOwnerContext } from './ledger-account'
import { makeSyncConflict, meaningfulRecordChanged, shouldArchiveRemoteConflict } from './sync-conflicts'

const state = vi.hoisted(() => ({
  local: { suppliers: new Map<string, any>(), projects: new Map<string, any>(), tickets: new Map<string, any>(), ticket_refunds: new Map<string, any>(), show79_settlements: new Map<string, any>() },
  cloud: { suppliers: new Map<string, any>(), projects: new Map<string, any>(), tickets: new Map<string, any>(), ticket_refunds: new Map<string, any>(), show79_settlements: new Map<string, any>() },
  rejectRefundWrite: false,
  loseRefundResponse: false,
  uploads: [] as { table: string; records: any[] }[],
  duringUpload: null as null | ((table: string) => void),
  settings: { localUserId: 'anonymous', lastCloudUserId: 'user-1' as string | null, activeCloudUserId: null as string | null },
  operations: new Map<string, any>(),
  conflicts: new Map<string, any>(),
  baselines: new Map<string, any>(),
  rejectTicketIds: new Set<string>(),
  beforeTicketWrite: null as null | (() => Promise<void>),
  beforeTicketRead: null as null | (() => Promise<void>)
}))

type Table = keyof typeof state.local
const copy = (value: any) => ({ ...value })
const guard = (owner?: LedgerOwnerContext, userId?: string) => { if (owner) assertLedgerOwner(state.settings, owner, userId) }
const mergeRows = async (table: Table, records: any[], owner?: LedgerOwnerContext, locked: Set<string> = new Set(), acknowledged: any[] = []) => {
  guard(owner)
  for (const remote of records) {
    guard(owner, remote.userId)
    const current = state.local[table].get(remote.id)
    const baseKey = `${table}:${remote.userId}:${remote.id}`
    const base = state.baselines.get(baseKey)
    const ownAck = acknowledged.some(row => row.id === remote.id && !meaningfulRecordChanged(row, remote))
    const refundLocked = table === 'tickets' && locked.has(remote.id) && current?.syncStatus !== 'synced' && current && meaningfulRecordChanged(current, remote)
    const changedBase = current && current.syncStatus !== 'synced' && base && meaningfulRecordChanged(base, remote) && meaningfulRecordChanged(current, remote)
    const adopt = refundLocked || !ownAck && (changedBase || current && table !== 'show79_settlements' && shouldArchiveRemoteConflict(current, remote))
    if (current && table !== 'show79_settlements' && adopt) {
      const conflict = makeSyncConflict(table, current, remote, refundLocked ? 'refund_locked' : 'remote_newer', '本机修改已保留', new Date().toISOString())
      if (!state.conflicts.has(conflict.id)) state.conflicts.set(conflict.id, conflict)
    }
    state.local[table].set(remote.id, adopt ? { ...remote, syncStatus: 'synced' } : mergeRemoteRecord(current, remote))
    state.baselines.set(baseKey, copy(remote))
  }
}

vi.mock('./db', () => ({ db: {
  getSettings: async () => ({ ...state.settings }),
  getOrCreateSettings: async () => ({ ...state.settings }),
  activateAccount: async (userId: string | null, cloud: boolean, isCurrent: () => boolean) => {
    if (!isCurrent()) throw new Error('账号已切换')
    state.settings.activeCloudUserId = cloud ? userId : null
    if (cloud && userId) state.settings.lastCloudUserId = userId
    return { ...state.settings }
  },
  getTicketCreateOperation: async (id: string, owner: LedgerOwnerContext) => {
    guard(owner)
    const receipt = state.operations.get(`${owner.userId}:${id}`)
    return receipt ? { receipt, ticket: state.local.tickets.get(receipt.ticketId) ?? receipt.acceptedRecord } : undefined
  },
  putNewTicketOnce: async (record: TicketRecord, fingerprint: string, owner: LedgerOwnerContext) => {
    await state.beforeTicketWrite?.()
    guard(owner, record.userId)
    const key = `${owner.userId}:${record.id}`
    const receipt = state.operations.get(key)
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error('这次提交已经保存过不同内容')
      return state.local.tickets.get(record.id) ?? receipt.acceptedRecord
    }
    state.local.tickets.set(record.id, copy(record))
    state.operations.set(key, { fingerprint, ticketId: record.id, acceptedRecord: copy(record) })
    return copy(record)
  },
  putMedicineTicketsOnce: async (rows: { ticket: TicketRecord; fingerprint: string; projectUpdatedAt?: string; supplierUpdatedAt?: string }[], owner: LedgerOwnerContext) => {
    await state.beforeTicketWrite?.()
    guard(owner)
    const additions: { ticket: TicketRecord; fingerprint: string; key: string }[] = []
    const accepted = rows.map(row => {
      const ticket = row.ticket
      guard(owner, ticket.userId)
      const key = `${owner.userId}:${ticket.id}`
      const receipt = state.operations.get(key)
      const current = state.local.tickets.get(ticket.id)
      if (receipt) {
        if (receipt.fingerprint !== row.fingerprint) throw new Error('这批药品中有提交编号已保存过不同内容')
        return current ?? receipt.acceptedRecord
      }
      if (current && (current.userId !== owner.userId || meaningfulRecordChanged(current, ticket))) throw new Error('此药品提交编号已有其他记录')
      const project = state.local.projects.get(ticket.projectId!)
      const supplier = state.local.suppliers.get(ticket.supplierId)
      if (!project || !supplier || project.userId !== owner.userId || supplier.userId !== owner.userId || project.updatedAt !== row.projectUpdatedAt || supplier.updatedAt !== row.supplierUpdatedAt) throw new Error('药品套餐或供货商已变化')
      const record = current ?? ticket
      additions.push({ ticket: record, fingerprint: row.fingerprint, key })
      return record
    })
    guard(owner)
    for (const row of additions) {
      state.local.tickets.set(row.ticket.id, copy(row.ticket))
      state.operations.set(row.key, { fingerprint: row.fingerprint, ticketId: row.ticket.id, acceptedRecord: copy(row.ticket) })
    }
    return accepted.map(copy)
  },
  getSyncConflicts: async () => [...state.conflicts.values()],
  resolveSyncConflict: async (id: string, owner: LedgerOwnerContext) => { guard(owner); const row = state.conflicts.get(id); if (!row || row.userId !== owner.userId) throw new Error('当前账号'); state.conflicts.set(id, { ...row, resolvedAt: new Date().toISOString() }) },
  quarantineTicket: async (id: string, remote: TicketRecord | undefined, message: string, owner: LedgerOwnerContext) => {
    guard(owner)
    const current = state.local.tickets.get(id)
    if (current?.userId !== owner.userId || current.syncStatus === 'synced') return
    const conflict = makeSyncConflict('tickets', current, remote ?? null, 'upload_rejected', message, new Date().toISOString())
    if (!state.conflicts.has(conflict.id)) state.conflicts.set(conflict.id, conflict)
    state.local.tickets.set(id, remote ? { ...remote, syncStatus: 'synced' } : { ...current, syncStatus: 'error' })
  },
  getTickets: async () => { await state.beforeTicketRead?.(); return [...state.local.tickets.values()].map(copy) },
  getTicket: async (id: string) => state.local.tickets.get(id),
  getRefunds: async () => [...state.local.ticket_refunds.values()].map(copy),
  getShow79Settlements: async () => [...state.local.show79_settlements.values()].map(copy),
  mergeRemoteShow79Settlements: (records: any[], owner?: LedgerOwnerContext) => mergeRows('show79_settlements', records, owner),
  getRefund: async (id: string) => state.local.ticket_refunds.get(id),
  putRefund: async (record: RefundRecord, owner?: LedgerOwnerContext) => { guard(owner, record.userId); state.local.ticket_refunds.set(record.id, copy(record)) },
  mergeRemoteRefunds: (records: any[], owner?: LedgerOwnerContext) => mergeRows('ticket_refunds', records, owner),
  getSuppliers: async () => [...state.local.suppliers.values()].filter(row => !row.mergedIntoId).map(copy),
  getProjects: async () => [...state.local.projects.values()].filter(row => !row.mergedIntoId).map(copy),
  reconcileCatalogue: async (userId: string, suppliers: any[], projects: any[]) => {
    const result = reconcileCatalogue({ suppliers: [...state.local.suppliers.values()], projects: [...state.local.projects.values()], tickets: [...state.local.tickets.values()] }, { suppliers, projects }, userId)
    for (const row of result.suppliers) state.local.suppliers.set(row.id, copy(row))
    for (const row of result.projects) state.local.projects.set(row.id, copy(row))
    for (const row of result.tickets) state.local.tickets.set(row.id, copy(row))
  },
  putProject: async (project: Project, owner?: LedgerOwnerContext) => { guard(owner, project.userId); state.local.projects.set(project.id, copy(project)) },
  putTicket: async (ticket: TicketRecord, owner?: LedgerOwnerContext) => { await state.beforeTicketWrite?.(); guard(owner, ticket.userId); state.local.tickets.set(ticket.id, copy(ticket)) },
  mergeRemoteTickets: (records: any[], owner?: LedgerOwnerContext, locked?: Set<string>, ack?: any[]) => mergeRows('tickets', records, owner, locked, ack),
  mergeRemoteSuppliers: (records: any[], owner?: LedgerOwnerContext, locked?: Set<string>, ack?: any[]) => mergeRows('suppliers', records, owner, locked, ack),
  mergeRemoteProjects: (records: any[], owner?: LedgerOwnerContext, locked?: Set<string>, ack?: any[]) => mergeRows('projects', records, owner, locked, ack)
} }))

vi.mock('./supabase', () => ({ getSupabase: () => ({
  from: (table: Table) => {
    const query = (write?: any[], mode = 'upsert') => {
      const filters: Record<string, string> = {}
      let offset = 0
      let end = 499
      const builder = {
        eq: (column: string, value: string) => { filters[column] = value; return builder },
        order: () => builder,
        range: (start: number, last: number) => { offset = start; end = last; return builder },
        abortSignal: async () => {
          const matches = (row: any) => Object.entries(filters).every(([key, value]) => key === 'updated_at' ? Date.parse(row[key]) === Date.parse(value) : row[key] === value)
          if (write) {
            if (table === 'ticket_refunds' && state.rejectRefundWrite) return { error: { message: '云端拒绝退票' }, data: null }
            state.uploads.push({ table, records: write.map(copy) })
            state.duringUpload?.(table)
            if (mode === 'insert' && write.some(row => state.cloud[table].has(row.id))) return { data: null, error: { code: '23505', message: 'duplicate key' } }
            const matchedWrite = mode === 'update' ? write.filter(row => state.cloud[table].has(row.id ?? filters.id) && matches(state.cloud[table].get(row.id ?? filters.id))) : write
            if (table === 'tickets' && matchedWrite.some(row => state.rejectTicketIds.has(row.id) || (state.cloud.tickets.has(row.id) && [...state.cloud.ticket_refunds.values()].some(refund => refund.ticket_id === row.id && refund.user_id === row.user_id) && ['note', 'agent_price_thb', 'cost_thb', 'deleted_at'].some(key => row[key] !== state.cloud.tickets.get(row.id)?.[key])))) return { data: null, error: { code: 'P0001', message: '原票已有退票，或记录校验失败' } }
            if (mode === 'update') {
              for (const [id, row] of state.cloud[table]) if (matches(row) && Date.parse(write[0].updated_at) > Date.parse(row.updated_at)) state.cloud[table].set(id, { ...row, ...write[0] })
              return { error: null, data: null }
            }
            for (const row of write) if (table === 'suppliers' || table === 'projects') {
              const duplicate = [...state.cloud[table].values()].some(other => other.id !== row.id && other.user_id === row.user_id && other.normalized_name === row.normalized_name && (table === 'suppliers' || other.supplier_id === row.supplier_id && other.normalized_sub_item_name === row.normalized_sub_item_name))
              if (duplicate) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' }, data: null }
            }
            for (const record of write) {
              const current = state.cloud[table].get(record.id)
              if (mode === 'insert' && current) return { error: { message: 'duplicate key' }, data: null }
              // Model the PostgreSQL trigger: a stale/equal timestamp is ignored.
              if (!current || new Date(record.updated_at).getTime() > new Date(current.updated_at).getTime()) {
                state.cloud[table].set(record.id, copy(record))
              }
            }
            return { error: table === 'ticket_refunds' && state.loseRefundResponse ? { message: '响应丢失' } : null, data: null }
          }
          return {
            error: null,
            data: [...state.cloud[table].values()].filter(matches).slice(offset, end + 1).map(copy)
          }
        }
      }
      return builder
    }
    return { select: () => query(), upsert: (rows: any[]) => query(rows), insert: (row: any) => query(Array.isArray(row) ? row : [row], 'insert'), update: (row: any) => query([row], 'update') }
  }
}) }))

import { ledgerRepository } from './repository'

const user = { id: 'user-1' } as User
const localTicket = (updatedAt: string, note = ''): TicketRecord => ({
  id: 'ticket-1', userId: user.id, issueDate: '2026-10-13', supplierId: 'supplier-1', supplierName: '供货商',
  projectId: 'project-1', projectName: '景点门票', subItemName: '', agentPriceThb: 1000, costThb: 700, note,
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt, deletedAt: null, syncStatus: 'pending'
})
const cloudTicket = (updatedAt: string, note = '') => ({
  id: 'ticket-1', user_id: user.id, issue_date: '2026-10-13', supplier_id: 'supplier-1', supplier_name: '供货商',
  project_id: 'project-1', project_name: '景点门票', sub_item_name: '', agent_price_thb: 1000, cost_thb: 700, note,
  created_at: '2026-10-13T00:00:00.000Z', updated_at: updatedAt, deleted_at: null
})

describe('confirmed cloud refunds', () => {
  const prepare = () => {
    const ticket = { ...localTicket('2026-10-13T00:00:00Z'), amountBasis: 'per_person' as const, personCount: 3, agentPriceThb: 650, costThb: 600, syncStatus: 'synced' as const }
    state.local.tickets.set(ticket.id, ticket)
    state.cloud.tickets.set(ticket.id, { ...cloudTicket(ticket.updatedAt), amount_basis: 'per_person', person_count: 3, agent_price_thb: 650, cost_thb: 600 })
    const input: RefundInput = { operationId: 'refund-1', ticketId: ticket.id, personCount: 1, isFull: false, refundRevenueThb: 650, returnedCostThb: 550, refundDate: '2026-10-14', refundTime: '09:30', note: '手续费50' }
    return { ticket, input }
  }
  it('records actual cash movements separately without changing original prices or date', async () => {
    const { ticket, input } = prepare()
    await ledgerRepository.createRefund(input)
    const [projected] = await ledgerRepository.getTickets()
    expect(getTicketAmounts(projected)).toMatchObject({ agentPriceThb: 1300, costThb: 1250, profitThb: 50 })
    expect(projected.issueDate).toBe('2026-10-13')
    expect(state.local.tickets.get(ticket.id)).toEqual(ticket)
    expect(projected.refunds).toHaveLength(1)
  })
  it('deduplicates a retry after a lost response, even after a full refund', async () => {
    const { input } = prepare()
    const full = { ...input, isFull: true, refundRevenueThb: 1950, returnedCostThb: 1800 }
    state.loseRefundResponse = true
    const receipt = await ledgerRepository.createRefund(full)
    expect(await ledgerRepository.createRefund(full)).toEqual(receipt)
    expect(state.cloud.ticket_refunds.size).toBe(1)
    expect(state.local.ticket_refunds.size).toBe(1)
    expect(receipt.personCount).toBe(3)
  })
  it('does not cache an unconfirmed refund or allow a reused operation ID with changed amounts', async () => {
    const { input } = prepare()
    state.rejectRefundWrite = true
    await expect(ledgerRepository.createRefund(input)).rejects.toThrow('云端拒绝')
    expect(state.local.ticket_refunds.size).toBe(0)
    state.rejectRefundWrite = false
    await ledgerRepository.createRefund(input)
    await expect(ledgerRepository.createRefund({ ...input, returnedCostThb: 600 })).rejects.toThrow('编号已使用')
    expect(state.cloud.ticket_refunds.size).toBe(1)
  })
  it('requires online access and a synced original ticket', async () => {
    const { ticket, input } = prepare()
    vi.stubGlobal('navigator', { onLine: false })
    await expect(ledgerRepository.createRefund(input)).rejects.toThrow('联网')
    vi.stubGlobal('navigator', { onLine: true })
    state.local.tickets.set(ticket.id, { ...ticket, syncStatus: 'pending' })
    await expect(ledgerRepository.createRefund(input)).rejects.toThrow('原票尚未同步')
    expect(state.cloud.ticket_refunds.size).toBe(0)
  })
  it('voids a refund idempotently, restores statistics, and preserves the history', async () => {
    const { ticket, input } = prepare()
    await ledgerRepository.createRefund(input)
    await ledgerRepository.cancelRefund(input.operationId)
    await ledgerRepository.cancelRefund(input.operationId)
    const [restored] = await ledgerRepository.getTickets()
    expect(getTicketAmounts(restored).profitThb).toBe(150)
    expect(restored.refunds?.[0].cancelledAt).toBeTruthy()
    expect(state.local.ticket_refunds.size).toBe(1)
    await expect(ledgerRepository.deleteTicket(ticket)).rejects.toThrow('不可删除')
    await expect(ledgerRepository.createOrUpdateTicket({ issueDate: ticket.issueDate, issueTime: '09:30', supplierName: ticket.supplierName, projectId: ticket.projectId!, projectName: ticket.projectName, subItemName: '', agentPriceThb: 650, costThb: 600, personCount: 3, note: '' }, ticket)).rejects.toThrow('不可编辑')
    expect((await ledgerRepository.createRefund(input)).cancelledAt).toBeTruthy()
    expect(state.cloud.ticket_refunds.size).toBe(1)
  })
  it('leaves local statistics unchanged when cloud cancellation is rejected', async () => {
    const { input } = prepare()
    await ledgerRepository.createRefund(input)
    state.rejectRefundWrite = true
    await expect(ledgerRepository.cancelRefund(input.operationId)).rejects.toThrow('云端拒绝')
    expect((await ledgerRepository.getRefunds())[0].cancelledAt).toBeNull()
    expect(getTicketAmounts((await ledgerRepository.getTickets())[0]).profitThb).toBe(50)
  })
  it('pulls receipts and cancellations to a second device without uploading duplicates', async () => {
    const { input } = prepare()
    await ledgerRepository.createRefund(input)
    state.local.ticket_refunds.clear()
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(getTicketAmounts((await ledgerRepository.getTickets())[0]).profitThb).toBe(50)
    const remote = state.cloud.ticket_refunds.get(input.operationId)
    state.cloud.ticket_refunds.set(remote.id, { ...remote, cancelled_at: '2099-01-01T00:00:00Z', updated_at: '2099-01-01T00:00:00Z' })
    await ledgerRepository.synchronise(user)
    expect(getTicketAmounts((await ledgerRepository.getTickets())[0]).profitThb).toBe(150)
    expect(state.cloud.ticket_refunds.size).toBe(1)
    expect(state.uploads.filter((row) => row.table === 'ticket_refunds')).toHaveLength(1)
  })
  it('rejects unavailable and other-account records and hides other-account receipts', async () => {
    const { input, ticket } = prepare()
    state.local.tickets.set(ticket.id, { ...ticket, userId: 'user-2' })
    await expect(ledgerRepository.createRefund(input)).rejects.toThrow('当前账号')
    state.local.ticket_refunds.set('foreign', { id: 'foreign', userId: 'user-2', ticketId: ticket.id })
    expect(await ledgerRepository.getTickets()).toEqual([])
    expect(await ledgerRepository.getRefunds()).toEqual([])
  })
})

beforeEach(async () => {
  vi.stubGlobal('navigator', { onLine: true })
  for (const table of ['suppliers', 'projects', 'tickets', 'ticket_refunds'] as const) {
    state.local[table].clear()
    state.cloud[table].clear()
  }
  state.uploads.length = 0
  state.duringUpload = null
  state.rejectRefundWrite = false
  state.loseRefundResponse = false
  state.beforeTicketWrite = null
  state.beforeTicketRead = null
  state.rejectTicketIds.clear()
  state.operations.clear()
  state.conflicts.clear()
  state.baselines.clear()
  await ledgerRepository.activateAccount(null)
  await ledgerRepository.activateAccount(user.id)
})

describe('cloud synchronization races', () => {
  const remoteSupplier = { id: 'cloud-s', user_id: user.id, name: '供货商', normalized_name: '供货商', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  const localSupplier = { id: 'local-s', userId: user.id, name: '供货商', normalizedName: '供货商', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', syncStatus: 'pending' }
  it('recovers an existing duplicate supplier, downloads projects and tickets, and never uploads its old ID', async () => {
    state.local.suppliers.set(localSupplier.id, localSupplier)
    state.cloud.suppliers.set(remoteSupplier.id, remoteSupplier)
    state.cloud.projects.set('cloud-p', { id: 'cloud-p', user_id: user.id, supplier_id: 'cloud-s', supplier_name: '供货商', name: '项目', normalized_name: '项目', sub_item_name: '', normalized_sub_item_name: '', default_cost_thb: 600, default_agent_price_thb: 650, created_at: remoteSupplier.created_at, updated_at: remoteSupplier.updated_at })
    state.cloud.tickets.set('ticket-1', cloudTicket(remoteSupplier.updated_at))
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.local.suppliers.get('local-s')).toMatchObject({ mergedIntoId: 'cloud-s' })
    expect(await ledgerRepository.getSuppliers()).toHaveLength(1)
    expect(await ledgerRepository.getProjects()).toHaveLength(1)
    expect(await ledgerRepository.getTickets()).toHaveLength(1)
    expect(state.uploads).toEqual([])
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
  })
  it('reconciles a same-name supplier created by another device between pull and upload', async () => {
    state.local.suppliers.set(localSupplier.id, localSupplier)
    state.duringUpload = table => { if (table === 'suppliers') { state.cloud.suppliers.set(remoteSupplier.id, remoteSupplier); state.duringUpload = null } }
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.local.suppliers.get('local-s')).toMatchObject({ mergedIntoId: 'cloud-s' })
    expect(state.cloud.suppliers.size).toBe(1)
    expect(state.uploads).toHaveLength(1)
  })
  it('does not silently discard unique local suppliers while resolving duplicates', async () => {
    state.local.suppliers.set(localSupplier.id, localSupplier)
    state.local.suppliers.set('unique-s', { ...localSupplier, id: 'unique-s', name: '另一供货商', normalizedName: '另一供货商' })
    state.cloud.suppliers.set(remoteSupplier.id, remoteSupplier)
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.cloud.suppliers.size).toBe(2)
    expect(state.cloud.suppliers.get('unique-s').normalized_name).toBe('另一供货商')
    expect(await ledgerRepository.getSuppliers()).toHaveLength(2)
  })
  it('does not write unchanged records when realtime requests another pass', async () => {
    state.local.tickets.set('ticket-1', localTicket('2026-10-13T01:00:00.000Z'))
    state.cloud.tickets.set('ticket-1', cloudTicket('2026-10-13T01:00:00+00:00'))
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.uploads).toEqual([])
    expect(state.local.tickets.get('ticket-1').syncStatus).toBe('synced')
  })

  it('reads back a newer cloud write instead of falsely acknowledging a rejected upload', async () => {
    state.local.tickets.set('ticket-1', localTicket('2026-10-13T01:00:01.000Z', 'this device'))
    state.cloud.tickets.set('ticket-1', cloudTicket('2026-10-13T01:00:00.000Z'))
    state.duringUpload = (table) => {
      if (table === 'tickets') state.cloud.tickets.set('ticket-1', cloudTicket('2026-10-13T01:00:03.000Z', 'other device'))
    }
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.local.tickets.get('ticket-1')).toMatchObject({ note: 'other device', updatedAt: '2026-10-13T01:00:03.000Z', syncStatus: 'synced' })
    expect(state.cloud.tickets.get('ticket-1').note).toBe('other device')
  })

  it('preserves a local edit during upload and sends it on the queued next pass', async () => {
    state.local.tickets.set('ticket-1', localTicket('2026-10-13T01:00:01.000Z', 'first edit'))
    state.cloud.tickets.set('ticket-1', cloudTicket('2026-10-13T01:00:00.000Z'))
    state.duringUpload = (table) => {
      if (table === 'tickets') state.local.tickets.set('ticket-1', localTicket('2026-10-13T01:00:02.000Z', 'edited during upload'))
    }
    await ledgerRepository.synchronise(user)
    expect(state.local.tickets.get('ticket-1')).toMatchObject({ note: 'edited during upload', syncStatus: 'pending' })
    state.duringUpload = null
    await ledgerRepository.synchronise(user)
    expect(state.cloud.tickets.get('ticket-1')).toMatchObject({ note: 'edited during upload', updated_at: '2026-10-13T01:00:02.000Z' })
    expect(state.local.tickets.get('ticket-1').syncStatus).toBe('synced')
    expect(state.uploads).toHaveLength(2)
  })
})

const localProject = (): Project => ({
  id: 'project-1', userId: user.id, supplierId: 'supplier-1', supplierName: '示例供货商',
  name: '示例景点', normalizedName: '示例景点',
  subItemName: '儿童票', normalizedSubItemName: '儿童票',
  defaultCostThb: 700, defaultAgentPriceThb: 900,
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T01:00:00.000Z', syncStatus: 'synced'
})

describe('project price corrections', () => {
  it('rejects sub-cent project amounts before changing defaults', async () => {
    state.local.projects.set('project-1', localProject())
    await expect(ledgerRepository.updateProjectPrices('project-1', { defaultCostThb: 95.001, defaultAgentPriceThb: 100 })).rejects.toThrow('两位小数')
    expect(state.local.projects.get('project-1')).toEqual(localProject())
  })
  it('allows commission rule edits but never assigns default sales or costs', async () => {
    state.local.projects.set('project-1', { ...localProject(), entryMode: 'profit_only', defaultCostThb: 0, defaultAgentPriceThb: 0 })
    await expect(ledgerRepository.updateProjectPrices('project-1', { defaultCostThb: 100, defaultAgentPriceThb: 200, defaultAmountBasis: 'total', settlementMode: 'daily' })).resolves.toMatchObject({ defaultCostThb: 0, defaultAgentPriceThb: 0, defaultAmountBasis: 'total', settlementMode: 'monthly' })
  })
  it('updates only the existing project prices, preserving identity, other packages and old tickets', async () => {
    const original = { ...localProject(), updatedAt: '2099-01-01T00:00:00.000Z' }
    const other = { ...localProject(), id: 'project-2', subItemName: '成人票' }
    const ticket = localTicket('2026-10-13T01:00:00.000Z')
    state.local.projects.set(original.id, original)
    state.local.projects.set(other.id, other)
    state.local.tickets.set(ticket.id, ticket)
    const updated = await ledgerRepository.updateProjectPrices(original.id, { defaultCostThb: 600, defaultAgentPriceThb: 900 })
    expect(updated).toMatchObject({ ...original, defaultCostThb: 600, syncStatus: 'pending', updatedAt: expect.any(String) })
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(original.updatedAt).getTime())
    expect(state.local.projects.size).toBe(2)
    expect(state.local.projects.get(other.id)).toEqual(other)
    expect(state.local.tickets.get(ticket.id)).toEqual(ticket)
  })

  it.each([
    [-1, 900], [NaN, 900], [Infinity, 900],
    [600, -1], [600, NaN], [600, Infinity]
  ])('rejects invalid cost %s or price %s without changing the record', async (cost, price) => {
    const original = localProject()
    state.local.projects.set(original.id, original)
    await expect(ledgerRepository.updateProjectPrices(original.id, { defaultCostThb: cost, defaultAgentPriceThb: price })).rejects.toThrow('大于或等于 0')
    expect(state.local.projects.get(original.id)).toEqual(original)
  })

  it('accepts deliberate zero prices', async () => {
    state.local.projects.set('project-1', localProject())
    expect(await ledgerRepository.updateProjectPrices('project-1', { defaultCostThb: 0, defaultAgentPriceThb: 0 }))
      .toMatchObject({ id: 'project-1', defaultCostThb: 0, defaultAgentPriceThb: 0 })
  })

  it.each(['missing', 'other-project'])('rejects unavailable or other-account project %s', async (id) => {
    const original = { ...localProject(), id: 'other-project', userId: 'user-2' }
    state.local.projects.set(original.id, original)
    await expect(ledgerRepository.updateProjectPrices(id, { defaultCostThb: 600, defaultAgentPriceThb: 900 })).rejects.toThrow('当前账号无法修改')
    expect(state.local.projects.get(original.id)).toEqual(original)
    expect(state.local.projects.size).toBe(1)
  })

  it('synchronizes the correction using the same cloud record ID', async () => {
    const original = localProject()
    state.local.projects.set('project-1', original)
    state.cloud.projects.set('project-1', {
      id: original.id, user_id: original.userId, supplier_id: original.supplierId, supplier_name: original.supplierName,
      name: original.name, normalized_name: original.normalizedName, sub_item_name: original.subItemName,
      normalized_sub_item_name: original.normalizedSubItemName, default_cost_thb: original.defaultCostThb,
      default_agent_price_thb: original.defaultAgentPriceThb, created_at: original.createdAt, updated_at: original.updatedAt
    })
    await ledgerRepository.updateProjectPrices('project-1', { defaultCostThb: 600, defaultAgentPriceThb: 900 })
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.cloud.projects.size).toBe(1)
    expect(state.cloud.projects.get('project-1')).toMatchObject({ id: 'project-1', user_id: user.id, default_cost_thb: 600, default_agent_price_thb: 900 })
    expect(state.local.projects.get('project-1').syncStatus).toBe('synced')
  })
})

describe('project default and settlement persistence', () => {
  const prepare = () => {
    const row = localProject()
    state.local.projects.set(row.id, row)
    state.local.suppliers.set(row.supplierId, { id: row.supplierId, userId: user.id, name: row.supplierName, normalizedName: row.supplierName, createdAt: row.createdAt, updatedAt: row.updatedAt, syncStatus: 'pending' })
    const input: TicketInput = { supplierName: row.supplierName, projectId: row.id, projectName: row.name, subItemName: row.subItemName, issueDate: '2026-10-15', issueTime: '12:00', amountBasis: 'total', personCount: 4, costThb: 700, agentPriceThb: 900, note: '' }
    return { row, input }
  }
  it('saves explicit project rules and ticket snapshots, then downloads them unchanged to another device', async () => {
    const { row, input } = prepare()
    await ledgerRepository.updateProjectPrices(row.id, { defaultCostThb: 700, defaultAgentPriceThb: 900, defaultAmountBasis: 'total', settlementMode: 'monthly' })
    const saved = await ledgerRepository.createOrUpdateTicket(input)
    expect(saved).toMatchObject({ settlementMode: 'monthly', amountBasis: 'total', personCount: 4 })
    expect(getTicketAmounts(saved).profitThb).toBe(200)
    await ledgerRepository.synchronise(user)
    expect(state.cloud.projects.get(row.id)).toMatchObject({ default_amount_basis: 'total', settlement_mode: 'monthly' })
    expect(state.cloud.tickets.get(saved.id).settlement_mode).toBe('monthly')
    state.local.projects.clear(); state.local.tickets.clear()
    await ledgerRepository.synchronise(user)
    expect(state.local.projects.get(row.id)).toMatchObject({ defaultAmountBasis: 'total', settlementMode: 'monthly' })
    expect(state.local.tickets.get(saved.id)).toMatchObject({ settlementMode: 'monthly', personCount: 4, agentPriceThb: 900 })
  })
  it('uses the package default when an internal caller omits the price basis', async () => {
    const { row, input } = prepare()
    state.local.projects.set(row.id, { ...row, defaultAmountBasis: 'total' })
    const saved = await ledgerRepository.createOrUpdateTicket({ ...input, amountBasis: undefined })
    expect(saved.amountBasis).toBe('total')
    expect(getTicketAmounts(saved).profitThb).toBe(200)
  })
  it('permits cached offline saves with defaults and per-record pricing overrides without changing catalogue', async () => {
    const { row, input } = prepare()
    state.local.projects.set(row.id, { ...row, defaultAmountBasis: 'total', settlementMode: 'monthly' })
    vi.stubGlobal('navigator', { onLine: false })
    const saved = await ledgerRepository.createOrUpdateTicket({ ...input, amountBasis: 'per_person', settlementMode: 'monthly' })
    expect(saved).toMatchObject({ amountBasis: 'per_person', settlementMode: 'monthly', syncStatus: 'pending' })
    expect(getTicketAmounts(saved).profitThb).toBe(800)
    expect(state.local.projects.get(row.id).defaultAmountBasis).toBe('total')
    vi.stubGlobal('navigator', { onLine: true })
    await ledgerRepository.synchronise(user)
    await ledgerRepository.synchronise(user)
    expect(state.cloud.tickets.size).toBe(1)
  })
  it.each([undefined, 'daily', 'monthly'] as const)('preserves historical settlement %s, pricing and quantity when project rules change', async settlementMode => {
    const { row, input } = prepare()
    const original = { ...localTicket('2026-10-13T01:00:00Z'), ...input, settlementMode }
    state.local.tickets.set(original.id, original)
    await ledgerRepository.updateProjectPrices(row.id, { defaultCostThb: 1, defaultAgentPriceThb: 2, defaultAmountBasis: 'per_person', settlementMode: 'monthly', quantityUnit: 'item' })
    expect(state.local.tickets.get(original.id)).toEqual(original)
    const saved = await ledgerRepository.createOrUpdateTicket({ ...input, note: '仅修改备注', settlementMode: 'monthly' }, original)
    expect(saved).toMatchObject({ agentPriceThb: 900, costThb: 700, amountBasis: 'total', quantityUnit: 'person', settlementMode, personCount: 4 })
  })
})

describe('manual selling prices and item quantity sync', () => {
  it('creates unbound car packages, requires actual supplier and both amounts, and syncs actual tickets unchanged', async () => {
    const { project } = prepare()
    const row = await ledgerRepository.createProject({ supplierId: '', manualSupplier: true, manualCostPrice: true, manualAgentPrice: true, name: '叫车', subItemName: 'SUV', defaultCostThb: NaN, defaultAgentPriceThb: NaN, defaultAmountBasis: 'total', settlementMode: 'daily' })
    expect(row).toMatchObject({ supplierId: '', supplierName: '', manualSupplier: true, manualCostPrice: true, manualAgentPrice: true, defaultAmountBasis: 'total' })
    const input: TicketInput = { projectId: row.id, projectName: row.name, subItemName: row.subItemName, supplierName: project.supplierName, issueDate: '2026-10-17', issueTime: '10:30', personCount: 4, agentPriceThb: 800, costThb: 600, note: '' }
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, supplierName: '' })).rejects.toThrow('供货商')
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, costThb: NaN })).rejects.toThrow('成本')
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, agentPriceThb: NaN })).rejects.toThrow('代理售价')
    const saved = await ledgerRepository.createOrUpdateTicket(input)
    expect(getTicketAmounts(saved).profitThb).toBe(200)
    expect(saved.supplierId).toBe(project.supplierId)
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.cloud.projects.get(row.id)).toMatchObject({ supplier_id: null, supplier_name: '', manual_supplier: true, manual_cost_price: true })
    state.local.projects.clear(); state.local.tickets.clear()
    await ledgerRepository.synchronise(user)
    expect(state.local.projects.get(row.id)).toMatchObject({ supplierId: '', manualSupplier: true, manualCostPrice: true })
    expect(state.local.tickets.get(saved.id)).toMatchObject({ supplierId: project.supplierId, costThb: 600, agentPriceThb: 800, amountBasis: 'total', personCount: 4 })
    await ledgerRepository.updateProjectPrices(row.id, { manualCostPrice: false, manualAgentPrice: false, defaultCostThb: 400, defaultAgentPriceThb: 700 })
    expect(state.local.tickets.get(saved.id).costThb).toBe(600)
  })
  const prepare = () => {
    const project: Project = { ...localProject(), name: '药品', normalizedName: '药品', subItemName: '测试规格', normalizedSubItemName: '测试规格', quantityUnit: 'item', manualAgentPrice: true, defaultAgentPriceThb: 0, defaultCostThb: 95 }
    state.local.projects.set(project.id, project)
    state.local.suppliers.set(project.supplierId, { id: project.supplierId, userId: user.id, name: project.supplierName, normalizedName: project.supplierName, createdAt: project.createdAt, updatedAt: project.updatedAt, syncStatus: 'synced' })
    const input: TicketInput = { issueDate: '2026-10-14', issueTime: '09:30', quantityUnit: 'person', personCount: 2, amountBasis: 'per_person', supplierName: project.supplierName, projectId: project.id, projectName: project.name, subItemName: project.subItemName, costThb: 95, agentPriceThb: 150, note: '' }
    return { project, input }
  }
  it('requires an explicitly entered price and records the authoritative project quantity unit', async () => {
    const { input } = prepare()
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, agentPriceThb: NaN })).rejects.toThrow('代理售价')
    expect(state.local.tickets.size).toBe(0)
    const saved = await ledgerRepository.createOrUpdateTicket(input)
    expect(saved).toMatchObject({ quantityUnit: 'item', personCount: 2, agentPriceThb: 150, costThb: 95 })
    expect(getTicketAmounts(saved).profitThb).toBe(110)
    const explicitZero = await ledgerRepository.createOrUpdateTicket({ ...input, agentPriceThb: 0 })
    expect(getTicketAmounts(explicitZero).profitThb).toBe(-190)
  })
  it('round-trips catalogue flags, quantity units and entered prices to another device', async () => {
    const { project, input } = prepare()
    const saved = await ledgerRepository.createOrUpdateTicket(input)
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.cloud.projects.get(project.id)).toMatchObject({ quantity_unit: 'item', manual_agent_price: true, default_agent_price_thb: 0, default_cost_thb: 95 })
    expect(state.cloud.tickets.get(saved.id)).toMatchObject({ quantity_unit: 'item', person_count: 2, agent_price_thb: 150, cost_thb: 95 })
    state.local.projects.clear(); state.local.tickets.clear()
    await ledgerRepository.synchronise(user)
    expect((await ledgerRepository.getProjects())[0]).toMatchObject({ quantityUnit: 'item', manualAgentPrice: true })
    expect((await ledgerRepository.getTickets())[0]).toMatchObject({ quantityUnit: 'item', personCount: 2, agentPriceThb: 150, costThb: 95, syncStatus: 'synced' })
  })
  it('retains manual-price mode when correcting costs and never changes old transactions', async () => {
    const { project, input } = prepare()
    const saved = await ledgerRepository.createOrUpdateTicket(input)
    const storedOriginal = structuredClone(state.local.tickets.get(saved.id))
    const corrected = await ledgerRepository.updateProjectPrices(project.id, { defaultCostThb: 105, defaultAgentPriceThb: NaN })
    expect(corrected).toMatchObject({ manualAgentPrice: true, defaultAgentPriceThb: 0, defaultCostThb: 105, quantityUnit: 'item' })
    expect(state.local.tickets.get(saved.id)).toEqual(storedOriginal)
    expect(getTicketAmounts(saved).profitThb).toBe(110)
    expect(await ledgerRepository.updateProjectPrices(project.id, { defaultCostThb: 105, defaultAgentPriceThb: 160, manualAgentPrice: false })).toMatchObject({ manualAgentPrice: false, defaultAgentPriceThb: 160 })
  })
  it('can create a manual-price item package without assigning a fictitious actual selling price', async () => {
    const { project } = prepare()
    const created = await ledgerRepository.createProject({ supplierId: project.supplierId, name: '药品', subItemName: '新测试规格', defaultCostThb: 95, defaultAgentPriceThb: NaN, manualAgentPrice: true, quantityUnit: 'item' })
    expect(created).toMatchObject({ quantityUnit: 'item', manualAgentPrice: true, defaultAgentPriceThb: 0, defaultCostThb: 95 })
    expect(state.local.tickets.size).toBe(0)
  })
})

describe('project rename display aliases and sync', () => {
  const prepare = () => {
    const project: Project = { ...localProject(), name: '测试成人项目', normalizedName: '测试成人项目', subItemName: '普通票（成人）', normalizedSubItemName: '普通票（成人）' }
    state.local.projects.set(project.id, project)
    state.local.suppliers.set(project.supplierId, { id: project.supplierId, userId: user.id, name: project.supplierName, normalizedName: project.supplierName, createdAt: project.createdAt, updatedAt: project.updatedAt, syncStatus: 'synced' })
    return project
  }
  it('shows canonical labels before syncing without overwriting original catalogue or ticket snapshots', async () => {
    const project = prepare()
    const original = { ...localTicket(project.updatedAt), projectName: project.name, subItemName: project.subItemName }
    state.local.tickets.set(original.id, original)
    expect((await ledgerRepository.getProjects())[0]).toMatchObject({ name: '测试项目', subItemName: '普通票', defaultCostThb: project.defaultCostThb })
    expect(state.local.projects.get(project.id)).toEqual(project)
    expect((await ledgerRepository.getTickets())[0]).toMatchObject({ projectName: project.name, subItemName: project.subItemName })
    expect(state.local.tickets.get(original.id)).toEqual(original)
  })
  it('prevents an offline catalogue upload from reintroducing the removed text', async () => {
    const project = prepare()
    await ledgerRepository.synchronise(user)
    expect(state.cloud.projects.get(project.id)).toMatchObject({ id: project.id, name: '测试项目', sub_item_name: '普通票', normalized_name: '测试项目', normalized_sub_item_name: '普通票', default_cost_thb: project.defaultCostThb, default_agent_price_thb: project.defaultAgentPriceThb })
  })
  it('saves records chosen using renamed labels against a legacy cached project without changing prices', async () => {
    const project = prepare()
    const saved = await ledgerRepository.createOrUpdateTicket({ issueDate: '2026-10-14', issueTime: '09:30', projectId: project.id, projectName: '测试项目', subItemName: '普通票', supplierName: project.supplierName, agentPriceThb: 160, costThb: 100, personCount: 2, amountBasis: 'per_person', note: '' })
    expect(saved).toMatchObject({ projectId: project.id, projectName: '测试项目', subItemName: '普通票', agentPriceThb: 160, costThb: 100 })
    expect(getTicketAmounts(saved).profitThb).toBe(120)
  })
  it('detects duplicate labels after cleanup instead of creating a second package', async () => {
    const project = prepare()
    await expect(ledgerRepository.createProject({ supplierId: project.supplierId, name: '测试项目', subItemName: '普通票', defaultCostThb: 100, defaultAgentPriceThb: 160 })).rejects.toThrow('已存在')
    expect(state.local.projects.size).toBe(1)
  })
})

describe('profit-only entries and time synchronization', () => {
  const prepare = () => {
    const project = { ...localProject(), entryMode: 'profit_only' as const, defaultCostThb: 0, defaultAgentPriceThb: 0 }
    state.local.projects.set(project.id, project)
    state.local.suppliers.set(project.supplierId, { id: project.supplierId, userId: user.id, name: project.supplierName, normalizedName: project.supplierName, createdAt: project.createdAt, updatedAt: project.updatedAt, syncStatus: 'synced' })
    const original = { ...localTicket('2026-10-13T01:00:00.000Z'), entryMode: 'profit_only' as const, manualProfitThb: 100, agentPriceThb: 0, costThb: 0 }
    state.local.tickets.set(original.id, original)
    return { original, input: { issueDate: '2026-10-13', issueTime: '22:37', projectId: project.id, supplierName: project.supplierName, projectName: project.name, subItemName: project.subItemName, manualProfitThb: 123.45, agentPriceThb: NaN, costThb: NaN, note: '示例返佣' } }
  }
  it('saves and round-trips manual profit and Bangkok time without inventing revenue or cost', async () => {
    const { original, input } = prepare()
    const saved = await ledgerRepository.createOrUpdateTicket(input, original)
    expect(saved).toMatchObject({ entryMode: 'profit_only', manualProfitThb: 123.45, issueTime: '22:37', agentPriceThb: 0, costThb: 0, createdAt: original.createdAt })
    await ledgerRepository.synchronise(user)
    expect(state.cloud.tickets.get(saved.id)).toMatchObject({ entry_mode: 'profit_only', manual_profit_thb: 123.45, issue_time: '22:37' })
    expect(state.local.tickets.get(saved.id)).toMatchObject({ entryMode: 'profit_only', manualProfitThb: 123.45, issueTime: '22:37', syncStatus: 'synced' })
  })
  it.each([null, -1, NaN, Infinity])('rejects invalid profit %s', async (manualProfitThb) => {
    const { original, input } = prepare()
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, manualProfitThb }, original)).rejects.toThrow('利润金额')
    expect(state.local.tickets.get(original.id)).toEqual(original)
  })
  it('validates time and preserves unknown legacy time as null', async () => {
    const { original, input } = prepare()
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, issueTime: '24:00' }, original)).rejects.toThrow('曼谷时间')
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, issueTime: '' })).rejects.toThrow('曼谷时间')
    expect(await ledgerRepository.createOrUpdateTicket({ ...input, issueTime: '' }, original)).toMatchObject({ issueTime: null })
  })
  it('round-trips per-person commission and only multiplies on calculation', async () => {
    const { original, input } = prepare()
    const saved = await ledgerRepository.createOrUpdateTicket({ ...input, amountBasis: 'per_person', personCount: 3 }, original)
    expect(saved.manualProfitThb).toBe(123.45)
    expect(getTicketAmounts(saved).profitThb).toBe(370.35)
    await ledgerRepository.synchronise(user)
    expect(state.cloud.tickets.get(saved.id)).toMatchObject({ amount_basis: 'per_person', person_count: 3, manual_profit_thb: 123.45 })
    expect(getTicketAmounts(state.local.tickets.get(saved.id)).profitThb).toBe(370.35)
  })
})

describe('stable new-order submissions and authenticated ownership', () => {
  const prepare = (owner = user.id) => {
    const project = { ...localProject(), userId: owner }
    state.local.projects.set(project.id, project)
    state.local.suppliers.set(project.supplierId, { id: project.supplierId, userId: owner, name: project.supplierName, normalizedName: project.supplierName, createdAt: project.createdAt, updatedAt: project.updatedAt, syncStatus: 'synced' })
    return { guestName: '测试客户', personCount: 2, issueDate: '2026-10-13', issueTime: '10:30', projectId: project.id, supplierName: project.supplierName, projectName: project.name, subItemName: project.subItemName, agentPriceThb: 900, costThb: 700, note: '' } satisfies TicketInput
  }

  it('uses one accepted record for concurrent identical submissions and a retry after UI refresh failed', async () => {
    const input = prepare()
    const [first, second] = await Promise.all([ledgerRepository.createOrUpdateTicket(input, undefined, 'stable-new-order'), ledgerRepository.createOrUpdateTicket(input, undefined, 'stable-new-order')])
    expect(first.id).toBe('stable-new-order')
    expect(second).toEqual(first)
    // App can fail refreshing after the accepted write; its retained operation ID
    // still acknowledges the existing order after catalogue defaults have changed.
    state.local.projects.clear()
    const retry = await ledgerRepository.createOrUpdateTicket(input, undefined, 'stable-new-order')
    expect(retry).toEqual(first)
    expect(state.local.tickets.size).toBe(1)
    expect(state.operations.size).toBe(1)
  })

  it('rejects changed payload for an accepted operation rather than changing the saved ticket', async () => {
    const input = prepare()
    const original = await ledgerRepository.createOrUpdateTicket(input, undefined, 'accepted-new-order')
    const storedOriginal = structuredClone(state.local.tickets.get(original.id))
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, guestName: '另一位客户' }, undefined, original.id)).rejects.toThrow('不同内容')
    expect(state.local.tickets.get(original.id)).toEqual(storedOriginal)
    expect(state.local.tickets.size).toBe(1)
  })

  it('returns current same-owner refunds on an accepted creation retry without changing its original ticket', async () => {
    const input = prepare()
    const original = await ledgerRepository.createOrUpdateTicket(input, undefined, 'refunded-accepted-order')
    const refund: RefundRecord = { id: 'later-refund', userId: user.id, ticketId: original.id, personCount: 1, isFull: false,
      refundRevenueThb: 900, returnedCostThb: 700, refundDate: '2026-10-14', refundTime: '10:30', note: '', cancelledAt: null,
      createdAt: '2026-10-14T03:30:00Z', updatedAt: '2026-10-14T03:30:00Z', syncStatus: 'synced' }
    state.local.ticket_refunds.set(refund.id, refund)
    state.local.ticket_refunds.set('foreign-refund', { ...refund, id: 'foreign-refund', userId: 'user-2' })
    state.local.ticket_refunds.set('other-ticket-refund', { ...refund, id: 'other-ticket-refund', ticketId: 'another-ticket' })
    const retried = await ledgerRepository.createOrUpdateTicket(input, undefined, original.id)
    expect(retried.refunds).toEqual([refund])
    expect(getRefundState(retried).remainingPeople).toBe(1)
    expect(getTicketAmounts(retried).profitThb).toBe(200)
    expect(state.local.tickets.size).toBe(1)
    expect(state.local.tickets.get(original.id).personCount).toBe(2)
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, personCount: 3 }, retried)).rejects.toThrow('已有退票明细')
  })

  it('switches the local owner before any network work, including offline login to another account', async () => {
    const inputA = prepare()
    await ledgerRepository.createOrUpdateTicket(inputA, undefined, 'a-order')
    vi.stubGlobal('navigator', { onLine: false })
    await ledgerRepository.activateAccount('user-2')
    expect(state.settings.activeCloudUserId).toBe('user-2')
    expect(await ledgerRepository.getTickets()).toEqual([])
    expect(await ledgerRepository.getProjects()).toEqual([])
    expect((await ledgerRepository.synchronise({ id: 'user-2' } as User)).synced).toBe(false)
    expect(state.uploads).toEqual([])
    const inputB = prepare('user-2')
    const saved = await ledgerRepository.createOrUpdateTicket(inputB, undefined, 'b-order')
    expect(saved.userId).toBe('user-2')
    expect(state.local.tickets.get('a-order').userId).toBe(user.id)
    expect((await ledgerRepository.getTickets()).map(row => row.id)).toEqual(['b-order'])
  })

  it('returns no cached financial data and rejects writes immediately after logout', async () => {
    const input = prepare()
    await ledgerRepository.createOrUpdateTicket(input, undefined, 'own-order')
    await ledgerRepository.activateAccount(null)
    expect(await ledgerRepository.getTickets()).toEqual([])
    expect(await ledgerRepository.getSuppliers()).toEqual([])
    expect(await ledgerRepository.getProjects()).toEqual([])
    await expect(ledgerRepository.createOrUpdateTicket(input, undefined, 'after-logout')).rejects.toThrow('账号已切换')
    expect(state.local.tickets.size).toBe(1)
  })

  it('rejects a delayed old-account write when authentication changes before its transaction', async () => {
    const input = prepare()
    state.beforeTicketWrite = () => ledgerRepository.activateAccount('user-2')
    await expect(ledgerRepository.createOrUpdateTicket(input, undefined, 'old-account-late-write')).rejects.toThrow('账号已切换')
    expect(state.local.tickets.size).toBe(0)
    expect(state.operations.size).toBe(0)
  })

  it('does not return a delayed old-account read after authentication changes', async () => {
    const input = prepare()
    await ledgerRepository.createOrUpdateTicket(input, undefined, 'own-order')
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { finish = resolve })
    state.beforeTicketRead = async () => { entered(); await held }
    const read = ledgerRepository.getTickets()
    const expectedFailure = expect(read).rejects.toThrow('账号已切换')
    await started
    await ledgerRepository.activateAccount('user-2')
    finish()
    await expectedFailure
  })

  it('does not merge an old account acknowledgement after switching during an upload', async () => {
    const input = prepare()
    await ledgerRepository.createOrUpdateTicket(input, undefined, 'old-account-order')
    let changed = false
    state.duringUpload = () => {
      if (!changed) { changed = true; void ledgerRepository.activateAccount('user-2') }
    }
    const result = await ledgerRepository.synchronise(user)
    expect(result.synced).toBe(false)
    expect(result.message).toMatch(/账号已切换/)
    expect(await ledgerRepository.getTickets()).toEqual([])
    expect((await ledgerRepository.synchronise(user)).synced).toBe(false)
    expect(state.local.tickets.get('old-account-order').userId).toBe(user.id)
  })
})

describe('atomic medicine entries', () => {
  const prepare = () => {
    const projects: Project[] = [
      { ...localProject(), id: 'medicine-male', name: '药品', normalizedName: '药品', subItemName: '男', normalizedSubItemName: '男', quantityUnit: 'item', entryMode: 'standard', manualAgentPrice: true, defaultAmountBasis: 'per_person', settlementMode: 'daily', defaultAgentPriceThb: 0, defaultCostThb: 95 },
      { ...localProject(), id: 'medicine-female', name: '药品', normalizedName: '药品', subItemName: '女', normalizedSubItemName: '女', quantityUnit: 'item', entryMode: 'standard', manualAgentPrice: true, defaultAmountBasis: 'per_person', settlementMode: 'monthly', defaultAgentPriceThb: 0, defaultCostThb: 120 }
    ]
    for (const project of projects) state.local.projects.set(project.id, copy(project))
    state.local.suppliers.set('supplier-1', { id: 'supplier-1', userId: user.id, name: '示例供货商', normalizedName: '示例供货商', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T01:00:00Z', syncStatus: 'synced' })
    return projects.map((project, index) => ({ operationId: `medicine-operation-${index}`, input: {
      guestName: ' Jimmy ', issueDate: '2026-10-16', issueTime: '12:30', personCount: index ? 3 : 2,
      projectId: project.id, projectName: project.name, subItemName: project.subItemName,
      supplierName: project.supplierName, agentPriceThb: index ? 200 : 150,
      costThb: project.defaultCostThb, note: ' 同一客人 '
    } satisfies TicketInput }))
  }

  it('saves independent medicine quantities and prices using catalogue rules without changing defaults', async () => {
    const entries = prepare()
    const catalogue = structuredClone([...state.local.projects.values()])
    const rows = await ledgerRepository.createMedicineTickets(entries)
    expect(rows.map(row => row.id)).toEqual(entries.map(row => row.operationId))
    expect(rows.map(row => getTicketAmounts(row))).toEqual([
      { agentPriceThb: 300, costThb: 190, profitThb: 110 },
      { agentPriceThb: 600, costThb: 360, profitThb: 240 }
    ])
    expect(rows.reduce((total, row) => total + row.personCount!, 0)).toBe(5)
    expect(rows.map(row => row.settlementMode)).toEqual(['daily', 'monthly'])
    expect(rows.every(row => row.quantityUnit === 'item' && row.entryMode === 'standard' && row.guestName === 'Jimmy' && row.note === '同一客人')).toBe(true)
    expect([...state.local.projects.values()]).toEqual(catalogue)
    expect(state.local.tickets.size).toBe(2)
    expect(state.operations.size).toBe(2)
  })

  it('allows explicit zero prices, blank common guest names and legal per-row billing overrides', async () => {
    const entries = prepare().map(entry => ({ ...entry, input: { ...entry.input, guestName: '', amountBasis: 'total' as const, agentPriceThb: 0, quantityUnit: 'person' as const, entryMode: 'profit_only' as const, settlementMode: 'daily' as const } }))
    const rows = await ledgerRepository.createMedicineTickets(entries)
    expect(rows.map(row => getTicketAmounts(row).costThb)).toEqual([95, 120])
    expect(rows.map(row => row.settlementMode)).toEqual(['daily', 'monthly'])
    expect(rows.every(row => row.guestName === '' && row.quantityUnit === 'item' && row.entryMode === 'standard' && row.amountBasis === 'total' && row.manualProfitThb === null)).toBe(true)
  })

  it.each([
    ['missing manual sales price', { agentPriceThb: NaN }, /实际售价/],
    ['sub-cent amount', { costThb: 120.001 }, /两位小数/],
    ['invalid quantity', { personCount: 0 }, /数量/],
    ['invalid billing basis', { amountBasis: 'other' }, /计价方式/]
  ])('writes none of the batch when the second row has %s', async (_label, invalid, error) => {
    const entries = prepare()
    Object.assign(entries[1].input, invalid)
    await expect(ledgerRepository.createMedicineTickets(entries)).rejects.toThrow(error as RegExp)
    expect(state.local.tickets.size).toBe(0)
    expect(state.operations.size).toBe(0)
  })

  it('rechecks the catalogue before committing and leaves the complete batch unsaved if it changed', async () => {
    const entries = prepare()
    state.beforeTicketWrite = async () => { state.local.projects.get(entries[1].input.projectId).updatedAt = '2026-10-16T00:00:00Z' }
    await expect(ledgerRepository.createMedicineTickets(entries)).rejects.toThrow('已变化')
    expect(state.local.tickets.size).toBe(0)
    expect(state.operations.size).toBe(0)
  })

  it('rejects a non-medicine or foreign-account catalogue item before writing any line', async () => {
    const entries = prepare()
    state.local.projects.get(entries[1].input.projectId).name = '其他项目'
    entries[1].input.projectName = '其他项目'
    await expect(ledgerRepository.createMedicineTickets(entries)).rejects.toThrow('药品商品套餐')
    expect(state.local.tickets.size).toBe(0)
    state.local.projects.get(entries[1].input.projectId).userId = 'user-2'
    await expect(ledgerRepository.createMedicineTickets(entries)).rejects.toThrow('当前账号')
    expect(state.operations.size).toBe(0)
  })

  it('acknowledges a lost response after catalogue removal, with current refunds and no duplicates', async () => {
    const entries = prepare()
    const originals = await ledgerRepository.createMedicineTickets(entries)
    const refund: RefundRecord = { id: 'medicine-refund', userId: user.id, ticketId: originals[0].id, personCount: 1, isFull: false,
      refundRevenueThb: 150, returnedCostThb: 95, refundDate: '2026-10-16', refundTime: '13:00', note: '', cancelledAt: null,
      createdAt: '2026-10-16T06:00:00Z', updatedAt: '2026-10-16T06:00:00Z', syncStatus: 'synced' }
    state.local.ticket_refunds.set(refund.id, refund)
    state.local.ticket_refunds.set('foreign-refund', { ...refund, id: 'foreign-refund', userId: 'user-2' })
    state.local.projects.clear()
    state.local.suppliers.clear()
    const retry = await ledgerRepository.createMedicineTickets(entries)
    expect(retry.map(row => row.id)).toEqual(originals.map(row => row.id))
    expect(retry[0].refunds).toEqual([refund])
    expect(getRefundState(retry[0]).remainingPeople).toBe(1)
    expect(getTicketAmounts(retry[0]).profitThb).toBe(55)
    expect(state.local.tickets.get(originals[0].id).personCount).toBe(2)
    expect(state.local.tickets.size).toBe(2)
    expect(state.operations.size).toBe(2)
  })

  it('rejects changed accepted content without creating any new lines in a mixed retry', async () => {
    const entries = prepare()
    await ledgerRepository.createMedicineTickets(entries)
    const previous = structuredClone([...state.local.tickets.values()])
    entries[0].operationId = 'new-first-line'
    entries[1].input.agentPriceThb += 1
    await expect(ledgerRepository.createMedicineTickets(entries)).rejects.toThrow('不同内容')
    expect([...state.local.tickets.values()]).toEqual(previous)
    expect(state.operations.size).toBe(2)
  })

  it('makes simultaneous retries idempotent for the entire batch', async () => {
    const entries = prepare()
    const [first, second] = await Promise.all([ledgerRepository.createMedicineTickets(entries), ledgerRepository.createMedicineTickets(entries)])
    expect(second).toEqual(first)
    expect(state.local.tickets.size).toBe(2)
    expect(state.operations.size).toBe(2)
  })

  it('rejects the whole delayed old-account batch when authentication changes before its transaction', async () => {
    const entries = prepare()
    state.beforeTicketWrite = () => ledgerRepository.activateAccount('user-2')
    await expect(ledgerRepository.createMedicineTickets(entries)).rejects.toThrow('账号已切换')
    expect(state.local.tickets.size).toBe(0)
    expect(state.operations.size).toBe(0)
  })
})

describe('recoverable ticket sync conflicts', () => {
  const seed = () => {
    const original = localTicket('2026-10-13T01:00:00Z')
    state.local.tickets.set(original.id, { ...original, syncStatus: 'synced' })
    state.cloud.tickets.set(original.id, cloudTicket(original.updatedAt))
    return original
  }
  const remoteRefund = () => ({ id: 'other-device-refund', user_id: user.id, ticket_id: 'ticket-1', person_count: null, is_full: true, refund_revenue_thb: 1000, returned_cost_thb: 700, refund_date: '2026-10-14', refund_time: '10:30:00', note: '', cancelled_at: null, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' })

  it('archives an offline edit to a now-refunded original and uploads an unrelated order', async () => {
    const original = seed()
    state.local.tickets.set(original.id, { ...original, updatedAt: '2099-01-01T00:00:00Z', note: '离线修改' })
    state.local.tickets.set('normal-new', { ...original, id: 'normal-new' })
    state.cloud.ticket_refunds.set('other-device-refund', remoteRefund())
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.cloud.tickets.has('normal-new')).toBe(true)
    expect(state.cloud.tickets.get(original.id).note).toBe('')
    expect(state.local.ticket_refunds.has('other-device-refund')).toBe(true)
    expect(state.local.tickets.get(original.id)).toMatchObject({ note: '', syncStatus: 'synced' })
    const [conflict] = await ledgerRepository.getSyncConflicts()
    expect(conflict).toMatchObject({ recordId: original.id, reason: 'refund_locked', localRecord: { note: '离线修改' }, remoteRecord: { note: '' } })
    await ledgerRepository.synchronise(user)
    expect(await ledgerRepository.getSyncConflicts()).toHaveLength(1)
  })

  it('isolates a refund created during an upload without blocking the rest of the batch', async () => {
    const original = seed()
    state.local.tickets.set(original.id, { ...original, updatedAt: '2099-01-01T00:00:00Z', note: '离线修改' })
    state.local.tickets.set('normal-new', { ...original, id: 'normal-new' })
    state.duringUpload = table => { if (table === 'tickets') state.cloud.ticket_refunds.set('other-device-refund', remoteRefund()) }
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.cloud.tickets.has('normal-new')).toBe(true)
    expect(state.local.ticket_refunds.has('other-device-refund')).toBe(true)
    expect(state.local.tickets.get(original.id)).toMatchObject({ note: '', syncStatus: 'synced' })
    expect(await ledgerRepository.getSyncConflicts()).toMatchObject([{ reason: 'upload_rejected', localRecord: { note: '离线修改' } }])
  })

  it('uses the pulled cloud version as a compare-and-swap guard even when the local clock is faster', async () => {
    const original = seed()
    state.local.tickets.set(original.id, { ...original, updatedAt: '2099-01-01T00:00:00Z', note: '本机时钟较快' })
    let raced = false
    state.duringUpload = table => {
      if (table === 'tickets' && !raced) {
        raced = true
        state.cloud.tickets.set(original.id, cloudTicket('2026-10-13T01:00:01Z', '拉取后另一设备保存'))
      }
    }
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.cloud.tickets.get(original.id).note).toBe('拉取后另一设备保存')
    expect(state.local.tickets.get(original.id)).toMatchObject({ note: '拉取后另一设备保存', syncStatus: 'synced' })
    expect(await ledgerRepository.getSyncConflicts()).toMatchObject([{ localRecord: { note: '本机时钟较快' }, remoteRecord: { note: '拉取后另一设备保存' } }])
  })

  it('quarantines a rejected new draft once, while successful orders keep synchronising', async () => {
    const original = seed()
    state.local.tickets.set('rejected-new', { ...original, id: 'rejected-new' })
    state.local.tickets.set('normal-new', { ...original, id: 'normal-new' })
    state.rejectTicketIds.add('rejected-new')
    expect(await ledgerRepository.synchronise(user)).toEqual({ synced: true })
    expect(state.local.tickets.get('rejected-new').syncStatus).toBe('error')
    expect(state.cloud.tickets.has('normal-new')).toBe(true)
    const attempts = state.uploads.filter(write => write.records.some(row => row.id === 'rejected-new')).length
    await ledgerRepository.synchronise(user)
    expect(state.uploads.filter(write => write.records.some(row => row.id === 'rejected-new'))).toHaveLength(attempts)
    expect(await ledgerRepository.getSyncConflicts()).toMatchObject([{ reason: 'upload_rejected', remoteRecord: null }])
  })

  it('retains a losing local pending snapshot and keeps conflict history after acknowledgement', async () => {
    const original = seed()
    state.local.tickets.set(original.id, { ...original, note: '本机修改', updatedAt: '2026-10-13T01:00:01Z' })
    state.cloud.tickets.set(original.id, cloudTicket('2026-10-13T01:00:02Z', '另一个设备修改'))
    await ledgerRepository.synchronise(user)
    const [conflict] = await ledgerRepository.getSyncConflicts()
    expect(conflict).toMatchObject({ reason: 'remote_newer', localRecord: { note: '本机修改' }, remoteRecord: { note: '另一个设备修改' } })
    await ledgerRepository.resolveSyncConflict(conflict.id)
    expect(await ledgerRepository.getSyncConflicts()).toEqual([])
    expect(await ledgerRepository.getSyncConflicts(true)).toHaveLength(1)
    expect(state.local.tickets.get(original.id).note).toBe('另一个设备修改')
    await ledgerRepository.activateAccount('user-2')
    expect(await ledgerRepository.getSyncConflicts(true)).toEqual([])
    await expect(ledgerRepository.resolveSyncConflict(conflict.id)).rejects.toThrow('当前账号')
  })
})

describe('person count persistence', () => {
  const prepare = () => {
    const project = localProject()
    state.local.projects.set(project.id, project)
    state.local.suppliers.set(project.supplierId, { id: project.supplierId, userId: user.id, name: project.supplierName, normalizedName: project.supplierName, createdAt: project.createdAt, updatedAt: project.updatedAt, syncStatus: 'synced' })
    const input: TicketInput = {
      personCount: 1, issueDate: '2026-10-13', issueTime: '10:30', projectId: project.id,
      supplierName: project.supplierName, projectName: project.name, subItemName: project.subItemName,
      agentPriceThb: 900, costThb: 700, note: ''
    }
    return input
  }

  it('keeps customer names through save, cloud upload, pull and amount-only edits', async () => {
    const input = prepare()
    const saved = await ledgerRepository.createOrUpdateTicket({ ...input, guestName: ' jimmy ', personCount: 2 })
    expect(saved.guestName).toBe('jimmy')
    await ledgerRepository.synchronise(user)
    expect(state.cloud.tickets.get(saved.id).guest_name).toBe('jimmy')
    state.local.tickets.clear()
    await ledgerRepository.synchronise(user)
    const pulled = state.local.tickets.get(saved.id)
    expect(pulled.guestName).toBe('jimmy')
    const updated = await ledgerRepository.createOrUpdateTicket({ ...input, personCount: 3 }, pulled)
    expect(updated.guestName).toBe('jimmy')
    expect(getTicketAmounts(updated).profitThb).toBe(600)
  })

  it('saves unit prices and updates totals when headcount changes, without repeated multiplication on sync', async () => {
    const input = prepare()
    const original = await ledgerRepository.createOrUpdateTicket({ ...input, personCount: 3 })
    expect(original).toMatchObject({ personCount: 3, agentPriceThb: 900, costThb: 700 })
    expect(original.amountBasis).toBe('per_person')
    expect(getTicketAmounts(original)).toEqual({ agentPriceThb: 2700, costThb: 2100, profitThb: 600 })
    await ledgerRepository.synchronise(user)
    expect(state.cloud.tickets.get(original.id).person_count).toBe(3)
    expect(state.cloud.tickets.get(original.id).amount_basis).toBe('per_person')
    const updated = await ledgerRepository.createOrUpdateTicket({ ...input, personCount: 5 }, original)
    expect(updated).toMatchObject({ id: original.id, personCount: 5, createdAt: original.createdAt, agentPriceThb: 900, costThb: 700 })
    await ledgerRepository.synchronise(user)
    expect(state.cloud.tickets.size).toBe(1)
    expect(state.cloud.tickets.get(original.id).person_count).toBe(5)
    expect(state.local.tickets.get(original.id)).toMatchObject({ personCount: 5, syncStatus: 'synced' })
    expect(getTicketAmounts(state.local.tickets.get(original.id))).toEqual({ agentPriceThb: 4500, costThb: 3500, profitThb: 1000 })
    await ledgerRepository.synchronise(user)
    expect(getTicketAmounts(state.local.tickets.get(original.id)).profitThb).toBe(1000)
  })

  it.each([null, undefined, 0, -1, 1.5, NaN, Infinity, 2147483648])('rejects invalid new headcount %s without saving', async (personCount) => {
    const input = prepare()
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, personCount })).rejects.toThrow('人数')
    expect(state.local.tickets.size).toBe(0)
    expect(state.uploads).toEqual([])
  })

  it('preserves unknown legacy headcount and permits deliberate completion', async () => {
    const input = prepare()
    const legacy = localTicket('2026-10-13T01:00:00.000Z')
    state.local.tickets.set(legacy.id, legacy)
    const saved = await ledgerRepository.createOrUpdateTicket({ ...input, personCount: null }, legacy)
    expect(saved.personCount).toBeNull()
    expect(saved.amountBasis).toBe('total')
    const completed = await ledgerRepository.createOrUpdateTicket({ ...input, personCount: 2 }, saved)
    expect(completed.personCount).toBe(2)
    expect(getTicketAmounts(completed).agentPriceThb).toBe(900)
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, personCount: null }, completed)).rejects.toThrow('人数')
  })

  it('reads older cloud records without inventing headcount', async () => {
    state.cloud.tickets.set('ticket-1', cloudTicket('2026-10-13T01:00:00.000Z'))
    await ledgerRepository.synchronise(user)
    expect(state.local.tickets.get('ticket-1').personCount).toBeNull()
    expect(state.local.tickets.get('ticket-1').amountBasis).toBe('total')
  })
  it('rejects missing headcount for per-person edits, excessive totals and sub-cent prices', async () => {
    const input = prepare()
    const legacy = localTicket('2026-10-13T01:00:00.000Z')
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, amountBasis: 'per_person', personCount: null }, legacy)).rejects.toThrow('人数')
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, personCount: 50, agentPriceThb: 999999999999.99 })).rejects.toThrow('金额或人数过大')
    await expect(ledgerRepository.createOrUpdateTicket({ ...input, agentPriceThb: 10.001 })).rejects.toThrow('两位小数')
    expect(state.local.tickets.size).toBe(0)
  })
})
