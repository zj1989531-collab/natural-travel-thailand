import type { Project, TicketRecord } from '../types'
import { cleanProjectLabel } from './project-labels'

const normalizeQuery = (value: string) => cleanProjectLabel(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')

export const filterProjects = (projects: Project[], query = '', supplierId = '') => {
  const terms = query.normalize('NFKC').trim().split(/[\s,，、]+/).map(normalizeQuery).filter(Boolean)
  return projects.filter(project => !project.mergedIntoId && (!supplierId || project.manualSupplier || project.supplierId === supplierId) &&
    terms.every(term => [project.name, project.subItemName, project.supplierName].some(value => normalizeQuery(value).includes(term))))
}

// Derived from saved account-scoped records, so recent selections are available
// on both devices after ledger synchronization without browser-only preferences.
export const recentProjectOptions = (projects: Project[], tickets: TicketRecord[], limit = 5) => {
  if (limit < 1) return []
  const byId = new Map(projects.filter(row => !row.mergedIntoId).map(row => [row.id, row]))
  const selected = new Set<string>()
  const result: Project[] = []
  for (const ticket of [...tickets].filter(row => !row.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))) {
    const project = ticket.projectId ? byId.get(ticket.projectId) : undefined
    if (!project || project.userId !== ticket.userId || selected.has(project.id)) continue
    selected.add(project.id); result.push(project)
    if (result.length >= limit) break
  }
  return result
}
