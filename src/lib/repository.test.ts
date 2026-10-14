import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@supabase/supabase-js'
import type { Project, RefundInput, RefundRecord, TicketInput, TicketRecord } from '../types'
import { mergeRemoteRecord } from './sync'
import { getTicketAmounts } from './ticket-amounts'

const state = vi.hoisted(() => ({
  local: { suppliers: new Map<string, any>(), projects: new Map<string, any>(), tickets: new Map<string, any>(), ticket_refunds: new Map<string, any>() },
  cloud: { suppliers: new Map<string, any>(), projects: new Map<string, any>(), tickets: new Map<string, any>(), ticket_refunds: new Map<string, any>() },
  rejectRefundWrite: false,
  loseRefundResponse: false,
  uploads: [] as { table: string; records: any[] }[],
  duringUpload: null as null | ((table: string) => void)
}))

type Table = keyof typeof state.local
const copy = (value: any) => ({ ...value })

vi.mock('./db', () => ({ db: {
  getSettings: async () => ({ localUserId: 'anonymous', lastCloudUserId: 'user-1' }),
  getTickets: async () => [...state.local.tickets.values()].map(copy),
  getTicket: async (id: string) => state.local.tickets.get(id),
  getRefunds: async () => [...state.local.ticket_refunds.values()].map(copy),
  getRefund: async (id: string) => state.local.ticket_refunds.get(id),
  putRefund: async (record: RefundRecord) => { state.local.ticket_refunds.set(record.id, copy(record)) },
  mergeRemoteRefunds: async (records: any[]) => records.forEach((remote) => state.local.ticket_refunds.set(remote.id, mergeRemoteRecord(state.local.ticket_refunds.get(remote.id), remote))),
  getSuppliers: async () => [...state.local.suppliers.values()].map(copy),
  getProjects: async () => [...state.local.projects.values()].map(copy),
  putProject: async (project: Project) => { state.local.projects.set(project.id, copy(project)) },
  putTicket: async (ticket: TicketRecord) => { state.local.tickets.set(ticket.id, copy(ticket)) },
  mergeRemoteTickets: async (records: any[]) => records.forEach((remote) => state.local.tickets.set(remote.id, mergeRemoteRecord(state.local.tickets.get(remote.id), remote))),
  mergeRemoteSuppliers: async (records: any[]) => records.forEach((remote) => state.local.suppliers.set(remote.id, mergeRemoteRecord(state.local.suppliers.get(remote.id), remote))),
  mergeRemoteProjects: async (records: any[]) => records.forEach((remote) => state.local.projects.set(remote.id, mergeRemoteRecord(state.local.projects.get(remote.id), remote)))
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
          const matches = (row: any) => Object.entries(filters).every(([key, value]) => row[key] === value)
          if (write) {
            if (table === 'ticket_refunds' && state.rejectRefundWrite) return { error: { message: '云端拒绝退票' }, data: null }
            if (mode === 'update') {
              for (const [id, row] of state.cloud[table]) if (matches(row)) state.cloud[table].set(id, { ...row, ...write[0] })
              return { error: null, data: null }
            }
            state.uploads.push({ table, records: write.map(copy) })
            state.duringUpload?.(table)
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
    return { select: () => query(), upsert: (rows: any[]) => query(rows), insert: (row: any) => query([row], 'insert'), update: (row: any) => query([row], 'update') }
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
    await expect(ledgerRepository.createRefund(input)).rejects.toThrow('编号已使用')
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

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  for (const table of ['suppliers', 'projects', 'tickets', 'ticket_refunds'] as const) {
    state.local[table].clear()
    state.cloud[table].clear()
  }
  state.uploads.length = 0
  state.duringUpload = null
  state.rejectRefundWrite = false
  state.loseRefundResponse = false
})

describe('cloud synchronization races', () => {
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
  it('does not allow default sales and costs on a profit-only project', async () => {
    state.local.projects.set('project-1', { ...localProject(), entryMode: 'profit_only', defaultCostThb: 0, defaultAgentPriceThb: 0 })
    await expect(ledgerRepository.updateProjectPrices('project-1', { defaultCostThb: 100, defaultAgentPriceThb: 200 })).rejects.toThrow('仅录利润')
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

describe('manual selling prices and item quantity sync', () => {
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
    const corrected = await ledgerRepository.updateProjectPrices(project.id, { defaultCostThb: 105, defaultAgentPriceThb: NaN })
    expect(corrected).toMatchObject({ manualAgentPrice: true, defaultAgentPriceThb: 0, defaultCostThb: 105, quantityUnit: 'item' })
    expect(state.local.tickets.get(saved.id)).toEqual(saved)
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
    const original = localTicket('2026-10-13T01:00:00.000Z')
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
