import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@supabase/supabase-js'
import type { TicketRecord } from '../types'
import { mergeRemoteRecord } from './sync'

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
  getSuppliers: async () => [...state.local.suppliers.values()].map(copy),
  getProjects: async () => [...state.local.projects.values()].map(copy),
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
