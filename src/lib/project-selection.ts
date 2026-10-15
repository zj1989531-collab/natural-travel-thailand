import type { Project, TicketInput } from '../types'
import { cleanProjectLabel, projectDisplay } from './project-labels'
import { resolveProjectRules } from './project-rules'

export const projectNames = (projects: Pick<Project, 'name' | 'entryMode'>[]) => {
  projects = projects.map((project) => ({ ...project, name: cleanProjectLabel(project.name) }))
  const monthlyCommissionNames = new Set(projects
    .filter((project) => project.entryMode === 'profit_only' || /月结[返反]佣/.test(project.name))
    .map((project) => project.name))

  return [...new Set(projects.map((project) => project.name))].sort((a, b) =>
    Number(monthlyCommissionNames.has(a)) - Number(monthlyCommissionNames.has(b)) ||
    Array.from(a).length - Array.from(b).length ||
    a.localeCompare(b, 'zh-CN'))
}

const clearSelection = (form: TicketInput, projectName: string, quantityUnit: Project['quantityUnit'] = 'person'): TicketInput => ({
  ...form, quantityUnit, projectName, projectId: '', supplierName: '', subItemName: '',
  agentPriceThb: Number.NaN, costThb: Number.NaN,
  entryMode: 'standard', manualProfitThb: null, settlementMode: null
})

const applyProject = (form: TicketInput, project: Project): TicketInput => ({
  ...form, quantityUnit: project.quantityUnit ?? 'person', projectId: project.id, projectName: project.name, supplierName: project.supplierName,
  amountBasis: resolveProjectRules(project).defaultAmountBasis, settlementMode: resolveProjectRules(project).settlementMode,
  subItemName: project.subItemName, entryMode: project.entryMode ?? 'standard', manualProfitThb: null,
  agentPriceThb: project.entryMode === 'profit_only' ? 0 : project.manualAgentPrice ? Number.NaN : project.defaultAgentPriceThb,
  costThb: project.entryMode === 'profit_only' ? 0 : project.defaultCostThb
})

export const chooseProject = (form: TicketInput, projects: Project[], name: string): TicketInput => {
  name = cleanProjectLabel(name)
  const choices = projects.filter((project) => cleanProjectLabel(project.name) === name)
  const defaults = choices.filter((project) => !project.subItemName)
  // Never silently choose a supplier when several price options are possible.
  const selected = choices.length === 1 ? choices[0] : defaults.length === 1 ? defaults[0] : undefined
  return selected ? applyProject(form, projectDisplay(selected)) : clearSelection(form, name, choices.length && choices.every((project) => project.quantityUnit === 'item') ? 'item' : 'person')
}

export const chooseProjectOption = (form: TicketInput, projects: Project[], id: string): TicketInput => {
  const selected = projects.map(projectDisplay).find((project) => project.id === id && project.name === cleanProjectLabel(form.projectName))
  return selected ? applyProject(form, selected) : clearSelection(form, form.projectName, form.quantityUnit ?? 'person')
}

export const projectOptionLabel = (project: Project, choices: Project[]) => {
  const name = cleanProjectLabel(project.subItemName) || '不分套餐'
  return new Set(choices.map((choice) => choice.supplierId)).size > 1 ? `${name} · ${project.supplierName}` : name
}
