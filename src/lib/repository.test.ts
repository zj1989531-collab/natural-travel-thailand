import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@supabase/supabase-js'
import type { Project, TicketInput, TicketRecord } from '../types'
import { mergeRemoteRecord } from './sync'
import { getTicketAmounts } from './ticket-amounts'

const state = vi.hoisted(() => ({
  local: { suppliers: new Map<string, any>(), projects: new Map<string, any>(), tickets: new Map<string, any>() },
  cloud: { suppliers: new Map<string, any>(), projects: new Map<string, any>(), tickets: new Map<string, any>() },
  uploads: [] as { table: string; records: any[] }[],
  duringUpload: null as null | ((table: string) => void)
}))

type Table = keyof typeof state.local
const copy = (value: any) => ({ ...value })

vi.mock('./db', () => ({ db: {
  getSettings: async () => ({ localUserId: 'anonymous', lastCloudUserId: 'user-1' }),
  getTickets: async () => [...state.local.tickets.values()].map(copy),
  getTicket: async (id: string) => state.local.tickets.get(id),
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
    const query = (write?: any[]) => {
      let userId = 'user-1'
      let offset = 0
      let end = 499
      const builder = {
        eq: (_column: string, value: string) => { userId = value; return builder },
        order: () => builder,
        range: (start: number, last: number) => { offset = start; end = last; return builder },
        abortSignal: async () => {
          if (write) {
            state.uploads.push({ table, records: write.map(copy) })
            state.duringUpload?.(table)
            for (const record of write) {
              const current = state.cloud[table].get(record.id)
              // Model the PostgreSQL trigger: a stale/equal timestamp is ignored.
              if (!current || new Date(record.updated_at).getTime() > new Date(current.updated_at).getTime()) {
                state.cloud[table].set(record.id, copy(record))
              }
            }
            return { error: null, data: null }
          }
          return {
            error: null,
            data: [...state.cloud[table].values()].filter((row) => row.user_id === userId).slice(offset, end + 1).map(copy)
          }
        }
      }
      return builder
    }
    return { select: () => query(), upsert: (rows: any[]) => query(rows) }
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

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  for (const table of ['suppliers', 'projects', 'tickets'] as const) {
    state.local[table].clear()
    state.cloud[table].clear()
  }
  state.uploads.length = 0
  state.duringUpload = null
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
