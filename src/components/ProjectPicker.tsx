import { useState, type ReactNode } from 'react'
import type { Project, TicketInput } from '../types'
import { filterProjects } from '../lib/project-search'
import { projectNames, projectOptionLabel } from '../lib/project-selection'

export function ProjectPicker({ projects, form, onName, onOption, selectedOptionIds = [], renderOptions }: {
  projects: Project[]; form: TicketInput; onName: (name: string) => void; onOption: (id: string, name?: string) => void
  selectedOptionIds?: string[]
  renderOptions?: (choices: Project[], allOptions: Project[]) => ReactNode
}) {
  const [query, setQuery] = useState('')
  const matching = filterProjects(projects, query)
  const names = projectNames(matching)
  const visibleNames = form.projectName && !names.includes(form.projectName) ? [form.projectName, ...names] : names
  const allOptions = projects.filter(project => project.name === form.projectName)
  const choices = allOptions.filter(project => matching.some(row => row.id === project.id) || project.id === form.projectId || selectedOptionIds.includes(project.id))
  return <section className="project-picker" aria-label="项目选择">
    <label>搜索项目<input type="search" placeholder="项目、套餐或供货商" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} /></label>
    {query && <div className="project-search-status"><span role="status">找到 {names.length} 个项目 · {matching.length} 个套餐{names.length === 0 ? '，请修改关键词' : ''}</span><button className="text-action" type="button" onClick={() => setQuery('')}>清除搜索</button></div>}
    <label>项目<select value={form.projectName} onChange={event => onName(event.target.value)} required><option value="">请选择项目</option>{visibleNames.map(name => <option key={name} value={name}>{name}{!names.includes(name) ? '（当前已选）' : ''}</option>)}</select></label>
    {renderOptions ? renderOptions(choices, allOptions) : <label>子项 / 套餐 <span className="muted">（可选）</span><select value={form.projectId} disabled={!form.projectName} onChange={event => onOption(event.target.value)} required><option value="">{!form.projectName ? '请先选择项目' : choices.length ? '请选择子项/套餐' : '没有匹配套餐，请清除搜索'}</option>{choices.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, allOptions)}</option>)}</select></label>}
  </section>
}
