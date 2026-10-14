import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Project, TicketInput } from '../types'
import { ProjectPicker } from './ProjectPicker'
import { SupplierSheet } from '../App'
const project: Project = { id: 'p', userId: 'u', supplierId: 's', supplierName: '测试供货商', name: '测试项目', normalizedName: '测试项目', subItemName: '儿童票', normalizedSubItemName: '儿童票', defaultAgentPriceThb: 650, defaultCostThb: 600, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', syncStatus: 'synced' }
const form = { projectId: project.id, projectName: project.name } as TicketInput
describe('search and recent entry controls', () => {
  it('retains native project and package dropdowns, adding search and named recent packages', () => {
    const html = renderToStaticMarkup(<ProjectPicker projects={[project]} recent={[project]} form={form} onName={() => {}} onOption={() => {}} />)
    for (const text of ['搜索项目', 'type="search"', '最近使用', '测试项目', '儿童票', '测试供货商']) expect(html).toContain(text)
    expect(html.match(/<select/g)).toHaveLength(2)
    expect(html).toContain('value="p" selected=""')
    expect(html).toContain('type="button"')
  })
  it('omits recent options when no previous records are available', () => {
    const html = renderToStaticMarkup(<ProjectPicker projects={[project]} form={form} onName={() => {}} onOption={() => {}} />)
    expect(html).not.toContain('最近使用')
  })
  it('adds accessible price search and supplier filter without hiding editing or backup', () => {
    const html = renderToStaticMarkup(<SupplierSheet suppliers={[{ id: 's', userId: 'u', name: project.supplierName, normalizedName: project.supplierName, createdAt: project.createdAt, updatedAt: project.updatedAt, syncStatus: 'synced' }]} projects={[project]} onAddSupplier={async () => {}} onAddProject={async () => {}} onUpdateProject={async () => {}} onBackup={async () => {}} onClose={() => {}} />)
    for (const text of ['搜索价格表', '筛选供货商', '全部供货商', '编辑价格', '导出全部资料备份']) expect(html).toContain(text)
  })
})
