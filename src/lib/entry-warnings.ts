import type { Project, TicketInput, TicketRecord } from '../types'
import { cleanProjectLabel } from './project-labels'
import { getOriginalTicketAmounts, validateAmountPrecision } from './ticket-amounts'
import { getRefundState } from './refunds'
import { formatThb } from './format'

export const validateDraftAmounts = (input: TicketInput) => {
  const values = input.entryMode === 'profit_only' ? [input.manualProfitThb ?? NaN] : [input.agentPriceThb, input.costThb]
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('请填写大于或等于0的有效金额。')
  validateAmountPrecision(values)
  const totals = getOriginalTicketAmounts(input)
  validateAmountPrecision([totals.agentPriceThb, totals.costThb, Math.abs(totals.profitThb)])
}

export function ticketWarnings(input: TicketInput, project: Project | undefined, records: TicketRecord[], excludeId?: string, supplierId = project?.supplierId) {
  const totals = getOriginalTicketAmounts(input)
  const cents = (value: number) => Math.round(value * 100)
  const duplicates = project ? records.filter(record => {
    if (record.userId !== project.userId || record.id === excludeId || record.deletedAt || getRefundState(record).full || record.issueDate !== input.issueDate || record.supplierId !== supplierId) return false
    const sameProject = record.projectId ? record.projectId === project.id : cleanProjectLabel(record.projectName) === cleanProjectLabel(input.projectName) && cleanProjectLabel(record.subItemName) === cleanProjectLabel(input.subItemName)
    if (!sameProject || (record.quantityUnit ?? 'person') !== (input.quantityUnit ?? 'person') || (record.personCount ?? null) !== (input.personCount ?? null) || (record.entryMode ?? 'standard') !== (input.entryMode ?? 'standard')) return false
    const original = getOriginalTicketAmounts(record)
    return ['agentPriceThb', 'costThb', 'profitThb'].every(key => cents(original[key as keyof typeof original]) === cents(totals[key as keyof typeof totals]))
  }) : []
  const messages: string[] = []
  if (duplicates.length) messages.push(`发现 ${duplicates.length} 条同日、同供货商及套餐、相同人数／数量和金额的记录，可能重复录入。请核对后再保存。`)
  if (input.entryMode !== 'profit_only' && totals.profitThb < 0) messages.push(`代理售价低于供货商成本，本次预计亏损 ${formatThb(-totals.profitThb)}。`)
  return { messages, key: JSON.stringify([input, excludeId, duplicates.map(row => [row.id, row.updatedAt]).sort(), messages]) }
}

export const projectPriceWarnings = (cost: number, price: number, manual: boolean, profitOnly: boolean) =>
  !manual && !profitOnly && price < cost ? [`默认代理售价低于供货商成本，每计价单位预计亏损 ${formatThb(cost - price)}。`] : []
