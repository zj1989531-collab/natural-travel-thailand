import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AppSettings, Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { validateRefundInput } from './refund-input'
import { mergeRemoteRecord } from './sync'
import { reconcileCatalogue } from './catalogue-merge'
import { attachRefunds } from './refunds'
import { buildShow79SettlementState, type Show79SettlementInput, type Show79SettlementRecord } from './show79-settlement'

interface LedgerDb extends DBSchema {
  show79_settlements: { key: string; value: Show79SettlementRecord }
  ticket_refunds: { key: string; value: RefundRecord; indexes: { 'by-ticket-id': string } }
  tickets: {
    key: string
    value: TicketRecord
    indexes: { 'by-updated-at': string }
  }
  suppliers: {
    key: string
    value: Supplier
    indexes: { 'by-normalized-name': string }
  }
  projects: {
    key: string
    value: Project
    indexes: { 'by-supplier-id': string }
  }
  settings: {
    key: string
    value: AppSettings
  }
}

let database: Promise<IDBPDatabase<LedgerDb>> | undefined

const getDb = () => {
  database ??= openDB<LedgerDb>('ticket-profit-ledger', 4, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
      const tickets = db.createObjectStore('tickets', { keyPath: 'id' })
      tickets.createIndex('by-updated-at', 'updatedAt')
      const suppliers = db.createObjectStore('suppliers', { keyPath: 'id' })
      suppliers.createIndex('by-normalized-name', 'normalizedName')
      db.createObjectStore('settings')
      }
      if (oldVersion < 2) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' })
        projects.createIndex('by-supplier-id', 'supplierId')
      }
      if (oldVersion < 3) db.createObjectStore('ticket_refunds', { keyPath: 'id' }).createIndex('by-ticket-id', 'ticketId')
      if (oldVersion < 4) db.createObjectStore('show79_settlements', { keyPath: 'id' })
    },
    blocking() { void database?.then((connection) => connection.close()); database = undefined }
  })
  return database
}

type SyncedStore = 'tickets' | 'suppliers' | 'projects' | 'ticket_refunds' | 'show79_settlements'

async function mergeRemoteRows<K extends SyncedStore>(storeName: K, rows: LedgerDb[K]['value'][]) {
  const database = await getDb()
  const transaction = database.transaction(storeName, 'readwrite')
  for (const remote of rows) {
    const current = await transaction.store.get(remote.id)
    await transaction.store.put(mergeRemoteRecord(current, remote))
  }
  await transaction.done
}

async function putLocalRecord<K extends SyncedStore>(storeName: K, record: LedgerDb[K]['value']) {
  const database = await getDb()
  const transaction = database.transaction(storeName === 'tickets' ? ['tickets', 'settings', 'ticket_refunds'] : [storeName, 'settings'], 'readwrite')
  try {
  const settings = await transaction.objectStore('settings').get('app')
  // A form can have read the anonymous owner just before first login adopted
  // the existing rows. Assign its delayed write using settings in this same
  // transaction so the new record cannot become an orphaned anonymous row.
  const next = settings?.lastCloudUserId && record.userId === settings.localUserId
    ? { ...record, userId: settings.lastCloudUserId, syncStatus: 'pending' as const }
    : record
  if (storeName === 'tickets') {
    const current = await transaction.objectStore('tickets').get(record.id)
    const history = await transaction.objectStore('ticket_refunds').index('by-ticket-id').getAll(record.id)
    const oldFields = current as unknown as Record<string, unknown> | undefined
    const newFields = next as unknown as Record<string, unknown>
    if (oldFields && history.some((row) => row.userId === current!.userId) && Object.keys({ ...oldFields, ...newFields }).some((key) => !['updatedAt', 'syncStatus', 'refunds'].includes(key) && oldFields[key] !== newFields[key])) {
      throw new Error('已有退票明细的原票不可编辑或删除，请保留完整记录。')
    }
  }
  const key = await transaction.objectStore(storeName).put(next)
  await transaction.done
  return key
  } catch (error) { try { transaction.abort() } catch { /* Transaction may already have aborted. */ } await transaction.done.catch(() => undefined); throw error }
}

export const db = {
  async reconcileCatalogue(userId: string, suppliers: Supplier[], projects: Project[]) {
    const database = await getDb()
    const transaction = database.transaction(['suppliers', 'projects', 'tickets', 'settings'], 'readwrite')
    try {
      const settings = await transaction.objectStore('settings').get('app')
      if (settings?.lastCloudUserId !== userId) throw new Error('账号正在切换，请稍后重试同步。')
      const merged = reconcileCatalogue({
        suppliers: await transaction.objectStore('suppliers').getAll(),
        projects: await transaction.objectStore('projects').getAll(),
        tickets: await transaction.objectStore('tickets').getAll()
      }, { suppliers, projects }, userId)
      for (const row of merged.suppliers) await transaction.objectStore('suppliers').put(row)
      for (const row of merged.projects) await transaction.objectStore('projects').put(row)
      for (const row of merged.tickets) await transaction.objectStore('tickets').put(row)
      await transaction.done
    } catch (error) { try { transaction.abort() } catch { /* Already aborted. */ } await transaction.done.catch(() => undefined); throw error }
  },
  async getCatalogueAliases() {
    const database = await getDb()
    return { suppliers: (await database.getAll('suppliers')).filter(row => row.mergedIntoId), projects: (await database.getAll('projects')).filter(row => row.mergedIntoId) }
  },
  async adoptLocalRecords(sourceUserId: string, targetUserId: string, updatedAt: string, settings: AppSettings) {
    const database = await getDb()
    const transaction = database.transaction(['tickets', 'suppliers', 'projects', 'ticket_refunds', 'settings'], 'readwrite')
    for (const storeName of ['tickets', 'suppliers', 'projects', 'ticket_refunds'] as const) {
      const store = transaction.objectStore(storeName)
      for (const record of await store.getAll()) {
        if (record.userId === sourceUserId) {
          await store.put({ ...record, userId: targetUserId, updatedAt, syncStatus: 'pending' })
        }
      }
    }
    await transaction.objectStore('settings').put({ ...settings, lastCloudUserId: targetUserId }, 'app')
    await transaction.done
  },
  mergeRemoteTickets: (tickets: TicketRecord[]) => mergeRemoteRows('tickets', tickets),
  mergeRemoteSuppliers: (suppliers: Supplier[]) => mergeRemoteRows('suppliers', suppliers),
  mergeRemoteProjects: (projects: Project[]) => mergeRemoteRows('projects', projects),
  mergeRemoteRefunds: (refunds: RefundRecord[]) => mergeRemoteRows('ticket_refunds', refunds),
  mergeRemoteShow79Settlements: (records: Show79SettlementRecord[]) => mergeRemoteRows('show79_settlements', records),
  async getShow79Settlements() { return (await getDb()).getAll('show79_settlements') },
  async getShow79Settlement(id: string) { return (await getDb()).get('show79_settlements', id) },
  async putConfirmedShow79Settlement(record: Show79SettlementRecord) {
    const database = await getDb()
    const tx = database.transaction('show79_settlements', 'readwrite')
    const existing = await tx.store.get(record.id)
    if (existing && existing.userId !== record.userId) { await tx.done; throw new Error('这条分账记录属于其他账号。') }
    await tx.store.put(record)
    await tx.done
  },
  async addLocalShow79Settlement(record: Show79SettlementRecord, input: Show79SettlementInput) {
    const database = await getDb()
    const tx = database.transaction(['show79_settlements', 'settings', 'tickets', 'ticket_refunds'], 'readwrite')
    try {
      const settings = await tx.objectStore('settings').get('app')
      const userId = settings?.lastCloudUserId ?? settings?.localUserId
      if (!userId || record.userId !== userId) throw new Error('当前账号无法登记这笔分账。')
      const existing = await tx.objectStore('show79_settlements').get(record.id)
      if (existing) { await tx.done; return existing }
      const tickets = (await tx.objectStore('tickets').getAll()).filter(row => row.userId === userId)
      const refunds = (await tx.objectStore('ticket_refunds').getAll()).filter(row => row.userId === userId)
      const history = (await tx.objectStore('show79_settlements').getAll()).filter(row => row.userId === userId)
      const state = buildShow79SettlementState(attachRefunds(tickets, refunds), history, input.month)
      const cents = (value: number) => Math.round(value * 100)
      if (cents(state.profitThb) !== cents(input.expectedProfitThb) || cents(state.paidJimmyThb) !== cents(input.expectedJimmyPaidThb) || cents(state.paidPartnersThb) !== cents(input.expectedPartnersPaidThb)) throw Object.assign(new Error('本月利润或已付金额已更新，请刷新后核对再登记。'), { code: '40001' })
      if (Math.abs(cents(state.paidJimmyThb) + cents(input.jimmyPaidThb)) > 99999999999999 || Math.abs(cents(state.paidPartnersThb) + cents(input.partnersPaidThb)) > 99999999999999) throw new Error('累计分账金额过大，请检查输入。')
      const accepted = { ...record, snapshotProfitThb: state.profitThb, snapshotJimmyThb: state.jimmyThb, snapshotPartnersThb: state.partnersThb }
      await tx.objectStore('show79_settlements').add(accepted)
      await tx.done
      return accepted
    } catch (error) { try { tx.abort() } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error }
  },
  async getRefunds() { return (await getDb()).getAll('ticket_refunds') },
  async getRefund(id: string) { return (await getDb()).get('ticket_refunds', id) },
  async putRefund(refund: RefundRecord) { return putLocalRecord('ticket_refunds', refund) },
  async addLocalRefund(refund: RefundRecord) {
    const database = await getDb()
    const transaction = database.transaction(['tickets', 'ticket_refunds', 'settings'], 'readwrite')
    try {
      const settings = await transaction.objectStore('settings').get('app')
      const userId = settings?.lastCloudUserId ?? settings?.localUserId
      const existing = await transaction.objectStore('ticket_refunds').get(refund.id)
      if (existing) { await transaction.done; return existing }
      const ticket = await transaction.objectStore('tickets').get(refund.ticketId)
      if (!ticket || ticket.userId !== userId || refund.userId !== userId) throw new Error('当前账号无法退这条出票记录。')
      const history = await transaction.objectStore('ticket_refunds').index('by-ticket-id').getAll(ticket.id)
      validateRefundInput({ ...ticket, refunds: history }, { ...refund, operationId: refund.id })
      await transaction.objectStore('ticket_refunds').put(refund)
      await transaction.done
      return refund
    } catch (error) { try { transaction.abort() } catch { /* Transaction may already have aborted. */ } await transaction.done.catch(() => undefined); throw error }
  },
  async getTicket(id: string) {
    return (await getDb()).get('tickets', id)
  },
  async getTickets() {
    const database = await getDb()
    const tickets = await database.getAll('tickets')
    const migrated = tickets.map((ticket) => {
      const legacyTicket = ticket as TicketRecord & { revenueThb?: number }
      if (typeof legacyTicket.agentPriceThb === 'number' && typeof legacyTicket.projectName === 'string' && typeof legacyTicket.subItemName === 'string') return ticket
      return {
        ...legacyTicket,
        projectId: legacyTicket.projectId ?? null,
        projectName: legacyTicket.projectName ?? '未分类项目',
        subItemName: legacyTicket.subItemName ?? '默认套餐',
        agentPriceThb: legacyTicket.agentPriceThb ?? legacyTicket.revenueThb ?? 0
      }
    })
    const changed = migrated.filter((ticket, index) => ticket !== tickets[index])
    if (changed.length) await this.putTickets(changed)
    return migrated
  },
  async putTicket(ticket: TicketRecord) {
    return putLocalRecord('tickets', ticket)
  },
  async putTickets(tickets: TicketRecord[]) {
    const database = await getDb()
    const transaction = database.transaction('tickets', 'readwrite')
    await Promise.all([...tickets.map((ticket) => transaction.store.put(ticket)), transaction.done])
  },
  async getSuppliers() {
    return (await (await getDb()).getAll('suppliers')).filter(row => !row.mergedIntoId)
  },
  async putSupplier(supplier: Supplier) {
    return putLocalRecord('suppliers', supplier)
  },
  async putSuppliers(suppliers: Supplier[]) {
    const database = await getDb()
    const transaction = database.transaction('suppliers', 'readwrite')
    await Promise.all([...suppliers.map((supplier) => transaction.store.put(supplier)), transaction.done])
  },
  async getProjects() {
    const database = await getDb()
    const projects = (await database.getAll('projects')).filter(row => !row.mergedIntoId)
    const migrated = projects.map((project) => {
      const legacyProject = project as Project
      if (typeof legacyProject.subItemName === 'string') return project
      return {
        ...legacyProject,
        subItemName: '默认套餐',
        normalizedSubItemName: '默认套餐'
      }
    })
    const changed = migrated.filter((project, index) => project !== projects[index])
    if (changed.length) await this.putProjects(changed)
    return migrated
  },
  async putProject(project: Project) {
    return putLocalRecord('projects', project)
  },
  async putProjects(projects: Project[]) {
    const database = await getDb()
    const transaction = database.transaction('projects', 'readwrite')
    await Promise.all([...projects.map((project) => transaction.store.put(project)), transaction.done])
  },
  async getSettings() {
    return (await getDb()).get('settings', 'app')
  },
  async putSettings(settings: AppSettings) {
    return (await getDb()).put('settings', settings, 'app')
  }
}
