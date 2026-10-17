import { describe, expect, it } from 'vitest'
import type { Project, Supplier, TicketRecord } from '../types'
import { buildTicketExportRows, createLedgerBackup } from './export'

const supplier: Supplier = {
  id: 'supplier-1', userId: 'local-user', name: '示例供货商', normalizedName: '示例供货商',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', syncStatus: 'pending'
}
const project: Project = {
  id: 'project-1', userId: supplier.userId, supplierId: supplier.id, supplierName: supplier.name,
  name: '示例项目', normalizedName: '示例项目', subItemName: '', normalizedSubItemName: '',
  defaultCostThb: 100, defaultAgentPriceThb: 150, createdAt: supplier.createdAt,
  updatedAt: supplier.updatedAt, syncStatus: 'pending'
}

describe('complete ledger backup', () => {
  it('keeps manual price and supplier settings in full backups', () => {
    expect(createLedgerBackup({ suppliers: [], projects: [{ ...project, supplierId: '', supplierName: '', manualSupplier: true, manualCostPrice: true, manualAgentPrice: true }], tickets: [] }).projects[0]).toMatchObject({ manualSupplier: true, manualCostPrice: true, manualAgentPrice: true })
  })
  it('preserves all catalogue rows, IDs, optional subitems, amounts and timestamps', () => {
    const projects = Array.from({ length: 95 }, (_, i) => ({ ...project, id: `project-${i}` }))
    const backup = createLedgerBackup({ suppliers: [supplier], projects, tickets: [] }, '2026-01-03T00:00:00.000Z')
    expect(backup).toMatchObject({ format: 'ticket-profit-ledger', version: 2, currency: 'THB', timeZone: 'Asia/Bangkok', refunds: [] })
    expect(backup.suppliers).toEqual([supplier])
    expect(backup.projects).toEqual(projects)
    expect(backup.projects).toHaveLength(95)
    expect(backup.tickets).toEqual([])
    expect(backup.projects[0]).not.toBe(projects[0])
  })

  it('excludes unknown fields, including credentials', () => {
    const record = { ...supplier, access_token: 'fictional-test-only', refresh_token: 'fictional-test-only' }
    const backup = createLedgerBackup({ suppliers: [record], projects: [project], tickets: [] })
    expect(JSON.stringify(backup)).not.toContain('token')
  })

  it('refuses a mixed-account snapshot', () => {
    expect(() => createLedgerBackup({ suppliers: [supplier], projects: [{ ...project, userId: 'another-user' }], tickets: [] })).toThrow('账号正在切换')
  })

  it('keeps deleted ticket markers and historical price snapshots', () => {
    const ticket: TicketRecord = {
      id: 'ticket-1', userId: supplier.userId, issueDate: '2026-01-01', supplierId: supplier.id,
      supplierName: supplier.name, projectId: project.id, projectName: project.name, subItemName: '',
      personCount: 3, agentPriceThb: 140, costThb: 90, note: '示例备注', createdAt: supplier.createdAt,
      updatedAt: supplier.updatedAt, deletedAt: supplier.updatedAt, syncStatus: 'pending'
    }
    expect(createLedgerBackup({ suppliers: [supplier], projects: [project], tickets: [ticket] }).tickets).toEqual([ticket])
    const active = { ...ticket, deletedAt: null, issueTime: '09:35' }
    expect(buildTicketExportRows([active, ticket])).toHaveLength(1)
    expect(buildTicketExportRows([active])[0]).toMatchObject({ '人数': 3, '曼谷时间': '09:35', '代理售价 (THB)': 140, '供货商成本 (THB)': 90, '利润 (THB)': 50 })
    expect(buildTicketExportRows([{ ...active, personCount: null }])[0]['人数']).toBe('')
    expect(buildTicketExportRows([{ ...active, entryMode: 'profit_only', manualProfitThb: 123.45 }])[0]).toMatchObject({ '人数': 3, '代理售价 (THB)': '', '供货商成本 (THB)': '', '利润 (THB)': 123.45 })
    const perPerson = { ...active, amountBasis: 'per_person' as const }
    expect(buildTicketExportRows([perPerson])[0]).toMatchObject({ '人数': 3, '计价方式': '按人数计算', '单人代理售价 (THB)': 140, '单人供货商成本 (THB)': 90, '代理售价 (THB)': 420, '供货商成本 (THB)': 270, '利润 (THB)': 150 })
    expect(buildTicketExportRows([{ ...perPerson, entryMode: 'profit_only', manualProfitThb: 50.25 }])[0]).toMatchObject({ '单人返佣利润 (THB)': 50.25, '代理售价 (THB)': '', '供货商成本 (THB)': '', '利润 (THB)': 150.75 })
    expect(createLedgerBackup({ suppliers: [supplier], projects: [project], tickets: [perPerson] }).tickets[0].amountBasis).toBe('per_person')
  })
})
