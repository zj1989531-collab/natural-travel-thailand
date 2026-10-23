import type { Project } from '../types'
import { isBoxingProject, boxingCategoryForProject } from './boxing'
import { isShow69Project, type BoxingCategory, type Show69RecordInput } from './show69'
import { resolveProjectRules } from './project-rules'
import { validateAmountPrecision } from './ticket-amounts'

export { boxingCategoryFromText, boxingCategoryForProject, boxingCategoryForTicket } from './boxing'
export type MonthlyRecordKind = 'show69' | 'boxing'

const syntheticSupplier = (kind: MonthlyRecordKind, project: Project) =>
  project.supplierName.normalize('NFKC').replace(/\s+/g, '') === (kind === 'show69' ? '69秀独立记录' : '泰拳独立记录')

const validPrice = (project: Project): boolean => {
  if (project.mergedIntoId || project.entryMode != null && project.entryMode !== 'standard' || project.quantityUnit != null && project.quantityUnit !== 'person' || project.manualAgentPrice || project.manualCostPrice || project.manualSupplier) return false
  if (resolveProjectRules(project).defaultAmountBasis !== 'per_person') return false
  const values = [project.defaultAgentPriceThb, project.defaultCostThb]
  if (values.some(value => !Number.isFinite(value) || value < 0)) return false
  if (values.every(value => value === 0)) return false
  try { validateAmountPrecision(values); return true } catch { return false }
}

export const monthlyPricingOptions = (kind: MonthlyRecordKind, projects: Project[], boxingCategory?: BoxingCategory): Project[] => {
  const matching = projects.filter(project => {
    if (!validPrice(project) || !(kind === 'show69' ? isShow69Project(project.name) : isBoxingProject(project.name))) return false
    if (kind === 'boxing') {
      let category: BoxingCategory | undefined
      try { category = boxingCategoryForProject(project) } catch { return false }
      if (!category || boxingCategory && category !== boxingCategory) return false
    }
    return !syntheticSupplier(kind, project) || project.defaultAgentPriceThb !== 0 || project.defaultCostThb !== 0
  })
  const real = matching.filter(project => !syntheticSupplier(kind, project))
  return real.length ? real : matching
}

export const resolveMonthlyPricing = (kind: MonthlyRecordKind, input: Show69RecordInput, projects: Project[]) => {
  const boxingCategory = kind === 'boxing' ? input.boxingCategory : undefined
  if (kind === 'boxing' && boxingCategory !== 'asian' && boxingCategory !== 'western') throw new Error('请选择泰拳票种：亚洲人或欧美人。')
  const options = monthlyPricingOptions(kind, projects, boxingCategory)
  const selectedId = input.projectId?.trim()
  let project: Project | undefined
  if (selectedId) {
    project = options.find(option => option.id === selectedId)
    if (!project) throw new Error('所选供货商或套餐价格已变化，请重新选择当前票种的有效价格。')
  } else if (options.length === 1) project = options[0]
  else if (options.length > 1) throw new Error('匹配到多个供货商或套餐价格，请先明确选择。')
  const agentPriceThb = project?.defaultAgentPriceThb ?? (kind === 'show69' ? 430 : boxingCategory === 'asian' ? 650 : 900)
  const costThb = project?.defaultCostThb ?? (kind === 'show69' ? 400 : boxingCategory === 'asian' ? 620 : 850)
  return {
    project, agentPriceThb, costThb,
    profitThb: (Math.round(agentPriceThb * 100) - Math.round(costThb * 100)) / 100,
    subItemName: project?.subItemName ?? (kind === 'show69' ? '独立记录' : boxingCategory === 'asian' ? '亚洲面孔' : '欧美面孔'),
    boxingCategory
  }
}
