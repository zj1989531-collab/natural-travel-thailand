import type { Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { getBangkokDate } from './format'
import { getProfit } from './stats'
import { getOriginalTicketAmounts, getTicketAmounts } from './ticket-amounts'
import { getRefundState } from './refunds'
import { isItemQuantity, quantityLabels } from './quantity'

const pickFields = <T, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.map((key) => [key, record[key]])) as Pick<T, K>

export const createLedgerBackup = (data: { suppliers: Supplier[]; projects: Project[]; tickets: TicketRecord[]; refunds?: RefundRecord[] }, exportedAt = new Date().toISOString()) => {
  const refunds = [...new Map((data.refunds ?? data.tickets.flatMap((ticket) => ticket.refunds ?? [])).map((refund) => [refund.id, refund])).values()]
  const owners = new Set([...data.suppliers, ...data.projects, ...data.tickets, ...refunds].map((record) => record.userId))
  if (owners.size > 1) throw new Error('账号正在切换，请稍后重新备份，避免混合不同账号的资料。')
  return {
    format: 'ticket-profit-ledger',
    version: 2,
    currency: 'THB',
    timeZone: 'Asia/Bangkok',
    exportedAt,
    refunds: refunds.map((record) => pickFields(record, ['id', 'userId', 'ticketId', 'personCount', 'isFull', 'refundRevenueThb', 'returnedCostThb', 'refundDate', 'refundTime', 'note', 'cancelledAt', 'createdAt', 'updatedAt', 'syncStatus'])),
    // Explicit fields exclude authentication sessions and any future secret fields.
    suppliers: data.suppliers.map((record) => pickFields(record, ['id', 'userId', 'name', 'normalizedName', 'createdAt', 'updatedAt', 'syncStatus'])),
    projects: data.projects.map((record) => pickFields(record, ['id', 'userId', 'supplierId', 'supplierName', 'name', 'normalizedName', 'subItemName', 'normalizedSubItemName', 'entryMode', 'manualAgentPrice', 'quantityUnit', 'defaultCostThb', 'defaultAgentPriceThb', 'createdAt', 'updatedAt', 'syncStatus'])),
    // Include deletion markers so a backup does not resurrect deleted tickets.
    tickets: data.tickets.map((record) => pickFields(record, ['id', 'userId', 'issueDate', 'issueTime', 'personCount', 'quantityUnit', 'amountBasis', 'entryMode', 'manualProfitThb', 'supplierId', 'supplierName', 'projectId', 'projectName', 'subItemName', 'agentPriceThb', 'costThb', 'note', 'createdAt', 'updatedAt', 'deletedAt', 'syncStatus']))
  }
}

export const downloadLedgerBackup = (backup: ReturnType<typeof createLedgerBackup>) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `ticket-ledger-backup-${getBangkokDate()}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const buildTicketExportRows = (tickets: TicketRecord[]) => tickets
    .filter((ticket) => !ticket.deletedAt)
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt))
    .map((ticket) => ({
      '出票日期': ticket.issueDate,
      '曼谷时间': ticket.issueTime || '',
      '人数': isItemQuantity(ticket) ? '' : ticket.personCount ?? '',
      '数量': isItemQuantity(ticket) ? ticket.personCount ?? '' : '',
      '有效人数': isItemQuantity(ticket) ? '' : getRefundState(ticket).remainingPeople ?? '',
      '有效数量': isItemQuantity(ticket) ? getRefundState(ticket).remainingPeople ?? '' : '',
      '退票状态': getRefundState(ticket).active.length ? getRefundState(ticket).full ? '已全部退票' : '部分退票' : '未退票',
      '累计退代理 (THB)': getRefundState(ticket).refundRevenueThb,
      '累计成本返还 (THB)': getRefundState(ticket).returnedCostThb,
      '计价方式': ticket.amountBasis === 'per_person' ? `按${quantityLabels(ticket).label}计算` : '整单总额',
      '记录类型': ticket.entryMode === 'profit_only' ? '月结返佣（仅录利润）' : '出票',
      '供应商': ticket.supplierName,
      '项目': ticket.projectName || '未分类项目',
      '单人代理售价 (THB)': ticket.amountBasis === 'per_person' && ticket.entryMode !== 'profit_only' && !isItemQuantity(ticket) ? ticket.agentPriceThb : '',
      '单人供货商成本 (THB)': ticket.amountBasis === 'per_person' && ticket.entryMode !== 'profit_only' && !isItemQuantity(ticket) ? ticket.costThb : '',
      '单件代理售价 (THB)': ticket.amountBasis === 'per_person' && ticket.entryMode !== 'profit_only' && isItemQuantity(ticket) ? ticket.agentPriceThb : '',
      '单件供货商成本 (THB)': ticket.amountBasis === 'per_person' && ticket.entryMode !== 'profit_only' && isItemQuantity(ticket) ? ticket.costThb : '',
      '单人返佣利润 (THB)': ticket.amountBasis === 'per_person' && ticket.entryMode === 'profit_only' ? ticket.manualProfitThb ?? '' : '',
      '代理售价 (THB)': ticket.entryMode === 'profit_only' ? '' : getTicketAmounts(ticket).agentPriceThb,
      '供货商成本 (THB)': ticket.entryMode === 'profit_only' ? '' : getTicketAmounts(ticket).costThb,
      '利润 (THB)': getProfit(ticket),
      '原始利润 (THB)': getOriginalTicketAmounts(ticket).profitThb,
      '备注': ticket.note,
      '创建时间': new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' })
    }))

export const exportTicketsToXlsx = async (tickets: TicketRecord[]) => {
  const XLSX = await import('xlsx')
  const rows = buildTicketExportRows(tickets)
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.json_to_sheet(rows)
  worksheet['!cols'] = Object.keys(rows[0] ?? {}).map((key) => ({ wch: key === '备注' ? 32 : key === '项目' ? 30 : 22 }))
  XLSX.utils.book_append_sheet(workbook, worksheet, '出票记录')
  const refundRows = [...new Map(tickets.flatMap((ticket) => ticket.refunds ?? []).map((refund) => [refund.id, refund])).values()].map((refund) => ({
    '退票编号': refund.id, '原票编号': refund.ticketId, '退票日期': refund.refundDate, '曼谷时间': refund.refundTime,
    '退票人数': refund.personCount ?? '原人数未知', '范围': refund.isFull ? '全部剩余' : '部分',
    '退给代理 (THB)': refund.refundRevenueThb, '供货商返还 (THB)': refund.returnedCostThb,
    '状态': refund.cancelledAt ? '已撤销' : '有效', '撤销时间': refund.cancelledAt ?? '', '备注': refund.note
  }))
  if (refundRows.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(refundRows), '退票明细')
  XLSX.writeFile(workbook, `票务盈利簿_${new Date().toISOString().slice(0, 10)}.xlsx`)
}
