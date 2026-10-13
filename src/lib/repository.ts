import type { SupabaseClient, User } from '@supabase/supabase-js'
import { db } from './db'
import { createId, normalizeSupplier } from './format'
import { getSupabase } from './supabase'
import { needsUpload, nextModifiedAt, type VersionedRecord } from './sync'
import type { AppSettings, Project, Supplier, SyncStatus, TicketInput, TicketRecord } from '../types'

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

type CloudTable = 'suppliers' | 'projects' | 'tickets'

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
    return (await db.getTickets()).filter((ticket) => ticket.userId === userId)
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

  async createProject(input: { supplierId: string; name: string; subItemName: string; defaultCostThb: number; defaultAgentPriceThb: number }): Promise<Project> {
    const name = input.name.trim()
    const subItemName = input.subItemName.trim()
    if (!name) throw new Error('请输入项目名称。')
    if (!Number.isFinite(input.defaultCostThb) || !Number.isFinite(input.defaultAgentPriceThb) || input.defaultCostThb < 0 || input.defaultAgentPriceThb < 0) {
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
      id: createId(),
      userId,
      supplierId: supplier.id,
      supplierName: supplier.name,
      name,
      normalizedName,
      subItemName,
      normalizedSubItemName,
      defaultCostThb: input.defaultCostThb,
      defaultAgentPriceThb: input.defaultAgentPriceThb,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: statusForWrite()
    }
    await db.putProject(project)
    return project
  },

  async updateProjectPrices(id: string, input: { defaultCostThb: number; defaultAgentPriceThb: number }): Promise<Project> {
    if (!Number.isFinite(input.defaultCostThb) || !Number.isFinite(input.defaultAgentPriceThb) || input.defaultCostThb < 0 || input.defaultAgentPriceThb < 0) {
      throw new Error('成本和代理售价必须是大于或等于 0 的金额。')
    }
    const userId = await activeUserId()
    const current = (await db.getProjects()).find((project) => project.id === id && project.userId === userId)
    if (!current) throw new Error('当前账号无法修改这个项目价格。')
    const updated: Project = {
      ...current,
      defaultCostThb: input.defaultCostThb,
      defaultAgentPriceThb: input.defaultAgentPriceThb,
      updatedAt: nextModifiedAt(current.updatedAt),
      syncStatus: statusForWrite()
    }
    await db.putProject(updated)
    return updated
  },

  async createOrUpdateTicket(input: TicketInput, existing?: TicketRecord): Promise<TicketRecord> {
    const settings = await getSettings()
    const userId = settings.lastCloudUserId ?? settings.localUserId
    const normalizedName = normalizeSupplier(input.supplierName)
    const suppliers = await db.getSuppliers()
    const supplier = suppliers.find((item) => item.userId === userId && item.normalizedName === normalizedName)
    const currentTicket = existing ? await db.getTicket(existing.id) : undefined
    if (existing && (currentTicket ?? existing).userId !== userId) throw new Error('当前账号无法编辑这条记录，请重新打开记录。')
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

    const ticket: TicketRecord = {
      id: existing?.id ?? createId(),
      userId,
      issueDate: input.issueDate,
      supplierId: nextSupplier.id,
      supplierName: nextSupplier.name,
      projectId: input.projectId,
      projectName: input.projectName,
      subItemName: input.subItemName,
      agentPriceThb: input.agentPriceThb,
      costThb: input.costThb,
      note: input.note.trim(),
      createdAt: existing?.createdAt ?? changedAt,
      updatedAt: changedAt,
      deletedAt: null,
      syncStatus: statusForWrite()
    }
    await db.putTicket(ticket)
    return ticket
  },

  async deleteTicket(ticket: TicketRecord): Promise<TicketRecord> {
    const currentTicket = await db.getTicket(ticket.id)
    if ((currentTicket ?? ticket).userId !== await activeUserId()) throw new Error('当前账号无法删除这条记录。')
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
