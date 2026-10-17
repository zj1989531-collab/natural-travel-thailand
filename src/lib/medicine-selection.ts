import type { AmountBasis, Project, TicketInput } from '../types'
import { isValidPersonCount } from './format'
import { isMedicineProject } from './medicine-batch'
import { projectDisplay } from './project-labels'
import { resolveProjectRules } from './project-rules'
import { getOriginalTicketAmounts, validateAmountPrecision } from './ticket-amounts'

export interface MedicineLine {
  projectId: string
  personCount: number | null
  amountBasis: AmountBasis
  /** NaN represents an empty input, so a manual price is never guessed as zero. */
  agentPriceThb: number
  costThb: number
}

export const createMedicineLine = (project: Project): MedicineLine => {
  if (!isMedicineProject(project) || project.mergedIntoId) throw new Error('请选择有效的药品商品子项。')
  return {
    projectId: project.id, personCount: 1, amountBasis: resolveProjectRules(project).defaultAmountBasis,
    agentPriceThb: project.manualAgentPrice ? Number.NaN : project.defaultAgentPriceThb,
    costThb: project.manualCostPrice ? Number.NaN : project.defaultCostThb
  }
}

export const toggleMedicineProject = (lines: MedicineLine[], project: Project, checked: boolean): MedicineLine[] => {
  if (!checked) return lines.filter(line => line.projectId !== project.id)
  return lines.some(line => line.projectId === project.id) ? lines : [...lines, createMedicineLine(project)]
}

export const updateMedicineLine = (lines: MedicineLine[], projectId: string, changes: Partial<Omit<MedicineLine, 'projectId'>>): MedicineLine[] =>
  lines.map(line => line.projectId === projectId ? { ...line, ...changes } : line)

export const medicineLineAmounts = (line: MedicineLine) => {
  if (typeof line.personCount !== 'number' || !isValidPersonCount(line.personCount)) throw new Error('数量必须是大于0的整数（件）。')
  if (!['per_person', 'total'].includes(line.amountBasis)) throw new Error('请选择有效的药品金额单位。')
  if (!Number.isFinite(line.agentPriceThb)) throw new Error('请填写本项售价。')
  if (!Number.isFinite(line.costThb)) throw new Error('请填写本项成本。')
  validateAmountPrecision([line.agentPriceThb, line.costThb])
  const amounts = getOriginalTicketAmounts({ ...line, entryMode: 'standard' })
  validateAmountPrecision([amounts.agentPriceThb, amounts.costThb, Math.abs(amounts.profitThb)])
  return amounts
}

export const summariseMedicineLines = (lines: MedicineLine[], projects?: Project[]) => {
  let agentCents = 0, costCents = 0, quantity = 0, incompleteCount = 0
  for (const line of lines) {
    try {
      if (projects && !projects.some(project => project.id === line.projectId && isMedicineProject(project) && !project.mergedIntoId)) throw new Error('商品目录已更新。')
      const amounts = medicineLineAmounts(line)
      agentCents += Math.round(amounts.agentPriceThb * 100)
      costCents += Math.round(amounts.costThb * 100)
      quantity += line.personCount!
    } catch { incompleteCount++ }
  }
  const complete = lines.length > 0 && incompleteCount === 0 && Number.isSafeInteger(agentCents) && Number.isSafeInteger(costCents)
  return {
    selectedCount: lines.length, incompleteCount, complete,
    quantity: complete ? quantity : null,
    agentPriceThb: complete ? agentCents / 100 : null,
    costThb: complete ? costCents / 100 : null,
    profitThb: complete ? (agentCents - costCents) / 100 : null
  }
}

/** Common customer/date/time/note fields are copied to every independent item. */
export const buildMedicineTicketInputs = (common: TicketInput, lines: MedicineLine[], projects: Project[]): TicketInput[] => {
  if (!lines.length) throw new Error('请至少选择1个药品子项。')
  if (new Set(lines.map(line => line.projectId)).size !== lines.length) throw new Error('同一个药品子项不能重复选择，请合并数量。')
  return lines.map(line => {
    const found = projects.find(project => project.id === line.projectId && isMedicineProject(project) && !project.mergedIntoId)
    if (!found) throw new Error('所选药品子项已更新或移除，请重新选择。')
    medicineLineAmounts(line)
    const project = projectDisplay(found)
    return {
      ...common, projectId: project.id, projectName: project.name, subItemName: project.subItemName,
      supplierName: project.supplierName, quantityUnit: 'item', entryMode: 'standard', manualProfitThb: null,
      settlementMode: resolveProjectRules(project).settlementMode, amountBasis: line.amountBasis,
      personCount: line.personCount, agentPriceThb: line.agentPriceThb, costThb: line.costThb
    }
  })
}
