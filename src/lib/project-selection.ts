import type { Project, TicketInput } from '../types'

export const projectNames = (projects: Project[]) =>
  [...new Set(projects.map((project) => project.name))].sort((a, b) => a.localeCompare(b, 'zh-CN'))

const clearSelection = (form: TicketInput, projectName: string): TicketInput => ({
  ...form, projectName, projectId: '', supplierName: '', subItemName: '',
  agentPriceThb: Number.NaN, costThb: Number.NaN
})

const applyProject = (form: TicketInput, project: Project): TicketInput => ({
  ...form, projectId: project.id, projectName: project.name, supplierName: project.supplierName,
  subItemName: project.subItemName, agentPriceThb: project.defaultAgentPriceThb, costThb: project.defaultCostThb
})

export const chooseProject = (form: TicketInput, projects: Project[], name: string): TicketInput => {
  const choices = projects.filter((project) => project.name === name)
  const defaults = choices.filter((project) => !project.subItemName)
  // Never silently choose a supplier when several price options are possible.
  const selected = choices.length === 1 ? choices[0] : defaults.length === 1 ? defaults[0] : undefined
  return selected ? applyProject(form, selected) : clearSelection(form, name)
}

export const chooseProjectOption = (form: TicketInput, projects: Project[], id: string): TicketInput => {
  const selected = projects.find((project) => project.id === id && project.name === form.projectName)
  return selected ? applyProject(form, selected) : clearSelection(form, form.projectName)
}

export const projectOptionLabel = (project: Project, choices: Project[]) => {
  const name = project.subItemName || '不分套餐'
  return new Set(choices.map((choice) => choice.supplierId)).size > 1 ? `${name} · ${project.supplierName}` : name
}
