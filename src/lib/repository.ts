import type { SupabaseClient, User } from '@supabase/supabase-js'
import { db } from './db'
import { createId, getBangkokTime, isValidCalendarDate, isValidIssueTime, isValidPersonCount, normalizeSupplier } from './format'
import { getSupabase } from './supabase'
import { needsUpload, nextModifiedAt, type VersionedRecord } from './sync'
import type { AmountBasis, AppSettings, EntryMode, Project, ProjectInput, ProjectPricesInput, QuantityUnit, RefundInput, RefundRecord, SettlementMode, Supplier, SyncStatus, TicketInput, TicketRecord } from '../types'
import { resolveProjectRules, validateProjectRules } from './project-rules'
import { getTicketAmounts, validateAmountPrecision } from './ticket-amounts'
import { attachRefunds } from './refunds'
import { validateRefundInput } from './refund-input'
import { quantityLabels } from './quantity'
import { cleanProjectLabel, projectDisplay } from './project-labels'
import { isShow79Project } from './show79'
import { buildShow79SettlementState, validateShow79SettlementInput, type Show79SettlementInput, type Show79SettlementRecord } from './show79-settlement'
import { AccountChangedError, assertLedgerOwner, type LedgerOwnerContext } from './ledger-account'
import { ticketCreateFingerprint } from './sync-conflicts'
import { isMedicineProject, validateMedicineBatchShape, type MedicineTicketEntry } from './medicine-batch'
import { isShow69Project, validateShow69Record, type Show69RecordInput } from './show69'

const LOCAL_USER_ID_KEY = 'localUserId'
let accountUserId: string | null | undefined
let accountEpoch = 0
let accountReady: Promise<Awaited<ReturnType<typeof db.activateAccount>>> | undefined

async function activateAccount(userId: string | null) {
  const cloud = Boolean(getSupabase())
  const target = cloud ? userId : null
  if (accountUserId === target && accountReady) {
    const pending = accountReady
    const epoch = accountEpoch
    let succeeded = false
    try { await pending; succeeded = true }
    catch (error) {
      if (accountReady !== pending || accountEpoch !== epoch) throw new AccountChangedError()
      // A failed IndexedDB activation may be retried on the next auth event.
      if (error instanceof AccountChangedError) throw error
    }
    if (succeeded) {
      if (accountEpoch !== epoch || accountUserId !== target) throw new AccountChangedError()
      return
    }
  }
  const epoch = ++accountEpoch
  accountUserId = target
  accountReady = db.activateAccount(target, cloud, () => accountEpoch === epoch && accountUserId === target)
  await accountReady
  if (accountEpoch !== epoch) throw new AccountChangedError()
}

async function ownerContext(write = false): Promise<LedgerOwnerContext | null> {
  const cloud = Boolean(getSupabase())
  if (cloud && !accountUserId) {
    if (write) throw new AccountChangedError()
    return null
  }
  if (!accountReady) { await activateAccount(null); return ownerContext(write) }
  const epoch = accountEpoch
  const target = accountUserId
  const pending = accountReady
  await pending
  if (accountEpoch !== epoch || accountUserId !== target) throw new AccountChangedError()
  const settings = await getSettings()
  const userId = cloud ? target : settings.localUserId
  if (!userId) { if (write) throw new AccountChangedError(); return null }
  const owner = { userId, cloud, isCurrent: () => accountEpoch === epoch && accountUserId === target }
  assertLedgerOwner(settings, owner)
  return owner
}

const assertCurrent = (owner: LedgerOwnerContext) => { if (!owner.isCurrent()) throw new AccountChangedError() }

// Catalogue preparation is shared by concurrent saves, while every read/write
// remains pinned to the account that started the request.
let show69CataloguePreparation: Promise<void> = Promise.resolve()
function prepareShow69Catalogue(owner: LedgerOwnerContext): Promise<{ supplier: Supplier; project: Project }> {
  const preparation = show69CataloguePreparation.then(async () => {
    assertCurrent(owner)
    const supplierName = '69秀独立记录'
    const suppliers = await db.getSuppliers()
    assertCurrent(owner)
    let supplier = suppliers.find(row => row.userId === owner.userId && row.normalizedName === normalizeSupplier(supplierName))
    if (!supplier) {
      const timestamp = now()
      supplier = { id: createId(), userId: owner.userId, name: supplierName, normalizedName: normalizeSupplier(supplierName), createdAt: timestamp, updatedAt: timestamp, syncStatus: statusForWrite() }
      await db.putSupplier(supplier, owner)
      assertCurrent(owner)
    }
    const projects = await db.getProjects()
    assertCurrent(owner)
    let project = projects.find(row => row.userId === owner.userId && row.supplierId === supplier.id && cleanProjectLabel(row.name) === '69秀' && cleanProjectLabel(row.subItemName) === '独立记录')
    if (!project) {
      const timestamp = nextModifiedAt(supplier.updatedAt)
      project = {
        id: createId(), userId: owner.userId, supplierId: supplier.id, supplierName: supplier.name,
        name: '69秀', normalizedName: normalizeSupplier('69秀'), subItemName: '独立记录', normalizedSubItemName: normalizeSupplier('独立记录'),
        quantityUnit: 'person', entryMode: 'standard', defaultAmountBasis: 'per_person', settlementMode: 'monthly',
        defaultCostThb: 0, defaultAgentPriceThb: 0, manualAgentPrice: false, manualCostPrice: false, manualSupplier: false,
        createdAt: timestamp, updatedAt: timestamp, syncStatus: statusForWrite()
      }
      await db.putProject(project, owner)
      assertCurrent(owner)
    }
    return { supplier, project }
  })
  show69CataloguePreparation = preparation.then(() => undefined, () => undefined)
  return preparation
}

async function ticketWithCurrentRefunds(ticket: TicketRecord, owner: LedgerOwnerContext): Promise<TicketRecord> {
  return (await ticketsWithCurrentRefunds([ticket], owner))[0]
}

async function ticketsWithCurrentRefunds(tickets: TicketRecord[], owner: LedgerOwnerContext): Promise<TicketRecord[]> {
  assertCurrent(owner)
  if (tickets.some(ticket => ticket.userId !== owner.userId)) throw new AccountChangedError()
  const refunds = (await db.getRefunds()).filter(row => row.userId === owner.userId)
  assertCurrent(owner)
  return attachRefunds(tickets, refunds)
}

// Prepare all medicine rows before starting a write transaction. Catalogue and
// account versions are checked again by the atomic IndexedDB batch operation.
function stageMedicineTicket(entry: MedicineTicketEntry, project: Project, supplier: Supplier, owner: LedgerOwnerContext): TicketRecord {
  const input = entry.input
  if (!isMedicineProject(project) || project.userId !== owner.userId || supplier.userId !== owner.userId || supplier.id !== project.supplierId) throw new Error('请选择当前账号已录入的药品商品套餐。')
  if (typeof input.supplierName !== 'string' || normalizeSupplier(input.supplierName) !== normalizeSupplier(supplier.name) || typeof input.projectName !== 'string' || cleanProjectLabel(input.projectName) !== cleanProjectLabel(project.name) || typeof input.subItemName !== 'string' || cleanProjectLabel(input.subItemName) !== cleanProjectLabel(project.subItemName)) throw new Error('药品套餐或供货商已变化，请重新选择后保存。')
  if (!isValidCalendarDate(input.issueDate)) throw new Error('请填写有效的出票日期。')
  if ((input.guestName ?? '').trim().length > 100) throw new Error('客户姓名最多100个字符。')
  if (!input.issueTime || !isValidIssueTime(input.issueTime)) throw new Error('请填写有效的曼谷时间（HH:mm）。')
  if (input.personCount == null || !isValidPersonCount(input.personCount)) throw new Error('药品数量必须是大于或等于1的整数。')
  const rules = resolveProjectRules(project)
  validateProjectRules({ defaultAmountBasis: input.amountBasis ?? rules.defaultAmountBasis, settlementMode: rules.settlementMode })
  if (project.manualAgentPrice && !Number.isFinite(input.agentPriceThb)) throw new Error('请填写每项药品的实际售价。')
  validateAmountPrecision([input.agentPriceThb, input.costThb])
  const timestamp = nextModifiedAt(project.updatedAt, supplier.updatedAt)
  const ticket: TicketRecord = {
    id: entry.operationId, userId: owner.userId, guestName: input.guestName?.trim() ?? '',
    issueDate: input.issueDate, issueTime: input.issueTime, personCount: input.personCount,
    supplierId: supplier.id, supplierName: supplier.name, projectId: project.id,
    projectName: cleanProjectLabel(project.name), subItemName: cleanProjectLabel(project.subItemName),
    quantityUnit: 'item', entryMode: 'standard', manualProfitThb: null,
    amountBasis: input.amountBasis ?? rules.defaultAmountBasis, settlementMode: rules.settlementMode,
    agentPriceThb: input.agentPriceThb, costThb: input.costThb, note: input.note.trim(),
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, syncStatus: statusForWrite()
  }
  const totals = getTicketAmounts(ticket)
  validateAmountPrecision([totals.agentPriceThb, totals.costThb, Math.abs(totals.profitThb)])
  return ticket
}

type CloudSupplier = {
  id: string
  user_id: string
  name: string
  normalized_name: string
  created_at: string
  updated_at: string
}

type CloudTicket = {
  guest_name?: string
  settlement_mode?: SettlementMode | null
  quantity_unit?: QuantityUnit
  amount_basis?: AmountBasis
  person_count?: number | null
  entry_mode?: EntryMode
  manual_profit_thb?: number | string | null
  issue_time?: string | null
  id: string
  user_id: string
  issue_date: string
  supplier_id: string
  supplier_name: string
  project_id: string | null
  project_name: string
  sub_item_name: string
  agent_price_thb: number | string
  cost_thb: number | string
  note: string
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type CloudProject = {
  manual_supplier?: boolean | null
  manual_cost_price?: boolean | null
  default_amount_basis?: AmountBasis | null
  settlement_mode?: SettlementMode | null
  manual_agent_price?: boolean
  quantity_unit?: QuantityUnit
  entry_mode?: EntryMode
  id: string
  user_id: string
  supplier_id: string | null
  supplier_name: string
  name: string
  normalized_name: string
  sub_item_name: string
  normalized_sub_item_name: string
  default_cost_thb: number | string
  default_agent_price_thb: number | string
  created_at: string
  updated_at: string
}

type CloudRefund = { id: string; user_id: string; ticket_id: string; person_count: number | null; is_full: boolean; refund_revenue_thb: number | string; returned_cost_thb: number | string; refund_date: string; refund_time: string; note: string; cancelled_at: string | null; created_at: string; updated_at: string }
type CloudShow79Settlement = {
  id: string; user_id: string; month: string; snapshot_profit_thb: number | string;
  snapshot_jimmy_thb: number | string; snapshot_partners_thb: number | string;
  jimmy_paid_thb: number | string; partners_paid_thb: number | string;
  payment_date: string; note: string; created_at: string; updated_at: string
}
const toLocalShow79Settlement = (row: CloudShow79Settlement): Show79SettlementRecord => ({
  id: row.id, userId: row.user_id, month: row.month,
  snapshotProfitThb: Number(row.snapshot_profit_thb), snapshotJimmyThb: Number(row.snapshot_jimmy_thb), snapshotPartnersThb: Number(row.snapshot_partners_thb),
  jimmyPaidThb: Number(row.jimmy_paid_thb), partnersPaidThb: Number(row.partners_paid_thb), paymentDate: row.payment_date,
  note: row.note, createdAt: row.created_at, updatedAt: row.updated_at, syncStatus: 'synced'
})
const toLocalRefund = (row: CloudRefund): RefundRecord => ({ id: row.id, userId: row.user_id, ticketId: row.ticket_id, personCount: row.person_count, isFull: row.is_full, refundRevenueThb: Number(row.refund_revenue_thb), returnedCostThb: Number(row.returned_cost_thb), refundDate: row.refund_date, refundTime: row.refund_time.slice(0, 5), note: row.note, cancelledAt: row.cancelled_at, createdAt: row.created_at, updatedAt: row.updated_at, syncStatus: 'synced' })
const toCloudRefund = (row: RefundRecord) => ({ id: row.id, user_id: row.userId, ticket_id: row.ticketId, person_count: row.personCount, is_full: row.isFull, refund_revenue_thb: row.refundRevenueThb, returned_cost_thb: row.returnedCostThb, refund_date: row.refundDate, refund_time: row.refundTime, note: row.note, cancelled_at: row.cancelledAt, created_at: row.createdAt, updated_at: row.updatedAt })

export interface SyncResult {
  synced: boolean
  message?: string
}

const now = () => nextModifiedAt()

const statusForWrite = (): SyncStatus => (getSupabase() ? 'pending' : 'synced')

const toLocalSupplier = (supplier: CloudSupplier): Supplier => ({
  id: supplier.id,
  userId: supplier.user_id,
  name: supplier.name,
  normalizedName: supplier.normalized_name,
  createdAt: supplier.created_at,
  updatedAt: supplier.updated_at,
  syncStatus: 'synced'
})

const toCloudSupplier = (supplier: Supplier) => ({
  id: supplier.id,
  user_id: supplier.userId,
  name: supplier.name,
  normalized_name: supplier.normalizedName,
  created_at: supplier.createdAt,
  updated_at: supplier.updatedAt
})

const toLocalProject = (project: CloudProject): Project => ({
  manualSupplier: project.manual_supplier ?? undefined,
  manualCostPrice: project.manual_cost_price ?? undefined,
  defaultAmountBasis: project.default_amount_basis ?? undefined,
  settlementMode: project.settlement_mode ?? undefined,
  manualAgentPrice: project.manual_agent_price ?? false,
  quantityUnit: project.quantity_unit ?? 'person',
  entryMode: project.entry_mode ?? 'standard',
  id: project.id,
  userId: project.user_id,
  supplierId: project.supplier_id ?? '',
  supplierName: project.supplier_name,
  name: project.name,
  normalizedName: project.normalized_name,
  subItemName: project.sub_item_name ?? '默认套餐',
  normalizedSubItemName: project.normalized_sub_item_name ?? '默认套餐',
  defaultCostThb: Number(project.default_cost_thb),
  defaultAgentPriceThb: Number(project.default_agent_price_thb),
  createdAt: project.created_at,
  updatedAt: project.updated_at,
  syncStatus: 'synced'
})

const toCloudProject = (project: Project) => ({
  manual_supplier: project.manualSupplier ?? null,
  manual_cost_price: project.manualCostPrice ?? null,
  default_amount_basis: project.defaultAmountBasis ?? null,
  settlement_mode: project.settlementMode ?? null,
  manual_agent_price: project.manualAgentPrice ?? false,
  quantity_unit: project.quantityUnit ?? 'person',
  entry_mode: project.entryMode ?? 'standard',
  id: project.id,
  user_id: project.userId,
  supplier_id: project.supplierId || null,
  supplier_name: project.supplierName,
  name: cleanProjectLabel(project.name),
  normalized_name: normalizeSupplier(cleanProjectLabel(project.name)),
  sub_item_name: cleanProjectLabel(project.subItemName),
  normalized_sub_item_name: normalizeSupplier(cleanProjectLabel(project.subItemName)),
  default_cost_thb: project.defaultCostThb,
  default_agent_price_thb: project.defaultAgentPriceThb,
  created_at: project.createdAt,
  updated_at: project.updatedAt
})

const toLocalTicket = (ticket: CloudTicket): TicketRecord => ({
  guestName: ticket.guest_name ?? '',
  settlementMode: ticket.settlement_mode ?? undefined,
  quantityUnit: ticket.quantity_unit ?? 'person',
  amountBasis: ticket.amount_basis ?? 'total',
  personCount: ticket.person_count ?? null,
  entryMode: ticket.entry_mode ?? 'standard',
  manualProfitThb: ticket.manual_profit_thb == null ? null : Number(ticket.manual_profit_thb),
  issueTime: ticket.issue_time?.slice(0, 5) ?? null,
  id: ticket.id,
  userId: ticket.user_id,
  issueDate: ticket.issue_date,
  supplierId: ticket.supplier_id,
  supplierName: ticket.supplier_name,
  projectId: ticket.project_id,
  projectName: ticket.project_name || '未分类项目',
  subItemName: ticket.sub_item_name ?? '默认套餐',
  agentPriceThb: Number(ticket.agent_price_thb),
  costThb: Number(ticket.cost_thb),
  note: ticket.note,
  deletedAt: ticket.deleted_at,
  createdAt: ticket.created_at,
  updatedAt: ticket.updated_at,
  syncStatus: 'synced'
})

const toCloudTicket = (ticket: TicketRecord) => ({
  guest_name: ticket.guestName ?? '',
  settlement_mode: ticket.settlementMode ?? null,
  quantity_unit: ticket.quantityUnit ?? 'person',
  amount_basis: ticket.amountBasis ?? 'total',
  person_count: ticket.personCount ?? null,
  entry_mode: ticket.entryMode ?? 'standard',
  manual_profit_thb: ticket.entryMode === 'profit_only' ? ticket.manualProfitThb ?? null : null,
  issue_time: ticket.issueTime || null,
  id: ticket.id,
  user_id: ticket.userId,
  issue_date: ticket.issueDate,
  supplier_id: ticket.supplierId,
  supplier_name: ticket.supplierName,
  project_id: ticket.projectId,
  project_name: ticket.projectName || '未分类项目',
  sub_item_name: ticket.subItemName,
  agent_price_thb: ticket.agentPriceThb,
  cost_thb: ticket.costThb,
  note: ticket.note,
  deleted_at: ticket.deletedAt,
  created_at: ticket.createdAt,
  updated_at: ticket.updatedAt
})

const getSettings = async (): Promise<AppSettings> => {
  return db.getOrCreateSettings()
}

type CloudTable = 'suppliers' | 'projects' | 'tickets' | 'ticket_refunds' | 'show79_settlements'

async function fetchCloudRows<T>(client: SupabaseClient, table: CloudTable, userId: string, signal: AbortSignal, owner?: LedgerOwnerContext): Promise<T[]> {
  const rows: T[] = []
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    signal.throwIfAborted()
    if (owner) assertCurrent(owner)
    const { data, error } = await client.from(table).select('*').eq('user_id', userId)
      .order('id').range(offset, offset + pageSize - 1).abortSignal(signal)
    if (error) throw new Error(error.message)
    if (owner) assertCurrent(owner)
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

async function synchroniseTable<Local extends VersionedRecord, Cloud>(options: {
  client: SupabaseClient
  table: CloudTable
  userId: string
  signal: AbortSignal
  owner: LedgerOwnerContext
  initialRemote?: Local[]
  lockedTicketIds?: Set<string>
  getLocal: () => Promise<Local[]>
  mergeRemote: (records: Local[], owner?: LedgerOwnerContext, lockedTicketIds?: Set<string>, acknowledged?: Local[]) => Promise<void>
  toLocal: (record: Cloud) => Local
  toCloud: (record: Local) => object
}) {
  const { client, table, userId, signal, owner, getLocal, mergeRemote, toLocal, toCloud } = options
  const check = () => { signal.throwIfAborted(); assertCurrent(owner) }
  check()
  const remote = options.initialRemote ?? (await fetchCloudRows<Cloud>(client, table, userId, signal, owner)).map(toLocal)
  await mergeRemote(remote, owner, options.lockedTicketIds)
  const remoteMap = new Map(remote.map((record) => [record.id, record]))
  const pending = (await getLocal()).filter((record) => record.userId === userId && record.syncStatus !== 'error' && needsUpload(record, remoteMap.get(record.id)))
  // Equal versions are acknowledged locally without another database UPDATE.
  // This prevents our own realtime notifications from starting an upload loop.
  if (!pending.length) return

  const batches: Local[][] = []
  const grouped = table === 'tickets' ? pending.filter(row => !remoteMap.has(row.id)) : pending
  for (let offset = 0; offset < grouped.length; offset += 100) batches.push(grouped.slice(offset, offset + 100))
  if (table === 'tickets') batches.push(...pending.filter(row => remoteMap.has(row.id)).map(row => [row]))
  const uploadBatch = async (batch: Local[]) => {
    check()
    if (table !== 'tickets') return client.from(table).upsert(batch.map(toCloud), { onConflict: 'id' }).abortSignal(signal)
    const previous = remoteMap.get(batch[0].id)
    if (previous) {
      // Compare against the cloud version we actually read. A faster phone
      // clock must not overwrite a competing save made after that read.
      return client.from('tickets').update(toCloud(batch[0])).eq('user_id', userId).eq('id', batch[0].id)
        .eq('updated_at', previous.updatedAt).abortSignal(signal)
    }
    // New operation IDs are inserts; an existing UUID can never become an
    // accidental update after a lost response or cold-cache retry.
    return client.from('tickets').insert(batch.map(toCloud)).abortSignal(signal)
  }
  for (const batch of batches) {
    check()
    const { error } = await uploadBatch(batch)
    check()
    if (error) {
      // A deterministic row rejection must not hold unrelated new orders hostage.
      // Network/auth errors remain pending for an ordinary retry.
      if (table !== 'tickets' || !/^(?:22|23|P0001)/.test(error.code ?? '')) throw Object.assign(new Error(error.message), { code: error.code })
      for (const row of batch) {
        check()
        const result = batch.length === 1 ? { error } : await uploadBatch([row])
        check()
        if (!result.error) continue
        if (!/^(?:22|23|P0001)/.test(result.error.code ?? '')) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        const { data, error: readError } = await client.from('tickets').select('*').eq('user_id', userId).eq('id', row.id).abortSignal(signal)
        check()
        if (readError) throw new Error(readError.message)
        await db.quarantineTicket(row.id, data?.[0] ? toLocalTicket(data[0] as CloudTicket) : undefined, `此票未能上传：${result.error.message} 本机内容已保留为副本，其他订单继续同步。`, owner)
      }
      // Include a refund created after the first pull, which may be the reason
      // the server rejected a formerly editable original ticket.
      await db.mergeRemoteRefunds((await fetchCloudRows<CloudRefund>(client, 'ticket_refunds', userId, signal, owner)).map(toLocalRefund), owner)
    }
  }
  // A newer write may have reached PostgreSQL after our first pull. The server
  // rejects stale updates; read its actual result instead of acknowledging the
  // originally submitted snapshot. Atomic local merging preserves edits made
  // while this request was in flight.
  await mergeRemote((await fetchCloudRows<Cloud>(client, table, userId, signal, owner)).map(toLocal), owner, undefined, pending)
}

export const ledgerRepository = {
  activateAccount,
  async getSyncConflicts(includeResolved = false) {
    const owner = await ownerContext()
    if (!owner) return []
    const records = await db.getSyncConflicts()
    assertCurrent(owner)
    return records.filter(row => row.userId === owner.userId && (includeResolved || !row.resolvedAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },
  async resolveSyncConflict(id: string) {
    const owner = (await ownerContext(true))!
    await db.resolveSyncConflict(id, owner)
  },
  async getCatalogueAliases() {
    const owner = await ownerContext()
    if (!owner) return { suppliers: [], projects: [] }
    const aliases = await db.getCatalogueAliases()
    assertCurrent(owner)
    return { suppliers: aliases.suppliers.filter(row => row.userId === owner.userId), projects: aliases.projects.filter(row => row.userId === owner.userId) }
  },
  async getSettings() {
    return getSettings()
  },

  async getTickets() {
    const owner = await ownerContext()
    if (!owner) return []
    const [tickets, refunds] = await Promise.all([db.getTickets(), db.getRefunds()])
    assertCurrent(owner)
    return attachRefunds(tickets.filter(ticket => ticket.userId === owner.userId), refunds.filter(row => row.userId === owner.userId))
  },

  async getRefunds() {
    const owner = await ownerContext()
    if (!owner) return []
    const rows = await db.getRefunds()
    assertCurrent(owner)
    return rows.filter(row => row.userId === owner.userId)
  },

  async getShow79Settlements() {
    const owner = await ownerContext()
    if (!owner) return []
    const rows = await db.getShow79Settlements()
    assertCurrent(owner)
    return rows.filter(row => row.userId === owner.userId)
  },

  async createShow79Settlement(input: Show79SettlementInput): Promise<Show79SettlementRecord> {
    validateShow79SettlementInput(input)
    const owner = (await ownerContext(true))!
    const userId = owner.userId
    const client = getSupabase()
    if (client && !navigator.onLine) throw new Error('分账登记需要联网确认，防止跨设备重复结算。')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const receipt = async () => {
      assertCurrent(owner)
      if (!client) return db.getShow79Settlement(input.operationId)
      const { data, error } = await client.from('show79_settlements').select('*').eq('user_id', userId).eq('id', input.operationId).abortSignal(controller.signal)
      if (error) throw new Error(error.message)
      return data?.[0] ? toLocalShow79Settlement(data[0] as CloudShow79Settlement) : undefined
    }
    const sameRequest = (row: Show79SettlementRecord) => row.userId === userId && row.month === input.month && row.paymentDate === input.paymentDate && row.jimmyPaidThb === input.jimmyPaidThb && row.partnersPaidThb === input.partnersPaidThb && row.note === input.note.trim()
    const confirm = async (row: Show79SettlementRecord) => {
      if (!sameRequest(row)) throw new Error('分账提交编号已使用，请核对内容后重新登记。')
      assertCurrent(owner)
      await db.putConfirmedShow79Settlement(row, owner)
      return row
    }
    try {
      const existing = await receipt()
      if (existing) return confirm(existing)
      const tickets = await this.getTickets()
      const history = await this.getShow79Settlements()
      const state = buildShow79SettlementState(tickets, history, input.month)
      if (!client) {
        const timestamp = now()
        const record: Show79SettlementRecord = { id: input.operationId, userId, month: input.month, paymentDate: input.paymentDate,
          jimmyPaidThb: input.jimmyPaidThb, partnersPaidThb: input.partnersPaidThb, note: input.note.trim(),
          snapshotProfitThb: state.profitThb, snapshotJimmyThb: state.jimmyThb, snapshotPartnersThb: state.partnersThb,
          createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' }
        const accepted = await db.addLocalShow79Settlement(record, input, owner)
        if (!sameRequest(accepted)) throw new Error('分账提交编号已使用，请重新登记。')
        return accepted
      }
      if (tickets.some(ticket => isShow79Project(ticket.projectName) && ticket.issueDate.startsWith(`${input.month}-`) && (ticket.syncStatus !== 'synced' || ticket.refunds?.some(refund => refund.syncStatus !== 'synced')))) throw new Error('本月79秀订单尚未同步，请先同步再登记分账。')
      let data: unknown
      let error: { message: string; code?: string } | null = null
      try {
        assertCurrent(owner)
        const result = await client.rpc('record_show79_settlement', {
          p_expected_user_id: owner.userId,
          p_operation_id: input.operationId, p_month: input.month, p_payment_date: input.paymentDate,
          p_jimmy_paid_thb: input.jimmyPaidThb, p_partners_paid_thb: input.partnersPaidThb, p_note: input.note.trim(),
          p_expected_profit_thb: input.expectedProfitThb, p_expected_jimmy_paid_thb: input.expectedJimmyPaidThb, p_expected_partners_paid_thb: input.expectedPartnersPaidThb
        }).abortSignal(controller.signal)
        data = result.data; error = result.error
      } catch (failure) {
        const accepted = await receipt().catch(() => undefined)
        if (accepted) return confirm(accepted)
        throw failure
      }
      const raw = Array.isArray(data) ? data[0] : data
      const accepted = raw ? toLocalShow79Settlement(raw as CloudShow79Settlement) : await receipt()
      if (!accepted) throw Object.assign(new Error(error?.message ?? '分账尚未确认，请联网后重试；相同提交不会重复登记。'), { code: error?.code })
      return confirm(accepted)
    } finally { clearTimeout(timeout) }
  },

  async createRefund(input: RefundInput): Promise<RefundRecord> {
    const owner = (await ownerContext(true))!
    const userId = owner.userId
    const client = getSupabase()
    if (client && !navigator.onLine) throw new Error('退票需要联网确认，防止跨设备重复退票。')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const receipt = async () => {
      assertCurrent(owner)
      if (!client) return db.getRefund(input.operationId)
      const { data, error } = await client.from('ticket_refunds').select('*').eq('user_id', userId).eq('id', input.operationId).abortSignal(controller.signal)
      if (error) throw new Error(error.message)
      return data?.[0] ? toLocalRefund(data[0] as CloudRefund) : undefined
    }
    const sameRequest = (row: RefundRecord) => row.userId === userId && row.ticketId === input.ticketId && row.refundDate === input.refundDate && row.refundTime === input.refundTime && row.refundRevenueThb === input.refundRevenueThb && row.returnedCostThb === input.returnedCostThb && row.note === input.note.trim() && (input.isFull || row.personCount === input.personCount)
    try {
      const existing = await receipt()
      if (existing) {
        if (!sameRequest(existing)) throw new Error('退票提交编号已使用，请重新打开退票窗口。')
        await db.putRefund(existing, owner)
        return existing
      }
      const ticket = (await this.getTickets()).find((row) => row.id === input.ticketId)
      if (!ticket) throw new Error('当前账号无法退这条出票记录。')
      if (client && ticket.syncStatus !== 'synced') throw new Error('原票尚未同步，请先联网同步，再办理退票。')
      const quantity = validateRefundInput(ticket, input)
      const timestamp = now()
      const row: RefundRecord = { ...quantity, id: input.operationId, userId, ticketId: input.ticketId, refundRevenueThb: input.refundRevenueThb, returnedCostThb: input.returnedCostThb, refundDate: input.refundDate, refundTime: input.refundTime, note: input.note.trim(), cancelledAt: null, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' }
      if (!client) {
        const accepted = await db.addLocalRefund(row, owner)
        if (!sameRequest(accepted)) throw new Error('退票提交编号已使用，请重新打开退票窗口。')
        return accepted
      }
      assertCurrent(owner)
      const { error } = await client.from('ticket_refunds').insert(toCloudRefund(row)).abortSignal(controller.signal)
      const accepted = await receipt()
      if (!accepted || !sameRequest(accepted)) throw new Error(error?.message ?? '退票尚未确认，请联网后重试；相同提交不会重复登记。')
      await db.putRefund(accepted, owner)
      return accepted
    } finally { clearTimeout(timeout) }
  },

  async cancelRefund(id: string): Promise<void> {
    const owner = (await ownerContext(true))!
    const userId = owner.userId
    const client = getSupabase()
    if (client && !navigator.onLine) throw new Error('撤销退票需要联网确认。')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      let current = await db.getRefund(id)
      if (client) {
        const { data, error } = await client.from('ticket_refunds').select('*').eq('user_id', userId).eq('id', id).abortSignal(controller.signal)
        if (error) throw new Error(error.message)
        current = data?.[0] ? toLocalRefund(data[0] as CloudRefund) : undefined
      }
      if (!current || current.userId !== userId) throw new Error('当前账号无法撤销此退票。')
      if (current.cancelledAt) { await db.putRefund(current, owner); return }
      const timestamp = nextModifiedAt(current.updatedAt)
      const updated = { ...current, cancelledAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' as const }
      if (client) {
        assertCurrent(owner)
        const { error } = await client.from('ticket_refunds').update({ cancelled_at: timestamp, updated_at: timestamp }).eq('user_id', userId).eq('id', id).abortSignal(controller.signal)
        if (error) throw new Error(error.message)
        const { data, error: readError } = await client.from('ticket_refunds').select('*').eq('user_id', userId).eq('id', id).abortSignal(controller.signal)
        if (readError || !data?.[0]?.cancelled_at) throw new Error(readError?.message ?? '撤销尚未确认，请刷新后核对。')
        await db.putRefund(toLocalRefund(data[0] as CloudRefund), owner)
      } else await db.putRefund(updated, owner)
    } finally { clearTimeout(timeout) }
  },

  async getSuppliers() {
    const owner = await ownerContext()
    if (!owner) return []
    const suppliers = await db.getSuppliers()
    assertCurrent(owner)
    return suppliers.filter((supplier) => supplier.userId === owner.userId).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  },

  async getProjects() {
    const owner = await ownerContext()
    if (!owner) return []
    const projects = await db.getProjects()
    assertCurrent(owner)
    return projects.filter((project) => project.userId === owner.userId).map(projectDisplay).sort((a, b) => a.supplierName.localeCompare(b.supplierName, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'))
  },

  async createSupplier(name: string): Promise<Supplier> {
    const trimmedName = name.trim()
    const normalizedName = normalizeSupplier(trimmedName)
    if (!trimmedName) throw new Error('请输入供货商名称。')
    const owner = (await ownerContext(true))!
    const userId = owner.userId
    const suppliers = await db.getSuppliers()
    const existing = suppliers.find((supplier) => supplier.userId === userId && supplier.normalizedName === normalizedName)
    if (existing) throw new Error('该供货商已经在名单中。')
    const timestamp = now()
    const supplier: Supplier = {
      id: createId(),
      userId,
      name: trimmedName,
      normalizedName,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: statusForWrite()
    }
    await db.putSupplier(supplier, owner)
    return supplier
  },

  async createProject(input: ProjectInput): Promise<Project> {
    validateProjectRules(input)
    const name = cleanProjectLabel(input.name.trim())
    const subItemName = cleanProjectLabel(input.subItemName.trim())
    if (!name) throw new Error('请输入项目名称。')
    if (input.quantityUnit && !['person', 'item'].includes(input.quantityUnit)) throw new Error('请选择有效的数量单位。')
    if (input.entryMode !== 'profit_only' && (!input.manualCostPrice && (!Number.isFinite(input.defaultCostThb) || input.defaultCostThb < 0) || !input.manualAgentPrice && (!Number.isFinite(input.defaultAgentPriceThb) || input.defaultAgentPriceThb < 0))) {
      throw new Error('成本和代理售价必须是大于或等于 0 的金额。')
    }
    if (input.entryMode !== 'profit_only') validateAmountPrecision([...(input.manualCostPrice ? [] : [input.defaultCostThb]), ...(input.manualAgentPrice ? [] : [input.defaultAgentPriceThb])])
    const owner = (await ownerContext(true))!
    const userId = owner.userId
    const suppliers = await db.getSuppliers()
    const supplier = suppliers.find((item) => item.id === input.supplierId && item.userId === userId)
    if (!supplier && !input.manualSupplier) throw new Error('请先选择已录入的供货商。')
    const normalizedName = normalizeSupplier(name)
    const normalizedSubItemName = normalizeSupplier(subItemName)
    const projects = await db.getProjects()
    const supplierId = input.manualSupplier ? '' : supplier!.id
    if (projects.some((project) => project.supplierId === supplierId && normalizeSupplier(cleanProjectLabel(project.name)) === normalizedName && normalizeSupplier(cleanProjectLabel(project.subItemName)) === normalizedSubItemName && project.userId === userId)) {
      throw new Error('该供货商的这个项目子项已存在。')
    }
    const timestamp = now()
    const project: Project = {
      ...resolveProjectRules({ ...input, name, subItemName }),
      quantityUnit: input.quantityUnit ?? 'person',
      manualAgentPrice: input.entryMode !== 'profit_only' && Boolean(input.manualAgentPrice),
      manualCostPrice: input.entryMode !== 'profit_only' && Boolean(input.manualCostPrice),
      manualSupplier: Boolean(input.manualSupplier),
      entryMode: input.entryMode ?? 'standard',
      id: createId(),
      userId,
      supplierId,
      supplierName: input.manualSupplier ? '' : supplier!.name,
      name,
      normalizedName,
      subItemName,
      normalizedSubItemName,
      defaultCostThb: input.entryMode === 'profit_only' || input.manualCostPrice ? 0 : input.defaultCostThb,
      defaultAgentPriceThb: input.entryMode === 'profit_only' || input.manualAgentPrice ? 0 : input.defaultAgentPriceThb,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: statusForWrite()
    }
    await db.putProject(project, owner)
    return project
  },

  async updateProjectPrices(id: string, input: ProjectPricesInput): Promise<Project> {
    validateProjectRules(input)
    const owner = (await ownerContext(true))!
    const userId = owner.userId
    const current = (await db.getProjects()).find((project) => project.id === id && project.userId === userId)
    if (!current) throw new Error('当前账号无法修改这个项目价格。')
    if (input.quantityUnit && !['person', 'item'].includes(input.quantityUnit)) throw new Error('请选择有效的数量单位。')
    const manualAgentPrice = input.manualAgentPrice ?? current.manualAgentPrice ?? false
    const manualCostPrice = input.manualCostPrice ?? current.manualCostPrice ?? false
    if (current.entryMode !== 'profit_only' && (!manualCostPrice && (!Number.isFinite(input.defaultCostThb) || input.defaultCostThb < 0) || !manualAgentPrice && (!Number.isFinite(input.defaultAgentPriceThb) || input.defaultAgentPriceThb < 0))) {
      throw new Error('成本和代理售价必须是大于或等于 0 的金额。')
    }
    if (current.entryMode !== 'profit_only') validateAmountPrecision([...(manualCostPrice ? [] : [input.defaultCostThb]), ...(manualAgentPrice ? [] : [input.defaultAgentPriceThb])])
    const updated: Project = {
      ...projectDisplay(current),
      ...resolveProjectRules({ ...current, quantityUnit: input.quantityUnit ?? current.quantityUnit, defaultAmountBasis: input.defaultAmountBasis ?? current.defaultAmountBasis, settlementMode: input.settlementMode ?? current.settlementMode }),
      quantityUnit: current.entryMode === 'profit_only' ? current.quantityUnit ?? 'person' : input.quantityUnit ?? current.quantityUnit ?? 'person',
      defaultCostThb: current.entryMode === 'profit_only' || manualCostPrice ? 0 : input.defaultCostThb,
      defaultAgentPriceThb: current.entryMode === 'profit_only' || manualAgentPrice ? 0 : input.defaultAgentPriceThb,
      manualAgentPrice: current.entryMode !== 'profit_only' && manualAgentPrice,
      manualCostPrice: current.entryMode !== 'profit_only' && manualCostPrice,
      updatedAt: nextModifiedAt(current.updatedAt),
      syncStatus: statusForWrite()
    }
    await db.putProject(updated, owner)
    return updated
  },

  async createOrUpdateShow69Record(input: Show69RecordInput, existing?: TicketRecord, operationId?: string): Promise<TicketRecord> {
    const owner = (await ownerContext(true))!
    validateShow69Record(input)
    if (existing) {
      const current = await db.getTicket(existing.id)
      assertCurrent(owner)
      if (existing.userId !== owner.userId || !current || current.userId !== owner.userId || current.deletedAt || !isShow69Project(current.projectName)) throw new Error('当前账号无法编辑这条69秀记录，请重新打开记录。')
      const refunds = await db.getRefunds()
      assertCurrent(owner)
      if (refunds.some(row => row.ticketId === current.id && row.userId === owner.userId)) throw new Error('已有退票明细的原票不可编辑，请保留完整记录。')
      // Historical records retain their original catalogue and financial
      // snapshots even when those catalogue entries have since changed.
      const updated: TicketRecord = { ...current, issueDate: input.date, guestName: input.guestName.trim(), personCount: input.people, updatedAt: nextModifiedAt(current.updatedAt), syncStatus: statusForWrite() }
      await db.putTicket(updated, owner)
      return ticketWithCurrentRefunds(updated, owner)
    }

    // The user submits three fields only. Internal time/catalogue defaults must
    // not make a retry look like a different submission after a minute or sync.
    const fingerprint = JSON.stringify({ kind: 'show69_record', date: input.date, guestName: input.guestName.trim(), people: input.people })
    const id = operationId ?? createId()
    const accepted = await db.getTicketCreateOperation(id, owner)
    assertCurrent(owner)
    if (accepted) {
      if (accepted.receipt.fingerprint !== fingerprint) throw new Error('这次提交已经保存过不同内容，请重新打开新增记录。')
      return ticketWithCurrentRefunds(accepted.ticket, owner)
    }
    const { supplier, project } = await prepareShow69Catalogue(owner)
    assertCurrent(owner)
    const timestamp = nextModifiedAt(supplier.updatedAt, project.updatedAt)
    const ticket: TicketRecord = {
      id, userId: owner.userId, guestName: input.guestName.trim(), issueDate: input.date, issueTime: getBangkokTime(), personCount: input.people,
      supplierId: supplier.id, supplierName: supplier.name, projectId: project.id, projectName: '69秀', subItemName: '独立记录',
      quantityUnit: 'person', entryMode: 'standard', amountBasis: 'per_person', settlementMode: 'monthly',
      agentPriceThb: 0, costThb: 0, manualProfitThb: null, note: '',
      createdAt: timestamp, updatedAt: timestamp, deletedAt: null, syncStatus: statusForWrite()
    }
    return ticketWithCurrentRefunds(await db.putNewTicketOnce(ticket, fingerprint, owner), owner)
  },

  async createOrUpdateTicket(input: TicketInput, existing?: TicketRecord, operationId?: string): Promise<TicketRecord> {
    const owner = (await ownerContext(true))!
    const fingerprint = !existing && operationId ? ticketCreateFingerprint(input) : undefined
    if (fingerprint && operationId) {
      const accepted = await db.getTicketCreateOperation(operationId, owner)
      if (accepted) {
        if (accepted.receipt.fingerprint !== fingerprint) throw new Error('这次提交已经保存过不同内容，请重新打开新增记录。')
        assertCurrent(owner)
        return ticketWithCurrentRefunds(accepted.ticket, owner)
      }
    }
    if (!isValidCalendarDate(input.issueDate)) throw new Error('请填写有效的日期。')
    if ((input.guestName ?? '').trim().length > 100) throw new Error('客户姓名最多100个字符。')
    validateProjectRules({ settlementMode: input.settlementMode })
    if ((!existing && !input.issueTime) || (input.issueTime && !isValidIssueTime(input.issueTime))) throw new Error('请填写有效的曼谷时间（HH:mm）。')
    if (input.personCount == null ? !existing || existing.personCount != null : !isValidPersonCount(input.personCount)) {
      throw new Error(`${quantityLabels(input).label}必须是大于或等于1的整数。`)
    }
    const userId = owner.userId
    const normalizedName = normalizeSupplier(input.supplierName)
    const suppliers = await db.getSuppliers()
    const supplier = suppliers.find((item) => item.userId === userId && item.normalizedName === normalizedName)
    const projects = await db.getProjects()
    const selectedProject = projects.find(item => item.id === input.projectId && item.userId === userId)
    if (selectedProject?.manualSupplier && !supplier) throw new Error('请选择当前账号已录入的供货商。')
    const currentTicket = existing ? await db.getTicket(existing.id) : undefined
    if (existing && (currentTicket ?? existing).userId !== userId) throw new Error('当前账号无法编辑这条记录，请重新打开记录。')
    if (existing && (await db.getRefunds()).some((row) => row.ticketId === existing.id && row.userId === userId)) throw new Error('已有退票明细的原票不可编辑，请保留完整记录。')
    const changedAt = nextModifiedAt(existing?.updatedAt, currentTicket?.updatedAt, supplier?.updatedAt)
    const nextSupplier: Supplier = supplier ?? {
      id: createId(),
      userId,
      name: input.supplierName.trim(),
      normalizedName,
      createdAt: changedAt,
      updatedAt: changedAt,
      syncStatus: statusForWrite()
    }

    if (supplier && supplier.name !== input.supplierName.trim()) {
      await db.putSupplier({ ...supplier, name: input.supplierName.trim(), updatedAt: changedAt, syncStatus: statusForWrite() }, owner)
    } else if (!supplier) {
      await db.putSupplier(nextSupplier, owner)
    }
    const project = selectedProject && (selectedProject.manualSupplier || selectedProject.supplierId === nextSupplier.id) ? selectedProject : undefined
    if (!project || cleanProjectLabel(project.name) !== cleanProjectLabel(input.projectName) || cleanProjectLabel(project.subItemName) !== cleanProjectLabel(input.subItemName)) throw new Error('请选择该供货商已录入的项目子项。')
    const amountBasis = input.amountBasis ?? (existing?.projectId === project.id ? existing.amountBasis ?? 'total' : resolveProjectRules(project).defaultAmountBasis)
    if (!['total', 'per_person'].includes(amountBasis)) throw new Error('请选择有效的计价方式。')
    if (amountBasis === 'per_person' && (input.personCount == null || !isValidPersonCount(input.personCount))) throw new Error(`按${quantityLabels(input).label}计算时，${quantityLabels(input).label}必须是大于或等于1的整数。`)
    const entryMode = existing?.projectId === project.id ? existing.entryMode ?? 'standard' : project.entryMode ?? 'standard'
    if (entryMode === 'profit_only') {
      if (typeof input.manualProfitThb !== 'number' || !Number.isFinite(input.manualProfitThb) || input.manualProfitThb < 0) throw new Error('请填写大于或等于0的利润金额。')
    } else if (!Number.isFinite(input.agentPriceThb) || !Number.isFinite(input.costThb) || input.agentPriceThb < 0 || input.costThb < 0) {
      throw new Error('成本和代理售价必须是大于或等于0的金额。')
    }

    const ticket: TicketRecord = {
      guestName: input.guestName?.trim() ?? currentTicket?.guestName ?? existing?.guestName ?? '',
      settlementMode: existing?.projectId === project.id ? (currentTicket ?? existing).settlementMode : entryMode === 'profit_only' ? 'monthly' : input.settlementMode ?? resolveProjectRules(project).settlementMode,
      quantityUnit: existing?.projectId === project.id ? existing.quantityUnit ?? 'person' : project.quantityUnit ?? 'person',
      amountBasis,
      personCount: input.personCount ?? null,
      entryMode,
      issueTime: input.issueTime || null,
      manualProfitThb: entryMode === 'profit_only' ? input.manualProfitThb : null,
      id: existing?.id ?? operationId ?? createId(),
      userId,
      issueDate: input.issueDate,
      supplierId: nextSupplier.id,
      supplierName: nextSupplier.name,
      projectId: input.projectId,
      projectName: cleanProjectLabel(input.projectName),
      subItemName: cleanProjectLabel(input.subItemName),
      agentPriceThb: entryMode === 'profit_only' ? 0 : input.agentPriceThb,
      costThb: entryMode === 'profit_only' ? 0 : input.costThb,
      note: input.note.trim(),
      createdAt: existing?.createdAt ?? changedAt,
      updatedAt: changedAt,
      deletedAt: null,
      syncStatus: statusForWrite()
    }
    validateAmountPrecision(entryMode === 'profit_only' ? [ticket.manualProfitThb!] : [ticket.agentPriceThb, ticket.costThb])
    const totals = getTicketAmounts(ticket)
    validateAmountPrecision([totals.agentPriceThb, totals.costThb, Math.abs(totals.profitThb)])
    if (fingerprint) return ticketWithCurrentRefunds(await db.putNewTicketOnce(ticket, fingerprint, owner), owner)
    await db.putTicket(ticket, owner)
    return ticketWithCurrentRefunds(ticket, owner)
  },

  async createMedicineTickets(entries: MedicineTicketEntry[]): Promise<TicketRecord[]> {
    const owner = (await ownerContext(true))!
    validateMedicineBatchShape(entries)
    const fingerprints = entries.map(entry => ticketCreateFingerprint(entry.input))
    const receipts = await Promise.all(entries.map(entry => db.getTicketCreateOperation(entry.operationId, owner)))
    assertCurrent(owner)
    for (let index = 0; index < entries.length; index++) if (receipts[index] && receipts[index]!.receipt.fingerprint !== fingerprints[index]) throw new Error('这批药品中有提交编号已保存过不同内容，请重新打开新增记录。')
    if (receipts.every(Boolean)) return ticketsWithCurrentRefunds(receipts.map(receipt => receipt!.ticket), owner)

    const [projects, suppliers] = await Promise.all([db.getProjects(), db.getSuppliers()])
    assertCurrent(owner)
    const prepared = entries.map((entry, index) => {
      const accepted = receipts[index]
      if (accepted) return { ticket: accepted.ticket, fingerprint: fingerprints[index] }
      const project = projects.find(row => row.id === entry.input.projectId && row.userId === owner.userId)
      const supplier = project && suppliers.find(row => row.id === project.supplierId && row.userId === owner.userId)
      if (!project || !supplier) throw new Error('请选择当前账号已录入的药品商品套餐。')
      return { ticket: stageMedicineTicket(entry, project, supplier, owner), fingerprint: fingerprints[index], projectUpdatedAt: project.updatedAt, supplierUpdatedAt: supplier.updatedAt }
    })
    return ticketsWithCurrentRefunds(await db.putMedicineTicketsOnce(prepared, owner), owner)
  },

  async deleteTicket(ticket: TicketRecord): Promise<TicketRecord> {
    const owner = (await ownerContext(true))!
    const currentTicket = await db.getTicket(ticket.id)
    if ((currentTicket ?? ticket).userId !== owner.userId) throw new Error('当前账号无法删除这条记录。')
    if ((await db.getRefunds()).some((row) => row.ticketId === ticket.id && row.userId === ticket.userId)) throw new Error('已有退票明细的原票不可删除，请保留完整记录。')
    const deletedAt = nextModifiedAt(ticket.updatedAt, currentTicket?.updatedAt)
    const deleted = {
      ...(currentTicket ?? ticket),
      deletedAt,
      updatedAt: deletedAt,
      syncStatus: statusForWrite()
    }
    await db.putTicket(deleted, owner)
    return deleted
  },

  async synchronise(user: User, externalSignal?: AbortSignal): Promise<SyncResult> {
    const client = getSupabase()
    if (!client) return { synced: false, message: '尚未配置云端同步' }
    const owner = await ownerContext()
    if (!owner || owner.userId !== user.id) return { synced: false, message: '账号正在切换，请重新打开当前账号账本。' }
    if (!navigator.onLine) return { synced: false, message: '当前离线，记录会保存在本机并在联网后同步' }

    const controller = new AbortController()
    const abort = () => controller.abort()
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 30000)
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted) controller.abort()
    try {
      controller.signal.throwIfAborted()
      assertCurrent(owner)
      const common = { client, userId: user.id, signal: controller.signal, owner }
      // Read refund locks before uploading any original ticket. A disconnected
      // device may otherwise keep attempting an edit that the server forbids.
      const [remoteRefunds, remoteTickets] = await Promise.all([
        fetchCloudRows<CloudRefund>(client, 'ticket_refunds', user.id, controller.signal, owner),
        fetchCloudRows<CloudTicket>(client, 'tickets', user.id, controller.signal, owner)
      ])
      await db.mergeRemoteRefunds(remoteRefunds.map(toLocalRefund), owner)
      const lockedTicketIds = new Set(remoteRefunds.map(refund => refund.ticket_id))
      await db.mergeRemoteTickets(remoteTickets.map(toLocalTicket), owner, lockedTicketIds)
      for (let attempt = 0; ; attempt++) {
        const suppliers = (await fetchCloudRows<CloudSupplier>(client, 'suppliers', user.id, controller.signal, owner)).map(toLocalSupplier)
        const projects = (await fetchCloudRows<CloudProject>(client, 'projects', user.id, controller.signal, owner)).map(toLocalProject)
        controller.signal.throwIfAborted()
        assertCurrent(owner)
        await db.reconcileCatalogue(user.id, suppliers, projects, owner)
        try {
          await synchroniseTable({ ...common, table: 'suppliers', getLocal: () => db.getSuppliers(), mergeRemote: db.mergeRemoteSuppliers, toLocal: toLocalSupplier, toCloud: toCloudSupplier })
          await synchroniseTable({ ...common, table: 'projects', getLocal: () => db.getProjects(), mergeRemote: db.mergeRemoteProjects, toLocal: toLocalProject, toCloud: toCloudProject })
          break
        } catch (error) {
          // Another device may create the same catalogue entry after our pull.
          // Re-read canonical IDs once, rather than retrying conflicting UUIDs.
          if (attempt || (error as { code?: string }).code !== '23505') throw error
        }
      }
      await synchroniseTable({ ...common, table: 'tickets', getLocal: () => db.getTickets(), mergeRemote: db.mergeRemoteTickets, toLocal: toLocalTicket, toCloud: toCloudTicket, initialRemote: remoteTickets.map(toLocalTicket), lockedTicketIds })
      await synchroniseTable({ ...common, table: 'ticket_refunds', getLocal: () => db.getRefunds(), mergeRemote: db.mergeRemoteRefunds, toLocal: toLocalRefund, toCloud: toCloudRefund })
      await db.mergeRemoteShow79Settlements((await fetchCloudRows<CloudShow79Settlement>(client, 'show79_settlements', user.id, controller.signal, owner)).map(toLocalShow79Settlement), owner)
      return { synced: true }
    } catch (error) {
      if (externalSignal?.aborted) throw error
      return { synced: false, message: timedOut ? '同步超时，本机记录已保留，联网后会自动重试。' : error instanceof Error ? error.message : '同步暂未完成，会自动重试。' }
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abort)
    }
  },

  async markSyncError(message: string) {
    // Pending versions are retained unchanged for the next retry.
    return message
  },

  localUserIdKey: LOCAL_USER_ID_KEY
}
