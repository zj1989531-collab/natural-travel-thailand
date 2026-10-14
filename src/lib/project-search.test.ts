import { describe, expect, it } from 'vitest'
import type { Project, TicketRecord } from '../types'
import { filterProjects, recentProjectOptions } from './project-search'
const project = (id: string, name = '泰拳', subItemName = '亚洲面孔', supplierId = 's'): Project => ({ id, userId: 'u', name, normalizedName: name, subItemName, normalizedSubItemName: subItemName, supplierId, supplierName: supplierId === 's' ? '示例旅行社' : '另一供货商', defaultAgentPriceThb: 650, defaultCostThb: 620, syncStatus: 'synced', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
const projects = [project('a'), project('b', '泰拳', '欧美面孔'), project('c', '药品', '果冻（女）', 'other')]
const record = (projectId: string | null, createdAt = '2026-10-15T00:00:00Z', extra: Partial<TicketRecord> = {}) => ({ id: projectId ?? 'missing', userId: 'u', projectId, createdAt, deletedAt: null, ...extra } as TicketRecord)
describe('searchable and account-scoped recent projects', () => {
  it('searches project, package and supplier names without mutation', () => {
    expect(filterProjects(projects, '泰拳')).toHaveLength(2)
    expect(filterProjects(projects, '欧美')).toEqual([projects[1]])
    expect(filterProjects(projects, '另一供货商')).toEqual([projects[2]])
    expect(projects).toHaveLength(3)
  })
  it('combines supplier filters and multiple keywords including full-width characters', () => {
    expect(filterProjects(projects, '泰拳 欧美', 's')).toEqual([projects[1]])
    expect(filterProjects(projects, '果冻（女）', 'other')).toEqual([projects[2]])
    expect(filterProjects([project('x', 'MAX泰拳')], 'ｍａｘ')).toHaveLength(1)
  })
  it('returns all for empty queries and no matches for unknown filters, ignoring archived aliases', () => {
    expect(filterProjects(projects)).toEqual(projects)
    expect(filterProjects(projects, '不存在')).toEqual([])
    expect(filterProjects(projects, '', 'missing')).toEqual([])
    expect(filterProjects([{ ...projects[0], mergedIntoId: 'other-id' }])).toEqual([])
  })
  it('deduplicates by package ID and orders most recently created records first', () => {
    const rows = [record('a', '2026-10-14'), record('b', '2026-10-15'), record('a', '2026-10-13')]
    expect(recentProjectOptions(projects, rows).map(row => row.id)).toEqual(['b', 'a'])
    expect(recentProjectOptions(projects, rows, 1).map(row => row.id)).toEqual(['b'])
    expect(recentProjectOptions(projects, rows, 0)).toEqual([])
  })
  it('ignores deleted records, missing projects, archived aliases and other accounts', () => {
    expect(recentProjectOptions(projects, [record('a', undefined, { deletedAt: 'now' }), record('b', undefined, { userId: 'other' }), record(null), record('removed')])).toEqual([])
  })
})
