import type { Project, TicketInput } from '../types'

export const projectNames = (projects: Pick<Project, 'name' | 'entryMode'>[]) => {
  const monthlyCommissionNames = new Set(projects
    .filter((project) => project.entryMode === 'profit_only' || /月结[返反]佣/.test(project.name))
    .map((project) => project.name))

  return [...new Set(projects.map((project) => project.name))].sort((a, b) =>
    Number(monthlyCommissionNames.has(a)) - Number(monthlyCommissionNames.has(b)) ||
    Array.from(a).length - Array.from(b).length ||
    a.localeCompare(b, 'zh-CN'))
}

const clearSelection = (form: TicketInput, projectName: string, quantityUnit: Project['quantityUnit'] = 'person'): TicketInput => ({
  quantityUnit,
  ...form, projectName, projectId: '', supplierName: '', subItemName: '',
  agentPriceThb: Number.NaN, costThb: Number.NaN,
  entryMode: 'standard', manualProfitThb: null
})

const applyProject = (form: TicketInput, project: Project): TicketInput => ({
  quantityUnit: project.quantityUnit ?? 'person',
  ...form, projectId: project.id, projectName: project.name, supplierName: project.supplierName,
  subItemName: project.subItemName, entryMode: project.entryMode ?? 'standard', manualProfitThb: null,
  agentPriceThb: project.entryMode === 'profit_only' ? 0 : project.manualAgentPrice ? Number.NaN : project.defaultAgentPriceThb,
  costThb: project.entryMode === 'profit_only' ? 0 : project.defaultCostThb
})

export const chooseProject = (form: TicketInput, projects: Project[], name: string): TicketInput => {
  const choices = projects.filter((project) => project.name === name)
  const defaults = choices.filter((project) => !project.subItemName)
  // Never silently choose a supplier when several price options are possible.
  const selected = choices.length === 1 ? choices[0] : defaults.length === 1 ? defaults[0] : undefined
  return selected ? applyProject(form, selected) : clearSelection(form, name, choices.length && choices.every((project) => project.quantityUnit === 'item') ? 'item' : 'person')
}

export const chooseProjectOption = (form: TicketInput, projects: Project[], id: string): TicketInput => {
  const selected = projects.find((project) => project.id === id && project.name === form.projectName)
  return selected ? applyProject(form, selected) : clearSelection(form, form.projectName)
}

export const projectOptionLabel = (project: Project, choices: Project[]) => {
  const name = project.subItemName || '不分套餐'
  return new Set(choices.map((choice) => choice.supplierId)).size > 1 ? `${name} · ${project.supplierName}` : name
}
