import type { Project, TicketRecord } from '../types'
import { normalizeSupplier } from './format'

export const cleanProjectLabel = (value: string): string => {
  if (!value.includes('成人')) return value
  return value.replaceAll('成人', '')
    .replace(/（\s*）|\(\s*\)|【\s*】/g, '')
    .replace(/^[\s·•/／|｜—–-]+|[\s·•/／|｜—–-]+$/g, '')
    .trim()
}

export const projectDisplay = (project: Project): Project => {
  const name = cleanProjectLabel(project.name)
  const subItemName = cleanProjectLabel(project.subItemName)
  return { ...project, name, subItemName, normalizedName: normalizeSupplier(name), normalizedSubItemName: normalizeSupplier(subItemName) }
}

// Display aliases only: preserve immutable historical snapshots in storage.
export const ticketDisplay = (ticket: TicketRecord): TicketRecord => ({ ...ticket, projectName: cleanProjectLabel(ticket.projectName), subItemName: cleanProjectLabel(ticket.subItemName) })
