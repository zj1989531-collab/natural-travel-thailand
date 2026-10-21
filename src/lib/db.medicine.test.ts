import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Supplier, TicketRecord } from '../types'
import type { LedgerOwnerContext } from './ledger-account'

const memory = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  receiptAdds: 0,
  failReceiptAddAt: 0,
  attemptedWrites: 0,
  commits: 0,
  aborts: 0,
  afterRequest: undefined as ((store: string, method: string, key: string) => void) | undefined
}))

// Test only the storage boundary. The batch algorithm itself is the real
// db.putMedicineTicketsOnce implementation, not a parallel mock of that method.
vi.mock('idb', () => ({
  openDB: vi.fn(async () => ({
    transaction(names: string | string[], mode: string) {
      const selected = Array.isArray(names) ? names : [names]
      const snapshot = new Map(selected.map(name => [name, structuredClone(memory.stores.get(name) ?? new Map<string, unknown>())]))
      let aborted = false
      let committed = false
      const requireActive = () => { if (aborted || committed) throw new Error('TransactionInactiveError') }
      const afterRequest = (store: string, method: string, key: string) => memory.afterRequest?.(store, method, key)
      return {
        objectStore(name: string) {
          const store = snapshot.get(name)
          if (!store) throw new Error(`Store ${name} is outside the transaction`)
          return {
            async get(key: string) {
              requireActive()
              const value = structuredClone(store.get(key))
              afterRequest(name, 'get', key)
              return value
            },
            async put(value: Record<string, unknown>, key = String(value.id)) {
              requireActive()
              if (mode !== 'readwrite') throw new Error('ReadOnlyError')
              memory.attemptedWrites++
              store.set(key, structuredClone(value))
              afterRequest(name, 'put', key)
              return key
            },
            async add(value: Record<string, unknown>, key = String(value.id)) {
              requireActive()
              if (mode !== 'readwrite') throw new Error('ReadOnlyError')
              memory.attemptedWrites++
              if (name === 'ticket_create_operations' && ++memory.receiptAdds === memory.failReceiptAddAt) throw new Error('Simulated receipt storage failure')
              if (store.has(key)) throw new Error('ConstraintError')
              store.set(key, structuredClone(value))
              afterRequest(name, 'add', key)
              return key
            },
            index(indexName: string) {
              if (name !== 'ticket_refunds' || indexName !== 'by-ticket-id') throw new Error('Unexpected index')
              return {
                async getAll(ticketId: string) {
                  requireActive()
                  const values = [...store.values()].filter(row => (row as { ticketId: string }).ticketId === ticketId)
                  afterRequest(name, 'getAll', ticketId)
                  return structuredClone(values)
                }
              }
            }
          }
        },
        abort() {
          if (committed) throw new Error('Transaction already committed')
          if (!aborted) memory.aborts++
          aborted = true
        },
        get done() {
          if (aborted) return Promise.reject(new Error('AbortError'))
          if (!committed) {
            if (mode === 'readwrite') for (const [name, store] of snapshot) memory.stores.set(name, store)
            committed = true
            memory.commits++
          }
          return Promise.resolve()
        }
      }
    }
  }))
}))

import { db } from './db'
import { ticketOperationKey } from './ledger-account'

const timestamp = '2026-10-16T09:00:00.000Z'
const userId = 'medicine-owner'
const owner: LedgerOwnerContext = { userId, cloud: true, isCurrent: () => true }
const supplier: Supplier = { id: 'supplier', userId, name: '药品供货商', normalizedName: '药品供货商', createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' }
const project = (id: string): Project => ({
  id, userId, supplierId: supplier.id, supplierName: supplier.name, name: '药品', normalizedName: '药品', subItemName: id, normalizedSubItemName: id,
  quantityUnit: 'item', entryMode: 'standard', defaultAgentPriceThb: 100, defaultCostThb: 80, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced'
})
const ticket = (id: string, projectId: string): TicketRecord => ({
  id, userId, supplierId: supplier.id, supplierName: supplier.name, projectId, projectName: '药品', subItemName: projectId,
  guestName: 'Jimmy', issueDate: '2026-10-16', issueTime: '16:00', personCount: 2, quantityUnit: 'item', entryMode: 'standard', amountBasis: 'per_person',
  agentPriceThb: 100, costThb: 80, note: '送酒店', deletedAt: null, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending'
})
const batch = () => ['one', 'two'].map(id => ({ ticket: ticket(`ticket-${id}`, `project-${id}`), fingerprint: `fingerprint-${id}`, projectUpdatedAt: timestamp, supplierUpdatedAt: timestamp }))
const store = (name: string) => memory.stores.get(name)!
const noTicketsOrReceipts = () => {
  expect(store('tickets').size).toBe(0)
  expect(store('ticket_create_operations').size).toBe(0)
}

beforeEach(() => {
  memory.stores.clear()
  for (const name of ['settings', 'tickets', 'ticket_create_operations', 'ticket_refunds', 'projects', 'suppliers']) memory.stores.set(name, new Map())
  store('settings').set('app', { localUserId: 'anonymous', lastCloudUserId: userId, activeCloudUserId: userId })
  store('suppliers').set(supplier.id, structuredClone(supplier))
  for (const id of ['project-one', 'project-two']) store('projects').set(id, project(id))
  memory.receiptAdds = 0
  memory.failReceiptAddAt = 0
  memory.attemptedWrites = 0
  memory.commits = 0
  memory.aborts = 0
  memory.afterRequest = undefined
})

describe('real medicine batch DB operation with atomic controlled transactions', () => {
  it('writes no ticket or receipt when the second row catalogue version changed', async () => {
    store('projects').set('project-two', { ...project('project-two'), updatedAt: '2026-10-16T09:01:00Z' })
    await expect(db.putMedicineTicketsOnce(batch(), owner)).rejects.toThrow('药品套餐或供货商已变化')
    noTicketsOrReceipts()
    expect(memory.attemptedWrites).toBe(0)
    expect(memory.aborts).toBe(1)
    expect(memory.commits).toBe(0)
  })

  it('rolls back the first ticket and receipt when storing the second receipt fails', async () => {
    memory.failReceiptAddAt = 2
    await expect(db.putMedicineTicketsOnce(batch(), owner)).rejects.toThrow('Simulated receipt storage failure')
    expect(memory.receiptAdds).toBe(2)
    expect(memory.attemptedWrites).toBe(4)
    noTicketsOrReceipts()
    expect(memory.aborts).toBe(1)
    expect(memory.commits).toBe(0)
  })

  it('commits both tickets with their receipts and retries without duplicate writes', async () => {
    const rows = batch()
    const first = await db.putMedicineTicketsOnce(rows, owner)
    expect(first.map(row => row.id)).toEqual(rows.map(row => row.ticket.id))
    expect(store('tickets').size).toBe(2)
    expect(store('ticket_create_operations').size).toBe(2)
    for (const row of rows) expect(store('ticket_create_operations').get(ticketOperationKey(userId, row.ticket.id))).toMatchObject({ ticketId: row.ticket.id, fingerprint: row.fingerprint, acceptedRecord: row.ticket })
    expect(memory.attemptedWrites).toBe(4)
    // Catalogue changes after acceptance cannot invalidate the original receipt.
    store('projects').set('project-two', { ...project('project-two'), updatedAt: '2026-10-17T00:00:00Z' })
    expect(await db.putMedicineTicketsOnce(rows, owner)).toEqual(first)
    expect(store('tickets').size).toBe(2)
    expect(store('ticket_create_operations').size).toBe(2)
    expect(memory.attemptedWrites).toBe(4)
  })

  it('rejects a changed retry fingerprint without changing either accepted ticket', async () => {
    const rows = batch()
    await db.putMedicineTicketsOnce(rows, owner)
    const before = structuredClone(memory.stores)
    const changed = rows.map((row, index) => index === 1 ? { ...row, fingerprint: 'changed-input' } : row)
    await expect(db.putMedicineTicketsOnce(changed, owner)).rejects.toThrow('提交编号已保存过不同内容')
    expect(memory.stores).toEqual(before)
  })

  it('does not create the first row when a conflicting second-row receipt is found inside the transaction', async () => {
    const rows = batch()
    await db.putMedicineTicketsOnce([rows[1]], owner)
    const before = structuredClone(memory.stores)
    await expect(db.putMedicineTicketsOnce([rows[0], { ...rows[1], fingerprint: 'another-accepted-input' }], owner)).rejects.toThrow('提交编号已保存过不同内容')
    expect(memory.stores).toEqual(before)
    expect(store('tickets').has(rows[0].ticket.id)).toBe(false)
    expect(store('ticket_create_operations').has(ticketOperationKey(userId, rows[0].ticket.id))).toBe(false)
  })

  it('aborts all staged ticket and receipt writes when the account epoch changes mid-transaction', async () => {
    let current = true
    const epochOwner = { ...owner, isCurrent: () => current }
    memory.afterRequest = (name, method) => {
      if (name === 'ticket_create_operations' && method === 'add' && memory.receiptAdds === 2) current = false
    }
    await expect(db.putMedicineTicketsOnce(batch(), epochOwner)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    expect(memory.attemptedWrites).toBe(4)
    noTicketsOrReceipts()
    expect(memory.aborts).toBe(1)
    expect(memory.commits).toBe(0)
  })

  it('returns the current original on retry and leaves existing refund history intact', async () => {
    const rows = batch()
    await db.putMedicineTicketsOnce(rows, owner)
    const canonical = { ...rows[0].ticket, note: '后续已修改的原票', updatedAt: '2026-10-17T00:00:00Z', syncStatus: 'synced' }
    store('tickets').set(canonical.id, canonical)
    const refund = { id: 'refund-one', userId, ticketId: canonical.id, refundRevenueThb: 100, returnedCostThb: 80 }
    store('ticket_refunds').set(refund.id, refund)
    const retried = await db.putMedicineTicketsOnce(rows, owner)
    expect(retried[0]).toEqual(canonical)
    expect(store('tickets').get(canonical.id)).toEqual(canonical)
    expect(store('ticket_refunds').get(refund.id)).toEqual(refund)
    expect(memory.attemptedWrites).toBe(4)
  })
})
