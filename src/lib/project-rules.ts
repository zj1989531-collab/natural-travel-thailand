import type { AmountBasis, Project, SettlementMode, TicketRecord } from '../types'
import { isWholeBooking } from './effective-quantities'

export const isMonthlySettlementProject = (projectName: string): boolean => {
  const name = projectName.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return /^(69|79)秀/.test(name) || /泰拳|嘉年华|潜水/.test(name) || /格兰岛.*一日游/.test(name)
}

type ProjectRules = Pick<Project, 'name' | 'subItemName' | 'entryMode' | 'quantityUnit' | 'defaultAmountBasis' | 'settlementMode'>
export const resolveProjectRules = (project: ProjectRules): { defaultAmountBasis: AmountBasis; settlementMode: SettlementMode } => ({
  defaultAmountBasis: project.defaultAmountBasis ?? (project.entryMode !== 'profit_only' && project.quantityUnit !== 'item' && isWholeBooking({ projectName: project.name, subItemName: project.subItemName }) ? 'total' : 'per_person'),
  settlementMode: project.entryMode === 'profit_only' ? 'monthly' : project.settlementMode ?? (isMonthlySettlementProject(project.name) ? 'monthly' : 'daily')
})

// Legacy tickets resolve from their own immutable name/type, never today's
// catalogue. Do not write inferred values back into refunded ticket snapshots.
export const ticketSettlementMode = (ticket: Pick<TicketRecord, 'projectName' | 'entryMode' | 'settlementMode'>): SettlementMode =>
  ticket.entryMode === 'profit_only' ? 'monthly' : ticket.settlementMode ?? (isMonthlySettlementProject(ticket.projectName) ? 'monthly' : 'daily')

export const validateProjectRules = (input: { defaultAmountBasis?: AmountBasis | null; settlementMode?: SettlementMode | null }) => {
  if (input.defaultAmountBasis != null && !['total', 'per_person'].includes(input.defaultAmountBasis)) throw new Error('请选择有效的默认计价方式。')
  if (input.settlementMode != null && !['daily', 'monthly'].includes(input.settlementMode)) throw new Error('请选择有效的结算方式。')
}
