import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AppSettings, Project, Supplier, TicketRecord } from '../types'
import { mergeRemoteRecord } from './sync'

interface LedgerDb extends DBSchema {
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
  database ??= openDB<LedgerDb>('ticket-profit-ledger', 2, {
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
    }
  })
  return database
}

type SyncedStore = 'tickets' | 'suppliers' | 'projects'

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
  const transaction = database.transaction([storeName, 'settings'], 'readwrite')
  const settings = await transaction.objectStore('settings').get('app')
  // A form can have read the anonymous owner just before first login adopted
  // the existing rows. Assign its delayed write using settings in this same
  // transaction so the new record cannot become an orphaned anonymous row.
  const next = settings?.lastCloudUserId && record.userId === settings.localUserId
    ? { ...record, userId: settings.lastCloudUserId, syncStatus: 'pending' as const }
    : record
  const key = await transaction.objectStore(storeName).put(next)
  await transaction.done
  return key
}

export const db = {
  async adoptLocalRecords(sourceUserId: string, targetUserId: string, updatedAt: string, settings: AppSettings) {
    const database = await getDb()
    const transaction = database.transaction(['tickets', 'suppliers', 'projects', 'settings'], 'readwrite')
    for (const storeName of ['tickets', 'suppliers', 'projects'] as const) {
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
    return (await getDb()).getAll('suppliers')
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
    const projects = await database.getAll('projects')
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
