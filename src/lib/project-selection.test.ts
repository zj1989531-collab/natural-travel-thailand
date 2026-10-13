import { describe, expect, it } from 'vitest'
import type { Project, TicketInput } from '../types'
import { chooseProject, chooseProjectOption, projectNames, projectOptionLabel } from './project-selection'

const form: TicketInput = {
  issueDate: '2026-01-01', supplierName: '上次供货商', projectId: 'old', projectName: '上次项目',
  subItemName: '旧套餐', agentPriceThb: 999, costThb: 888, note: '保留备注'
}
const project = (id: string, name: string, subItemName = '', supplierId = 'supplier-a'): Project => ({
  id, userId: 'user-a', supplierId, supplierName: supplierId === 'supplier-a' ? '示例供货商甲' : '示例供货商乙',
  name, normalizedName: name, subItemName, normalizedSubItemName: subItemName,
  defaultCostThb: 100, defaultAgentPriceThb: 150, createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', syncStatus: 'synced'
})

describe('project-first ticket selection', () => {
  it('sorts project names by character count, with a consistent order for ties', () => {
    const projects = [project('1', '格兰岛一日游'), project('2', '潜水'), project('3', '泰拳'), project('4', '嘉年华')]
    const tiedNames = ['潜水', '泰拳'].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    expect(projectNames(projects)).toEqual([...tiedNames, '嘉年华', '格兰岛一日游'])
    expect(projects.map((item) => item.id)).toEqual(['1', '2', '3', '4'])
    expect(projectNames([])).toEqual([])
  })

  it('places monthly commission entries last and sorts that group by length too', () => {
    const projects = [
      { ...project('1', '星光旅行社（月结返佣）'), entryMode: 'profit_only' as const },
      { ...project('2', '返佣'), entryMode: 'profit_only' as const },
      project('3', '很长的常规出票项目名称'),
      project('4', '生蚝（月结返佣）'),
      project('5', '虾哥（月结反佣）'),
      project('6', '潜水')
    ]
    const tiedNames = ['生蚝（月结返佣）', '虾哥（月结反佣）'].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    expect(projectNames(projects)).toEqual(['潜水', '很长的常规出票项目名称', '返佣', ...tiedNames, '星光旅行社（月结返佣）'])
  })

  it('counts Unicode characters rather than UTF-16 units and keeps grouped monthly names last', () => {
    expect(projectNames([project('1', '𠮷'), project('2', '票甲')])).toEqual(['𠮷', '票甲'])
    expect(projectNames([
      project('1', '短名'),
      { ...project('2', '短名', '返佣套餐'), entryMode: 'profit_only' as const },
      project('3', '常规长名称')
    ])).toEqual(['常规长名称', '短名'])
  })

  it('selects profit-only mode and clears old prices and stale manual profit', () => {
    const commission = { ...project('commission', '示例返佣'), entryMode: 'profit_only' as const }
    const selected = chooseProject({ ...form, manualProfitThb: 500 }, [commission], commission.name)
    expect(selected).toMatchObject({ entryMode: 'profit_only', manualProfitThb: null, costThb: 0, agentPriceThb: 0 })
    expect(chooseProject(selected, [project('normal', '普通项目')], '普通项目')).toMatchObject({ entryMode: 'standard', manualProfitThb: null, costThb: 100, agentPriceThb: 150 })
  })
  it('lists all projects without a supplier filter and groups duplicate names', () => {
    expect(projectNames([project('1', '项目甲'), project('2', '项目乙', '', 'supplier-b'), project('3', '项目甲', '成人')])).toHaveLength(2)
    expect(projectNames([project('1', '项目甲'), project('2', '项目乙', '', 'supplier-b')])).toContain('项目乙')
  })

  it('automatically fills supplier and prices for a sole option', () => {
    const selected = chooseProject(form, [project('1', '项目甲')], '项目甲')
    expect(selected).toMatchObject({ projectId: '1', supplierName: '示例供货商甲', costThb: 100, agentPriceThb: 150, subItemName: '', note: form.note, issueDate: form.issueDate })
    expect(form.projectId).toBe('old')
  })

  it('automatically chooses a sole named package too', () => {
    expect(chooseProject(form, [project('1', '项目甲', '成人')], '项目甲').subItemName).toBe('成人')
  })

  it('uses a unique default when the user does not choose an optional subitem', () => {
    expect(chooseProject(form, [project('1', '项目甲'), project('2', '项目甲', 'VIP')], '项目甲').projectId).toBe('1')
  })

  it('clears stale prices and suppliers while selecting a multi-package project', () => {
    const selected = chooseProject(form, [project('1', '项目甲', '成人'), project('2', '项目甲', '儿童')], '项目甲')
    expect(selected).toMatchObject({ projectName: '项目甲', supplierName: '', projectId: '', subItemName: '' })
    expect(selected.costThb).toBeNaN()
    expect(selected.agentPriceThb).toBeNaN()
  })

  it('keeps different suppliers unambiguous and fills the chosen supplier automatically', () => {
    const choices = [project('1', '项目甲', '', 'supplier-a'), project('2', '项目甲', '', 'supplier-b')]
    const selected = chooseProject(form, choices, '项目甲')
    expect(selected.projectId).toBe('')
    expect(projectOptionLabel(choices[1], choices)).toBe('不分套餐 · 示例供货商乙')
    expect(chooseProjectOption(selected, choices, '2')).toMatchObject({ supplierName: '示例供货商乙', projectId: '2' })
  })

  it('rejects an option belonging to another parent project', () => {
    const selected = chooseProjectOption({ ...form, projectName: '项目甲' }, [project('1', '项目乙')], '1')
    expect(selected.projectId).toBe('')
    expect(selected.costThb).toBeNaN()
  })
})
