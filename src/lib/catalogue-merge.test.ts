import { describe, expect, it } from 'vitest'
import type { Project, Supplier, TicketRecord } from '../types'
import { reconcileCatalogue } from './catalogue-merge'
import { createLedgerBackup } from './export'

const supplier = (id: string, extra: Partial<Supplier> = {}): Supplier => ({ id, userId: 'u', name: '示例供货商', normalizedName: '示例供货商', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', syncStatus: 'pending', ...extra })
const project = (id: string, supplierId: string, extra: Partial<Project> = {}): Project => ({ id, supplierId, supplierName: '示例供货商', userId: 'u', name: '示例项目', normalizedName: '示例项目', subItemName: '儿童票', normalizedSubItemName: '儿童票', defaultCostThb: 600, defaultAgentPriceThb: 650, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', syncStatus: 'pending', ...extra })
const ticket: TicketRecord = { id: 't', userId: 'u', supplierId: 'local-s', supplierName: '示例供货商', projectId: 'local-p', projectName: '示例项目', subItemName: '儿童票', issueDate: '2026-01-01', issueTime: '09:00', personCount: 3, amountBasis: 'per_person', costThb: 600, agentPriceThb: 650, note: '保留备注', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null, syncStatus: 'pending' }
const local = () => ({ suppliers: [supplier('local-s')], projects: [project('local-p', 'local-s')], tickets: [ticket] })
const remote = () => ({ suppliers: [supplier('cloud-s', { syncStatus: 'synced' })], projects: [project('cloud-p', 'cloud-s', { updatedAt: '2026-01-02T00:00:00Z', defaultCostThb: 500, syncStatus: 'synced' })] })

describe('recoverable catalogue identity reconciliation', () => {
  it('uses cloud IDs and preserves newer cloud prices, not identity-repair time', () => {
    const result = reconcileCatalogue(local(), remote(), 'u')
    expect(result.suppliers.filter(row => !row.mergedIntoId).map(row => row.id)).toEqual(['cloud-s'])
    expect(result.projects.filter(row => !row.mergedIntoId)).toMatchObject([{ id: 'cloud-p', defaultCostThb: 500, syncStatus: 'synced' }])
    expect(result.projects.find(row => row.id === 'local-p')).toMatchObject({ mergedIntoId: 'cloud-p', defaultCostThb: 600 })
    expect(result.tickets[0]).toMatchObject({ ...ticket, supplierId: 'cloud-s', projectId: 'cloud-p', updatedAt: result.tickets[0].updatedAt })
  })
  it('preserves a newer local price on the canonical cloud identity and archives the duplicate', () => {
    const data = local(); data.projects[0] = { ...data.projects[0], updatedAt: '2026-01-03T00:00:00Z', defaultCostThb: 550 }
    const result = reconcileCatalogue(data, remote(), 'u')
    expect(result.projects.find(row => row.id === 'cloud-p')).toMatchObject({ defaultCostThb: 550, updatedAt: '2026-01-03T00:00:00Z', syncStatus: 'pending' })
    expect(result.projects.find(row => row.id === 'local-p')).toMatchObject({ mergedIntoId: 'cloud-p', defaultCostThb: 550 })
  })
  it('is idempotent and leaves historical amounts, dates, deletion markers and receipt IDs unchanged', () => {
    const data = local(); data.tickets[0] = { ...ticket, deletedAt: '2026-01-02T00:00:00Z', refunds: [{ id: 'receipt' } as any] }
    const first = reconcileCatalogue(data, remote(), 'u')
    expect(reconcileCatalogue(first, remote(), 'u')).toEqual(first)
    expect(first.tickets[0]).toMatchObject({ costThb: 600, agentPriceThb: 650, personCount: 3, issueDate: ticket.issueDate, issueTime: ticket.issueTime, deletedAt: data.tickets[0].deletedAt, refunds: data.tickets[0].refunds })
  })
  it('never merges another account or equal project names under distinct suppliers', () => {
    const foreign = supplier('foreign', { userId: 'other' })
    const distinct = supplier('distinct', { name: '另一供货商', normalizedName: '另一供货商' })
    const data = local(); data.suppliers.push(foreign, distinct); data.projects.push(project('distinct-p', 'distinct'), project('foreign-p', 'foreign', { userId: 'other' }))
    const result = reconcileCatalogue(data, remote(), 'u')
    expect(result.suppliers.find(row => row.id === 'foreign')).toEqual(foreign)
    expect(result.projects.find(row => row.id === 'distinct-p')).not.toHaveProperty('mergedIntoId')
    expect(result.projects.find(row => row.id === 'foreign-p')).toEqual(data.projects[2])
  })
  it('merges local-only duplicates deterministically without creating new IDs', () => {
    const data = local(); data.suppliers.push(supplier('second-s')); data.projects.push(project('second-p', 'second-s'))
    const result = reconcileCatalogue(data, { suppliers: [], projects: [] }, 'u')
    expect(result.suppliers.filter(row => !row.mergedIntoId)).toHaveLength(1)
    expect(result.projects.filter(row => !row.mergedIntoId)).toHaveLength(1)
    expect(reconcileCatalogue(result, { suppliers: [], projects: [] }, 'u')).toEqual(result)
  })
  it('includes recoverable duplicate snapshots in the explicit-field backup', () => {
    const result = reconcileCatalogue(local(), remote(), 'u')
    const backup = createLedgerBackup(result)
    expect(backup.suppliers.find(row => row.id === 'local-s')?.mergedIntoId).toBe('cloud-s')
    expect(backup.projects.find(row => row.id === 'local-p')).toMatchObject({ mergedIntoId: 'cloud-p', defaultCostThb: 600 })
  })
  it('does not collapse distinct existing cloud IDs or overwrite another owner with the same ID', () => {
    expect(() => reconcileCatalogue(local(), { suppliers: [supplier('cloud-1'), supplier('cloud-2')], projects: [] }, 'u')).toThrow('云端有重复')
    expect(() => reconcileCatalogue({ ...local(), suppliers: [supplier('cloud-s', { userId: 'other' })] }, remote(), 'u')).toThrow('其他账号')
  })
})
