import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AppSettings, Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { validateRefundInput } from './refund-input'
import { isNewer, mergeRemoteRecord, nextModifiedAt, preserveRuleFields } from './sync'
import { reconcileCatalogue } from './catalogue-merge'
import { attachRefunds } from './refunds'
import { buildShow79SettlementState, type Show79SettlementInput, type Show79SettlementRecord } from './show79-settlement'
import { AccountChangedError, assertLedgerOwner, ticketOperationKey, type LedgerOwnerContext, type LedgerSettings, type TicketCreateOperation } from './ledger-account'
import { makeSyncConflict, meaningfulRecordChanged, shouldArchiveRemoteConflict, type SyncConflictRecord, type SyncConflictSource, type SyncConflictTable } from './sync-conflicts'
import { createId } from './format'

interface SyncBaseRecord {
  id: string
  userId: string
  table: SyncConflictTable
  recordId: string
  record: SyncConflictSource
}

const syncBaseKey = (userId: string, table: SyncConflictTable, id: string) => JSON.stringify([userId, table, id])
const makeSyncBase = (table: SyncConflictTable, record: SyncConflictSource): SyncBaseRecord => ({
  id: syncBaseKey(record.userId, table, record.id), userId: record.userId, table, recordId: record.id, record
})

interface LedgerDb extends DBSchema {
  sync_bases: { key: string; value: SyncBaseRecord }
  ticket_create_operations: { key: string; value: TicketCreateOperation }
  sync_conflicts: { key: string; value: SyncConflictRecord }
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
    value: LedgerSettings
  }
}

let database: Promise<IDBPDatabase<LedgerDb>> | undefined

const getDb = () => {
  database ??= openDB<LedgerDb>('ticket-profit-ledger', 5, {
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
      if (oldVersion < 5) {
        db.createObjectStore('ticket_create_operations', { keyPath: 'id' })
        db.createObjectStore('sync_conflicts', { keyPath: 'id' })
        db.createObjectStore('sync_bases', { keyPath: 'id' })
      }
    },
    blocking() { void database?.then((connection) => connection.close()); database = undefined }
  })
  return database
}

type SyncedStore = 'tickets' | 'suppliers' | 'projects' | 'ticket_refunds' | 'show79_settlements'
const checkEpoch = (owner?: LedgerOwnerContext, transaction?: { abort: () => void }) => {
  if (owner && !owner.isCurrent()) {
    try { transaction?.abort() } catch { /* A completed transaction cannot be aborted. */ }
    throw new AccountChangedError()
  }
}

async function mergeRemoteRows<K extends SyncedStore>(storeName: K, rows: LedgerDb[K]['value'][], owner?: LedgerOwnerContext, lockedTicketIds: Set<string> = new Set(), acknowledged: LedgerDb[K]['value'][] = []) {
  const database = await getDb()
  const transaction = database.transaction([storeName, 'settings', 'sync_conflicts', 'sync_bases', 'ticket_create_operations'], 'readwrite')
  try {
  const settings = await transaction.objectStore('settings').get('app')
  if (owner) assertLedgerOwner(settings, owner)
  for (const remote of rows) {
    if (owner) assertLedgerOwner(settings, owner, remote.userId)
    const store = transaction.objectStore(storeName)
    const current = await store.get(remote.id)
    if (current && current.userId !== remote.userId) throw new AccountChangedError()
    let adoptRemote = false
    let keepUnacknowledgedEdit = false
    let confirmKnownCreation = false
    if (storeName !== 'show79_settlements') {
      const table = storeName as SyncConflictTable
      const remoteRecord = remote as SyncConflictSource
      const localRecord = current as SyncConflictSource | undefined
      const base = await transaction.objectStore('sync_bases').get(syncBaseKey(remote.userId, table, remote.id))
      const uploaded = acknowledged.find(row => row.id === remote.id && row.userId === remote.userId) as SyncConflictSource | undefined
      const ownAck = Boolean(uploaded && !meaningfulRecordChanged(uploaded, remoteRecord))
      const creation = table === 'tickets' && !base ? await transaction.objectStore('ticket_create_operations').get(ticketOperationKey(remote.userId, remote.id)) : undefined
      // A cold-cache/response-loss retry of a creation can acknowledge an
      // existing server UUID, but can never turn it into a blind update.
      const knownCreation = Boolean(creation && localRecord && !ownAck)
      const dirtyDifference = Boolean(localRecord && localRecord.syncStatus !== 'synced' && meaningfulRecordChanged(localRecord, remoteRecord))
      const refundLocked = table === 'tickets' && lockedTicketIds.has(remote.id) && dirtyDifference
      const baseChanged = Boolean(base && meaningfulRecordChanged(base.record, remoteRecord))
      adoptRemote = dirtyDifference && (refundLocked || !ownAck && (knownCreation || baseChanged || shouldArchiveRemoteConflict(localRecord!, remoteRecord)))
      confirmKnownCreation = knownCreation && !dirtyDifference
      keepUnacknowledgedEdit = dirtyDifference && ownAck && !refundLocked
      if (adoptRemote) {
        const conflict = makeSyncConflict(table, localRecord!, remoteRecord, refundLocked ? 'refund_locked' : 'remote_newer', refundLocked ? '另一设备已办理退票，原票不可修改；本机修改已保留为副本。' : '另一设备已保存不同内容；本机修改已保留为副本。', new Date().toISOString())
        if (!await transaction.objectStore('sync_conflicts').get(conflict.id)) await transaction.objectStore('sync_conflicts').put(conflict)
      }
      // The baseline describes what was actually read from the cloud, even
      // when a newer local edit must wait for the next upload pass.
      await transaction.objectStore('sync_bases').put(makeSyncBase(table, remoteRecord))
    }
    let next = adoptRemote || confirmKnownCreation ? { ...remote, syncStatus: 'synced' as const } : keepUnacknowledgedEdit ? preserveRuleFields(current!, remote) : mergeRemoteRecord(current, remote)
    if (keepUnacknowledgedEdit && !isNewer(next.updatedAt, remote.updatedAt)) next = { ...next, updatedAt: nextModifiedAt(next.updatedAt, remote.updatedAt) }
    await store.put(next)
  }
  checkEpoch(owner, transaction); await transaction.done; checkEpoch(owner)
  } catch (error) { try { transaction.abort() } catch { /* Already aborted. */ } await transaction.done.catch(() => undefined); throw error }
}

async function putLocalRecord<K extends SyncedStore>(storeName: K, record: LedgerDb[K]['value'], owner?: LedgerOwnerContext) {
  const database = await getDb()
  const transaction = database.transaction(storeName === 'tickets' ? ['tickets', 'settings', 'ticket_refunds', 'sync_bases'] : [storeName, 'settings', 'sync_bases'], 'readwrite')
  try {
  const settings = await transaction.objectStore('settings').get('app')
  if (owner) assertLedgerOwner(settings, owner, record.userId)
  // A form can have read the anonymous owner just before first login adopted
  // the existing rows. Assign its delayed write using settings in this same
  // transaction so the new record cannot become an orphaned anonymous row.
  const next = !owner && settings?.lastCloudUserId && record.userId === settings.localUserId
    ? { ...record, userId: settings.lastCloudUserId, syncStatus: 'pending' as const }
    : record
  const current = await transaction.objectStore(storeName).get(record.id)
  if (current && current.userId !== next.userId) throw new AccountChangedError()
  if (storeName === 'tickets') {
    const history = await transaction.objectStore('ticket_refunds').index('by-ticket-id').getAll(record.id)
    const oldFields = current as unknown as Record<string, unknown> | undefined
    const newFields = next as unknown as Record<string, unknown>
    if (oldFields && history.some((row) => row.userId === current!.userId) && Object.keys({ ...oldFields, ...newFields }).some((key) => !['updatedAt', 'syncStatus', 'refunds'].includes(key) && oldFields[key] !== newFields[key])) {
      throw new Error('已有退票明细的原票不可编辑或删除，请保留完整记录。')
    }
  }
  // Upgrade compatibility: editing an already cached synced row establishes
  // its last accepted cloud version before the dirty copy replaces it.
  if (storeName !== 'show79_settlements' && current?.syncStatus === 'synced') {
    await transaction.objectStore('sync_bases').put(makeSyncBase(storeName as SyncConflictTable, current as SyncConflictSource))
  }
  const key = await transaction.objectStore(storeName).put(next)
  checkEpoch(owner, transaction); await transaction.done; checkEpoch(owner)
  return key
  } catch (error) { try { transaction.abort() } catch { /* Transaction may already have aborted. */ } await transaction.done.catch(() => undefined); throw error }
}

export const db = {
  async activateAccount(userId: string | null, cloud: boolean, isCurrent: () => boolean) {
    const database = await getDb()
    const tx = database.transaction(['settings', 'tickets', 'suppliers', 'projects', 'ticket_refunds', 'ticket_create_operations', 'sync_conflicts', 'sync_bases'], 'readwrite')
    try {
      const settings = await tx.objectStore('settings').get('app') ?? { localUserId: createId(), lastCloudUserId: null }
      if (!isCurrent()) throw new AccountChangedError()
      if (cloud && userId) {
        // Adoption happens on authentication, including offline authentication,
        // never while synchronising another account's already-owned cache.
        for (const table of ['tickets', 'suppliers', 'projects', 'ticket_refunds'] as const) {
          for (const record of await tx.objectStore(table).getAll()) if (record.userId === settings.localUserId) {
            await tx.objectStore(table).put({ ...record, userId, syncStatus: 'pending' })
          }
        }
        for (const receipt of await tx.objectStore('ticket_create_operations').getAll()) if (receipt.userId === settings.localUserId) {
          await tx.objectStore('ticket_create_operations').delete(receipt.id)
          await tx.objectStore('ticket_create_operations').put({ ...receipt, id: ticketOperationKey(userId, receipt.ticketId), userId, acceptedRecord: { ...receipt.acceptedRecord, userId } })
        }
        for (const conflict of await tx.objectStore('sync_conflicts').getAll()) if (conflict.userId === settings.localUserId) {
          const adopted = makeSyncConflict(conflict.table, { ...conflict.localRecord, userId }, conflict.remoteRecord ? { ...conflict.remoteRecord, userId } : null, conflict.reason, conflict.message, conflict.createdAt)
          await tx.objectStore('sync_conflicts').delete(conflict.id)
          await tx.objectStore('sync_conflicts').put({ ...adopted, resolvedAt: conflict.resolvedAt })
        }
        for (const base of await tx.objectStore('sync_bases').getAll()) if (base.userId === settings.localUserId) {
          await tx.objectStore('sync_bases').delete(base.id)
          await tx.objectStore('sync_bases').put(makeSyncBase(base.table, { ...base.record, userId }))
        }
      }
      if (!isCurrent()) throw new AccountChangedError()
      const next = { ...settings, activeCloudUserId: cloud ? userId : null, lastCloudUserId: cloud && userId ? userId : settings.lastCloudUserId }
      await tx.objectStore('settings').put(next, 'app')
      if (!isCurrent()) throw new AccountChangedError()
      await tx.done
      if (!isCurrent()) throw new AccountChangedError()
      return next
    } catch (error) { try { tx.abort() } catch { /* Already aborted. */ } await tx.done.catch(() => undefined); throw error }
  },
  async getTicketCreateOperation(operationId: string, owner: LedgerOwnerContext) {
    const database = await getDb()
    const tx = database.transaction(['settings', 'ticket_create_operations', 'tickets'], 'readonly')
    assertLedgerOwner(await tx.objectStore('settings').get('app'), owner)
    const receipt = await tx.objectStore('ticket_create_operations').get(ticketOperationKey(owner.userId, operationId))
    const ticket = receipt ? await tx.objectStore('tickets').get(receipt.ticketId) : undefined
    if (receipt && (receipt.userId !== owner.userId || (ticket && ticket.userId !== owner.userId))) throw new AccountChangedError()
    checkEpoch(owner, tx); await tx.done; checkEpoch(owner)
    if (!owner.isCurrent()) throw new AccountChangedError()
    return receipt ? { receipt, ticket: ticket ?? receipt.acceptedRecord } : undefined
  },
  async putNewTicketOnce(ticket: TicketRecord, fingerprint: string, owner: LedgerOwnerContext) {
    const database = await getDb()
    const tx = database.transaction(['settings', 'tickets', 'ticket_create_operations'], 'readwrite')
    try {
      assertLedgerOwner(await tx.objectStore('settings').get('app'), owner, ticket.userId)
      const key = ticketOperationKey(owner.userId, ticket.id)
      const receipt = await tx.objectStore('ticket_create_operations').get(key)
      const current = await tx.objectStore('tickets').get(ticket.id)
      if (receipt) {
        if (receipt.userId !== owner.userId || (current && current.userId !== owner.userId)) throw new AccountChangedError()
        if (receipt.fingerprint !== fingerprint) throw new Error('这次提交已经保存过不同内容，请重新打开新增记录。')
        checkEpoch(owner, tx); await tx.done; checkEpoch(owner)
        return current ?? receipt.acceptedRecord
      }
      if (current && (current.userId !== owner.userId || meaningfulRecordChanged(current, ticket))) throw new Error('此提交编号已有其他记录，请重新打开新增记录。')
      const accepted = current ?? ticket
      await tx.objectStore('tickets').put(accepted)
      await tx.objectStore('ticket_create_operations').add({ id: key, userId: owner.userId, ticketId: ticket.id, fingerprint, acceptedRecord: accepted })
      checkEpoch(owner, tx); await tx.done; checkEpoch(owner)
      return accepted
    } catch (error) { try { tx.abort() } catch { /* Already aborted. */ } await tx.done.catch(() => undefined); throw error }
  },
  async getSyncConflicts() { return (await getDb()).getAll('sync_conflicts') },
  async resolveSyncConflict(id: string, owner: LedgerOwnerContext) {
    const database = await getDb()
    const tx = database.transaction(['settings', 'sync_conflicts', 'tickets', 'ticket_refunds'], 'readwrite')
    try {
      assertLedgerOwner(await tx.objectStore('settings').get('app'), owner)
      const conflict = await tx.objectStore('sync_conflicts').get(id)
      if (!conflict || conflict.userId !== owner.userId) throw new Error('当前账号无法处理这条冲突记录。')
      // A definitively rejected new draft has no accepted cloud original. Keep
      // its archived copy, but remove the unchanged error draft from the ledger.
      if (conflict.table === 'tickets' && !conflict.remoteRecord) {
        const current = await tx.objectStore('tickets').get(conflict.recordId)
        const refunds = await tx.objectStore('ticket_refunds').index('by-ticket-id').getAll(conflict.recordId)
        if (current?.userId === owner.userId && current.syncStatus === 'error' && current.updatedAt === conflict.localRecord.updatedAt && !meaningfulRecordChanged(current, conflict.localRecord) && !refunds.some(row => row.userId === owner.userId)) await tx.objectStore('tickets').delete(current.id)
      }
      await tx.objectStore('sync_conflicts').put({ ...conflict, resolvedAt: conflict.resolvedAt ?? new Date().toISOString() })
      checkEpoch(owner, tx); await tx.done; checkEpoch(owner)
    } catch (error) { try { tx.abort() } catch { /* Already aborted. */ } await tx.done.catch(() => undefined); throw error }
  },
  async quarantineTicket(id: string, remote: TicketRecord | undefined, message: string, owner: LedgerOwnerContext) {
    const database = await getDb()
    const tx = database.transaction(['settings', 'sync_conflicts', 'tickets', 'sync_bases'], 'readwrite')
    try {
      assertLedgerOwner(await tx.objectStore('settings').get('app'), owner)
      if (remote && (remote.id !== id || remote.userId !== owner.userId)) throw new AccountChangedError()
      const current = await tx.objectStore('tickets').get(id)
      if (current && current.userId === owner.userId && current.syncStatus !== 'synced') {
        const conflict = makeSyncConflict('tickets', current, remote ?? null, 'upload_rejected', message, new Date().toISOString())
        if (!await tx.objectStore('sync_conflicts').get(conflict.id)) await tx.objectStore('sync_conflicts').put(conflict)
        await tx.objectStore('tickets').put(remote ? { ...remote, syncStatus: 'synced' } : { ...current, syncStatus: 'error' })
      }
      if (remote) await tx.objectStore('sync_bases').put(makeSyncBase('tickets', remote))
      checkEpoch(owner, tx); await tx.done; checkEpoch(owner)
    } catch (error) { try { tx.abort() } catch { /* Already aborted. */ } await tx.done.catch(() => undefined); throw error }
  },
  async reconcileCatalogue(userId: string, suppliers: Supplier[], projects: Project[], owner?: LedgerOwnerContext) {
    const database = await getDb()
    const transaction = database.transaction(['suppliers', 'projects', 'tickets', 'settings'], 'readwrite')
    try {
      const settings = await transaction.objectStore('settings').get('app')
      if (owner) assertLedgerOwner(settings, owner)
      if (settings?.lastCloudUserId !== userId) throw new Error('账号正在切换，请稍后重试同步。')
      const merged = reconcileCatalogue({
        suppliers: await transaction.objectStore('suppliers').getAll(),
        projects: await transaction.objectStore('projects').getAll(),
        tickets: await transaction.objectStore('tickets').getAll()
      }, { suppliers, projects }, userId)
      for (const row of merged.suppliers) await transaction.objectStore('suppliers').put(row)
      for (const row of merged.projects) await transaction.objectStore('projects').put(row)
      for (const row of merged.tickets) await transaction.objectStore('tickets').put(row)
      checkEpoch(owner, transaction); await transaction.done; checkEpoch(owner)
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
  mergeRemoteTickets: (tickets: TicketRecord[], owner?: LedgerOwnerContext, lockedTicketIds?: Set<string>, acknowledged?: TicketRecord[]) => mergeRemoteRows('tickets', tickets, owner, lockedTicketIds, acknowledged),
  mergeRemoteSuppliers: (suppliers: Supplier[], owner?: LedgerOwnerContext, lockedTicketIds?: Set<string>, acknowledged?: Supplier[]) => mergeRemoteRows('suppliers', suppliers, owner, lockedTicketIds, acknowledged),
  mergeRemoteProjects: (projects: Project[], owner?: LedgerOwnerContext, lockedTicketIds?: Set<string>, acknowledged?: Project[]) => mergeRemoteRows('projects', projects, owner, lockedTicketIds, acknowledged),
  mergeRemoteRefunds: (refunds: RefundRecord[], owner?: LedgerOwnerContext, lockedTicketIds?: Set<string>, acknowledged?: RefundRecord[]) => mergeRemoteRows('ticket_refunds', refunds, owner, lockedTicketIds, acknowledged),
  mergeRemoteShow79Settlements: (records: Show79SettlementRecord[], owner?: LedgerOwnerContext) => mergeRemoteRows('show79_settlements', records, owner),
  async getShow79Settlements() { return (await getDb()).getAll('show79_settlements') },
  async getShow79Settlement(id: string) { return (await getDb()).get('show79_settlements', id) },
  async putConfirmedShow79Settlement(record: Show79SettlementRecord, owner?: LedgerOwnerContext) {
    const database = await getDb()
    const tx = database.transaction(['show79_settlements', 'settings'], 'readwrite')
    if (owner) assertLedgerOwner(await tx.objectStore('settings').get('app'), owner, record.userId)
    const existing = await tx.objectStore('show79_settlements').get(record.id)
    if (existing && existing.userId !== record.userId) { checkEpoch(owner, tx); await tx.done; checkEpoch(owner); throw new Error('这条分账记录属于其他账号。') }
    await tx.objectStore('show79_settlements').put(record)
    checkEpoch(owner, tx); await tx.done; checkEpoch(owner)
  },
  async addLocalShow79Settlement(record: Show79SettlementRecord, input: Show79SettlementInput, owner?: LedgerOwnerContext) {
    const database = await getDb()
    const tx = database.transaction(['show79_settlements', 'settings', 'tickets', 'ticket_refunds'], 'readwrite')
    try {
      const settings = await tx.objectStore('settings').get('app')
      if (owner) assertLedgerOwner(settings, owner, record.userId)
      const userId = owner?.userId ?? settings?.lastCloudUserId ?? settings?.localUserId
      if (!userId || record.userId !== userId) throw new Error('当前账号无法登记这笔分账。')
      const existing = await tx.objectStore('show79_settlements').get(record.id)
      if (existing) { if (existing.userId !== userId) throw new AccountChangedError(); checkEpoch(owner, tx); await tx.done; checkEpoch(owner); return existing }
      const tickets = (await tx.objectStore('tickets').getAll()).filter(row => row.userId === userId)
      const refunds = (await tx.objectStore('ticket_refunds').getAll()).filter(row => row.userId === userId)
      const history = (await tx.objectStore('show79_settlements').getAll()).filter(row => row.userId === userId)
      const state = buildShow79SettlementState(attachRefunds(tickets, refunds), history, input.month)
      const cents = (value: number) => Math.round(value * 100)
      if (cents(state.profitThb) !== cents(input.expectedProfitThb) || cents(state.paidJimmyThb) !== cents(input.expectedJimmyPaidThb) || cents(state.paidPartnersThb) !== cents(input.expectedPartnersPaidThb)) throw Object.assign(new Error('本月利润或已付金额已更新，请刷新后核对再登记。'), { code: '40001' })
      if (Math.abs(cents(state.paidJimmyThb) + cents(input.jimmyPaidThb)) > 99999999999999 || Math.abs(cents(state.paidPartnersThb) + cents(input.partnersPaidThb)) > 99999999999999) throw new Error('累计分账金额过大，请检查输入。')
      const accepted = { ...record, snapshotProfitThb: state.profitThb, snapshotJimmyThb: state.jimmyThb, snapshotPartnersThb: state.partnersThb }
      await tx.objectStore('show79_settlements').add(accepted)
      checkEpoch(owner, tx); await tx.done; checkEpoch(owner)
      return accepted
    } catch (error) { try { tx.abort() } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error }
  },
  async getRefunds() { return (await getDb()).getAll('ticket_refunds') },
  async getRefund(id: string) { return (await getDb()).get('ticket_refunds', id) },
  async putRefund(refund: RefundRecord, owner?: LedgerOwnerContext) { return putLocalRecord('ticket_refunds', refund, owner) },
  async addLocalRefund(refund: RefundRecord, owner?: LedgerOwnerContext) {
    const database = await getDb()
    const transaction = database.transaction(['tickets', 'ticket_refunds', 'settings'], 'readwrite')
    try {
      const settings = await transaction.objectStore('settings').get('app')
      if (owner) assertLedgerOwner(settings, owner, refund.userId)
      const userId = owner?.userId ?? settings?.lastCloudUserId ?? settings?.localUserId
      const existing = await transaction.objectStore('ticket_refunds').get(refund.id)
      if (existing) { if (existing.userId !== userId) throw new AccountChangedError(); await transaction.done; return existing }
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
  async putTicket(ticket: TicketRecord, owner?: LedgerOwnerContext) {
    return putLocalRecord('tickets', ticket, owner)
  },
  async putTickets(tickets: TicketRecord[]) {
    const database = await getDb()
    const transaction = database.transaction('tickets', 'readwrite')
    await Promise.all([...tickets.map((ticket) => transaction.store.put(ticket)), transaction.done])
  },
  async getSuppliers() {
    return (await (await getDb()).getAll('suppliers')).filter(row => !row.mergedIntoId)
  },
  async putSupplier(supplier: Supplier, owner?: LedgerOwnerContext) {
    return putLocalRecord('suppliers', supplier, owner)
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
  async putProject(project: Project, owner?: LedgerOwnerContext) {
    return putLocalRecord('projects', project, owner)
  },
  async putProjects(projects: Project[]) {
    const database = await getDb()
    const transaction = database.transaction('projects', 'readwrite')
    await Promise.all([...projects.map((project) => transaction.store.put(project)), transaction.done])
  },
  async getSettings() {
    return (await getDb()).get('settings', 'app')
  },
  async getOrCreateSettings(): Promise<LedgerSettings> {
    const database = await getDb()
    const tx = database.transaction('settings', 'readwrite')
    const existing = await tx.store.get('app')
    const settings = existing ?? { localUserId: createId(), lastCloudUserId: null }
    if (!existing) await tx.store.put(settings, 'app')
    await tx.done
    return settings
  },
  async putSettings(settings: AppSettings) {
    return (await getDb()).put('settings', settings, 'app')
  }
}
