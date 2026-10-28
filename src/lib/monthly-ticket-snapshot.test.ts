import { describe, expect, it } from 'vitest'
import type { Project } from '../types'
import { createMonthlyTicketSnapshot } from './monthly-ticket-snapshot'
import { resolveMonthlyPricing } from './monthly-pricing'

const project: Project = {
  id: 'koh-larn-c', userId: 'owner', supplierId: 'supplier', supplierName: '海岛旅行社',
  name: '格兰岛跟团一日游', normalizedName: '格兰岛跟团一日游', subItemName: 'C套餐', normalizedSubItemName: 'c套餐',
  defaultAgentPriceThb: 850, defaultCostThb: 720, defaultAmountBasis: 'per_person', settlementMode: 'monthly',
  entryMode: 'standard', quantityUnit: 'person', createdAt: '', updatedAt: '', syncStatus: 'synced'
}

describe('独立月结票保存快照', () => {
  it('freezes the chosen package, prices and Bangkok issue time for a retry', () => {
    const input = { date: '2026-10-26', guestName: ' 向绍平 ', people: 1, projectId: project.id }
    const pricing = resolveMonthlyPricing('kohlarn', input, [project])
    const snapshot = createMonthlyTicketSnapshot(input, pricing, '18:35')

    expect(snapshot).toEqual({
      guestName: '向绍平', issueDate: '2026-10-26', issueTime: '18:35',
      projectId: 'koh-larn-c', projectName: '格兰岛跟团一日游', subItemName: 'C套餐', supplierName: '海岛旅行社',
      personCount: 1, quantityUnit: 'person', amountBasis: 'per_person', entryMode: 'standard', settlementMode: 'monthly',
      agentPriceThb: 850, costThb: 720, note: ''
    })

    project.defaultAgentPriceThb = 990
    project.defaultCostThb = 810
    expect(snapshot).toMatchObject({ issueTime: '18:35', agentPriceThb: 850, costThb: 720 })
  })
})
