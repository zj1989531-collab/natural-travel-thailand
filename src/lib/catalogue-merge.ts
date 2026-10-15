import type { Project, Supplier, TicketRecord } from '../types'
import { normalizeSupplier } from './format'
import { cleanProjectLabel } from './project-labels'
import { isNewer, mergeRemoteRecord, nextModifiedAt, preserveRuleFields } from './sync'

type CatalogueRow = Supplier | Project

// Preserve duplicate snapshots locally as aliases, rather than deleting them.
// Cloud IDs win identity; the newest version wins editable catalogue fields.
function mergeGroups<T extends CatalogueRow>(rows: T[], remote: T[], userId: string, key: (row: T) => string) {
  const result = new Map(rows.map(row => [row.id, row]))
  for (const row of remote) {
    if (row.userId !== userId) continue
    const current = result.get(row.id)
    if (current && current.userId !== userId) throw new Error('资料编号属于其他账号，已停止合并。')
    result.set(row.id, mergeRemoteRecord(current, row))
  }
  const remoteIds = new Set(remote.filter(row => row.userId === userId).map(row => row.id))
  const groups = new Map<string, T[]>()
  for (const row of result.values()) {
    if (row.userId !== userId || row.mergedIntoId) continue
    const group = groups.get(key(row)) ?? []
    group.push(row); groups.set(key(row), group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const cloud = group.filter(row => remoteIds.has(row.id))
    // Never collapse two existing cloud identities: their historical references
    // may be immutable. That requires explicit server-side reconciliation.
    if (cloud.length > 1) throw new Error('云端有重复资料编号，需要核对后合并；本机资料已保留。')
    const canonical = cloud[0] ?? [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
    const latest = group.reduce((a, b) => isNewer(b.updatedAt, a.updatedAt) ? b : a, canonical)
    const withRules = [...group].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).reduce((preferred, row) => preserveRuleFields(preferred, row), latest)
    result.set(canonical.id, { ...withRules, id: canonical.id, createdAt: canonical.createdAt, mergedIntoId: undefined,
      syncStatus: latest.id === canonical.id ? latest.syncStatus : 'pending' })
    for (const row of group) if (row.id !== canonical.id) result.set(row.id, { ...row, mergedIntoId: canonical.id, syncStatus: 'synced' })
  }
  const resolve = (id: string): string => {
    const visited = new Set<string>()
    while (result.get(id)?.userId === userId && result.get(id)?.mergedIntoId) {
      if (visited.has(id)) throw new Error('重复资料的关联异常，已停止合并。')
      visited.add(id); id = result.get(id)!.mergedIntoId!
    }
    if (result.has(id) && result.get(id)!.userId !== userId) throw new Error('重复资料关联到其他账号，已停止合并。')
    return id
  }
  return { rows: [...result.values()], resolve }
}

export function reconcileCatalogue(local: { suppliers: Supplier[]; projects: Project[]; tickets: TicketRecord[] },
  remote: { suppliers: Supplier[]; projects: Project[] }, userId: string) {
  const suppliers = mergeGroups(local.suppliers, remote.suppliers, userId, row => row.normalizedName)
  const remappedProjects = local.projects.map(row => {
    if (row.userId !== userId || row.mergedIntoId) return row
    const supplierId = suppliers.resolve(row.supplierId)
    // Identity repair must not make stale prices look newer than cloud prices.
    return supplierId === row.supplierId ? row : { ...row, supplierId, syncStatus: 'pending' as const }
  })
  const projectKey = (row: Project) => JSON.stringify([row.supplierId, normalizeSupplier(cleanProjectLabel(row.name)), normalizeSupplier(cleanProjectLabel(row.subItemName))])
  const projects = mergeGroups(remappedProjects, remote.projects, userId, projectKey)
  const tickets = local.tickets.map(row => {
    if (row.userId !== userId) return row
    const supplierId = suppliers.resolve(row.supplierId)
    const projectId = row.projectId ? projects.resolve(row.projectId) : null
    // Only IDs change: never multiply prices, alter dates, or discard refunds.
    return supplierId === row.supplierId && projectId === row.projectId ? row : {
      ...row, supplierId, projectId, updatedAt: nextModifiedAt(row.updatedAt), syncStatus: 'pending' as const
    }
  })
  return { suppliers: suppliers.rows, projects: projects.rows, tickets }
}
