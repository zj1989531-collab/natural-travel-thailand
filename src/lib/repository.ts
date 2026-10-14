import type { SupabaseClient, User } from '@supabase/supabase-js'
import { db } from './db'
import { createId, isValidIssueTime, isValidPersonCount, normalizeSupplier } from './format'
import { getSupabase } from './supabase'
import { needsUpload, nextModifiedAt, type VersionedRecord } from './sync'
import type { AmountBasis, AppSettings, EntryMode, Project, ProjectInput, ProjectPricesInput, QuantityUnit, RefundInput, RefundRecord, Supplier, SyncStatus, TicketInput, TicketRecord } from '../types'
import { getTicketAmounts, validateAmountPrecision } from './ticket-amounts'
import { attachRefunds } from './refunds'
import { validateRefundInput } from './refund-input'

const LOCAL_USER_ID_KEY = 'localUserId'

type CloudSupplier = {
  id: string
  user_id: string
  name: string
  normalized_name: string
  created_at: string
  updated_at: string
}

type CloudTicket = {
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
  manual_agent_price?: boolean
  quantity_unit?: QuantityUnit
  entry_mode?: EntryMode
  id: string
  user_id: string
  supplier_id: string
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
  manualAgentPrice: project.manual_agent_price ?? false,
  quantityUnit: project.quantity_unit ?? 'person',
  entryMode: project.entry_mode ?? 'standard',
  id: project.id,
  userId: project.user_id,
  supplierId: project.supplier_id,
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
  manual_agent_price: project.manualAgentPrice ?? false,
  quantity_unit: project.quantityUnit ?? 'person',
  entry_mode: project.entryMode ?? 'standard',
  id: project.id,
  user_id: project.userId,
  supplier_id: project.supplierId,
  supplier_name: project.supplierName,
  name: project.name,
  normalized_name: project.normalizedName,
  sub_item_name: project.subItemName,
  normalized_sub_item_name: project.normalizedSubItemName,
  default_cost_thb: project.defaultCostThb,
  default_agent_price_thb: project.defaultAgentPriceThb,
  created_at: project.createdAt,
  updated_at: project.updatedAt
})

const toLocalTicket = (ticket: CloudTicket): TicketRecord => ({
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
  const existing = await db.getSettings()
  if (existing) return existing
  const settings = { localUserId: createId(), lastCloudUserId: null }
  await db.putSettings(settings)
  return settings
}

type CloudTable = 'suppliers' | 'projects' | 'tickets' | 'ticket_refunds'

async function fetchCloudRows<T>(client: SupabaseClient, table: CloudTable, userId: string, signal: AbortSignal): Promise<T[]> {
  const rows: T[] = []
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from(table).select('*').eq('user_id', userId)
      .order('id').range(offset, offset + pageSize - 1).abortSignal(signal)
    if (error) throw new Error(error.message)
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
  getLocal: () => Promise<Local[]>
  mergeRemote: (records: Local[]) => Promise<void>
  toLocal: (record: Cloud) => Local
  toCloud: (record: Local) => object
}) {
  const { client, table, userId, signal, getLocal, mergeRemote, toLocal, toCloud } = options
  const remote = (await fetchCloudRows<Cloud>(client, table, userId, signal)).map(toLocal)
  await mergeRemote(remote)
  const remoteMap = new Map(remote.map((record) => [record.id, record]))
  const pending = (await getLocal()).filter((record) => record.userId === userId && needsUpload(record, remoteMap.get(record.id)))
  // Equal versions are acknowledged locally without another database UPDATE.
  // This prevents our own realtime notifications from starting an upload loop.
  if (!pending.length) return

  for (let offset = 0; offset < pending.length; offset += 100) {
    const { error } = await client.from(table).upsert(pending.slice(offset, offset + 100).map(toCloud), { onConflict: 'id' }).abortSignal(signal)
    if (error) throw new Error(error.message)
  }
  // A newer write may have reached PostgreSQL after our first pull. The server
  // rejects stale updates; read its actual result instead of acknowledging the
  // originally submitted snapshot. Atomic local merging preserves edits made
  // while this request was in flight.
  await mergeRemote((await fetchCloudRows<Cloud>(client, table, userId, signal)).map(toLocal))
}

async function activeUserId() {
  const settings = await getSettings()
  return settings.lastCloudUserId ?? settings.localUserId
}

export const ledgerRepository = {
  async getSettings() {
    return getSettings()
  },

  async getTickets() {
    const userId = await activeUserId()
    return attachRefunds((await db.getTickets()).filter((ticket) => ticket.userId === userId), (await db.getRefunds()).filter((row) => row.userId === userId))
  },

  async getRefunds() {
    const userId = await activeUserId()
    return (await db.getRefunds()).filter((row) => row.userId === userId)
  },

  async createRefund(input: RefundInput): Promise<RefundRecord> {
    const userId = await activeUserId()
    const client = getSupabase()
    if (client && !navigator.onLine) throw new Error('退票需要联网确认，防止跨设备重复退票。')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const receipt = async () => {
      if (!client) return db.getRefund(input.operationId)
      const { data, error } = await client.from('ticket_refunds').select('*').eq('user_id', userId).eq('id', input.operationId).abortSignal(controller.signal)
      if (error) throw new Error(error.message)
      return data?.[0] ? toLocalRefund(data[0] as CloudRefund) : undefined
    }
    const sameRequest = (row: RefundRecord) => row.userId === userId && row.ticketId === input.ticketId && row.refundDate === input.refundDate && row.refundTime === input.refundTime && row.refundRevenueThb === input.refundRevenueThb && row.returnedCostThb === input.returnedCostThb && row.note === input.note.trim() && (input.isFull || row.personCount === input.personCount)
    try {
      const existing = await receipt()
      if (existing) {
        if (!sameRequest(existing) || existing.cancelledAt) throw new Error('退票提交编号已使用，请重新打开退票窗口。')
        await db.putRefund(existing)
        return existing
      }
      const ticket = (await this.getTickets()).find((row) => row.id === input.ticketId)
      if (!ticket) throw new Error('当前账号无法退这条出票记录。')
      if (client && ticket.syncStatus !== 'synced') throw new Error('原票尚未同步，请先联网同步，再办理退票。')
      const quantity = validateRefundInput(ticket, input)
      const timestamp = now()
      const row: RefundRecord = { ...quantity, id: input.operationId, userId, ticketId: input.ticketId, refundRevenueThb: input.refundRevenueThb, returnedCostThb: input.returnedCostThb, refundDate: input.refundDate, refundTime: input.refundTime, note: input.note.trim(), cancelledAt: null, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' }
      if (!client) {
        const accepted = await db.addLocalRefund(row)
        if (!sameRequest(accepted)) throw new Error('退票提交编号已使用，请重新打开退票窗口。')
        return accepted
      }
      const { error } = await client.from('ticket_refunds').insert(toCloudRefund(row)).abortSignal(controller.signal)
      const accepted = await receipt()
      if (!accepted || !sameRequest(accepted)) throw new Error(error?.message ?? '退票尚未确认，请联网后重试；相同提交不会重复登记。')
      await db.putRefund(accepted)
      return accepted
    } finally { clearTimeout(timeout) }
  },

  async cancelRefund(id: string): Promise<void> {
    const userId = await activeUserId()
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
      if (current.cancelledAt) { await db.putRefund(current); return }
      const timestamp = nextModifiedAt(current.updatedAt)
      const updated = { ...current, cancelledAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' as const }
      if (client) {
        const { error } = await client.from('ticket_refunds').update({ cancelled_at: timestamp, updated_at: timestamp }).eq('user_id', userId).eq('id', id).abortSignal(controller.signal)
        if (error) throw new Error(error.message)
        const { data, error: readError } = await client.from('ticket_refunds').select('*').eq('user_id', userId).eq('id', id).abortSignal(controller.signal)
        if (readError || !data?.[0]?.cancelled_at) throw new Error(readError?.message ?? '撤销尚未确认，请刷新后核对。')
        await db.putRefund(toLocalRefund(data[0] as CloudRefund))
      } else await db.putRefund(updated)
    } finally { clearTimeout(timeout) }
  },

  async getSuppliers() {
    const suppliers = await db.getSuppliers()
    const userId = await activeUserId()
    return suppliers.filter((supplier) => supplier.userId === userId).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  },

  async getProjects() {
    const projects = await db.getProjects()
    const userId = await activeUserId()
    return projects.filter((project) => project.userId === userId).sort((a, b) => a.supplierName.localeCompare(b.supplierName, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'))
  },

  async createSupplier(name: string): Promise<Supplier> {
    const trimmedName = name.trim()
    const normalizedName = normalizeSupplier(trimmedName)
    if (!trimmedName) throw new Error('请输入供货商名称。')
    const settings = await getSettings()
    const userId = settings.lastCloudUserId ?? settings.localUserId
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
    await db.putSupplier(supplier)
    return supplier
  },

  async createProject(input: ProjectInput): Promise<Project> {
    const name = input.name.trim()
    const subItemName = input.subItemName.trim()
    if (!name) throw new Error('请输入项目名称。')
    if (input.quantityUnit && !['person', 'item'].includes(input.quantityUnit)) throw new Error('请选择有效的数量单位。')
    if (input.entryMode !== 'profit_only' && (!Number.isFinite(input.defaultCostThb) || input.defaultCostThb < 0 || !input.manualAgentPrice && (!Number.isFinite(input.defaultAgentPriceThb) || input.defaultAgentPriceThb < 0))) {
      throw new Error('成本和代理售价必须是大于或等于 0 的金额。')
    }
    const settings = await getSettings()
    const userId = settings.lastCloudUserId ?? settings.localUserId
    const suppliers = await db.getSuppliers()
    const supplier = suppliers.find((item) => item.id === input.supplierId && item.userId === userId)
    if (!supplier) throw new Error('请先选择已录入的供货商。')
    const normalizedName = normalizeSupplier(name)
    const normalizedSubItemName = normalizeSupplier(subItemName)
    const projects = await db.getProjects()
    if (projects.some((project) => project.supplierId === supplier.id && project.normalizedName === normalizedName && project.normalizedSubItemName === normalizedSubItemName && project.userId === userId)) {
      throw new Error('该供货商的这个项目子项已存在。')
    }
    const timestamp = now()
    const project: Project = {
      quantityUnit: input.quantityUnit ?? 'person',
      manualAgentPrice: input.entryMode !== 'profit_only' && Boolean(input.manualAgentPrice),
      entryMode: input.entryMode ?? 'standard',
      id: createId(),
      userId,
      supplierId: supplier.id,
      supplierName: supplier.name,
      name,
      normalizedName,
      subItemName,
      normalizedSubItemName,
      defaultCostThb: input.entryMode === 'profit_only' ? 0 : input.defaultCostThb,
      defaultAgentPriceThb: input.entryMode === 'profit_only' || input.manualAgentPrice ? 0 : input.defaultAgentPriceThb,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: statusForWrite()
    }
    await db.putProject(project)
    return project
  },

  async updateProjectPrices(id: string, input: ProjectPricesInput): Promise<Project> {
    if (!Number.isFinite(input.defaultCostThb) || input.defaultCostThb < 0 || !input.manualAgentPrice && (!Number.isFinite(input.defaultAgentPriceThb) || input.defaultAgentPriceThb < 0)) {
      throw new Error('成本和代理售价必须是大于或等于 0 的金额。')
    }
    const userId = await activeUserId()
    const current = (await db.getProjects()).find((project) => project.id === id && project.userId === userId)
    if (!current) throw new Error('当前账号无法修改这个项目价格。')
    if (current.entryMode === 'profit_only') throw new Error('仅录利润项目没有默认售价和成本，请在记录中填写利润。')
    const updated: Project = {
      ...current,
      defaultCostThb: input.defaultCostThb,
      defaultAgentPriceThb: input.manualAgentPrice ? 0 : input.defaultAgentPriceThb,
      manualAgentPrice: input.manualAgentPrice ?? current.manualAgentPrice ?? false,
      updatedAt: nextModifiedAt(current.updatedAt),
      syncStatus: statusForWrite()
    }
    await db.putProject(updated)
    return updated
  },

  async createOrUpdateTicket(input: TicketInput, existing?: TicketRecord): Promise<TicketRecord> {
    if ((!existing && !input.issueTime) || (input.issueTime && !isValidIssueTime(input.issueTime))) throw new Error('请填写有效的曼谷时间（HH:mm）。')
    const amountBasis = input.amountBasis ?? (existing ? existing.amountBasis ?? 'total' : 'per_person')
    if (!['total', 'per_person'].includes(amountBasis)) throw new Error('请选择有效的计价方式。')
    if (amountBasis === 'per_person' && (input.personCount == null || !isValidPersonCount(input.personCount))) throw new Error('按人数计算时，人数必须是大于或等于1的整数。')
    if (input.personCount == null ? !existing || existing.personCount != null : !isValidPersonCount(input.personCount)) {
      throw new Error('人数必须是大于或等于1的整数。')
    }
    const settings = await getSettings()
    const userId = settings.lastCloudUserId ?? settings.localUserId
    const normalizedName = normalizeSupplier(input.supplierName)
    const suppliers = await db.getSuppliers()
    const supplier = suppliers.find((item) => item.userId === userId && item.normalizedName === normalizedName)
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
      await db.putSupplier({ ...supplier, name: input.supplierName.trim(), updatedAt: changedAt, syncStatus: statusForWrite() })
    } else if (!supplier) {
      await db.putSupplier(nextSupplier)
    }
    const projects = await db.getProjects()
    const project = projects.find((item) => item.id === input.projectId && item.supplierId === nextSupplier.id && item.userId === userId)
    if (!project || project.name !== input.projectName || project.subItemName !== input.subItemName) throw new Error('请选择该供货商已录入的项目子项。')
    const entryMode = project.entryMode ?? 'standard'
    if (entryMode === 'profit_only') {
      if (typeof input.manualProfitThb !== 'number' || !Number.isFinite(input.manualProfitThb) || input.manualProfitThb < 0) throw new Error('请填写大于或等于0的利润金额。')
    } else if (!Number.isFinite(input.agentPriceThb) || !Number.isFinite(input.costThb) || input.agentPriceThb < 0 || input.costThb < 0) {
      throw new Error('成本和代理售价必须是大于或等于0的金额。')
    }

    const ticket: TicketRecord = {
      quantityUnit: project.quantityUnit ?? 'person',
      amountBasis,
      personCount: input.personCount ?? null,
      entryMode,
      issueTime: input.issueTime || null,
      manualProfitThb: entryMode === 'profit_only' ? input.manualProfitThb : null,
      id: existing?.id ?? createId(),
      userId,
      issueDate: input.issueDate,
      supplierId: nextSupplier.id,
      supplierName: nextSupplier.name,
      projectId: input.projectId,
      projectName: input.projectName,
      subItemName: input.subItemName,
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
    await db.putTicket(ticket)
    return ticket
  },

  async deleteTicket(ticket: TicketRecord): Promise<TicketRecord> {
    const currentTicket = await db.getTicket(ticket.id)
    if ((currentTicket ?? ticket).userId !== await activeUserId()) throw new Error('当前账号无法删除这条记录。')
    if ((await db.getRefunds()).some((row) => row.ticketId === ticket.id && row.userId === ticket.userId)) throw new Error('已有退票明细的原票不可删除，请保留完整记录。')
    const deletedAt = nextModifiedAt(ticket.updatedAt, currentTicket?.updatedAt)
    const deleted = {
      ...(currentTicket ?? ticket),
      deletedAt,
      updatedAt: deletedAt,
      syncStatus: statusForWrite()
    }
    await db.putTicket(deleted)
    return deleted
  },

  async synchronise(user: User, externalSignal?: AbortSignal): Promise<SyncResult> {
    const client = getSupabase()
    if (!client) return { synced: false, message: '尚未配置云端同步' }
    if (!navigator.onLine) return { synced: false, message: '当前离线，记录会保存在本机并在联网后同步' }

    const controller = new AbortController()
    const abort = () => controller.abort()
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 30000)
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted) controller.abort()
    try {
      controller.signal.throwIfAborted()
      const settings = await getSettings()
      if (settings.lastCloudUserId !== user.id) {
        // Only anonymous records are adopted; another logged-in account's
        // cached data stays owned by that account and is never reassigned.
        await db.adoptLocalRecords(settings.localUserId, user.id, now(), settings)
      }
      const common = { client, userId: user.id, signal: controller.signal }
      await synchroniseTable({ ...common, table: 'suppliers', getLocal: () => db.getSuppliers(), mergeRemote: db.mergeRemoteSuppliers, toLocal: toLocalSupplier, toCloud: toCloudSupplier })
      await synchroniseTable({ ...common, table: 'projects', getLocal: () => db.getProjects(), mergeRemote: db.mergeRemoteProjects, toLocal: toLocalProject, toCloud: toCloudProject })
      await synchroniseTable({ ...common, table: 'tickets', getLocal: () => db.getTickets(), mergeRemote: db.mergeRemoteTickets, toLocal: toLocalTicket, toCloud: toCloudTicket })
      await synchroniseTable({ ...common, table: 'ticket_refunds', getLocal: () => db.getRefunds(), mergeRemote: db.mergeRemoteRefunds, toLocal: toLocalRefund, toCloud: toCloudRefund })
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
