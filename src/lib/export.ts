import type { Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { getBangkokDate } from './format'
import { getProfit } from './stats'
import { getOriginalTicketAmounts, getTicketAmounts } from './ticket-amounts'
import { getEffectivePersonCount, getRefundState } from './refunds'
import { isItemQuantity, quantityLabels } from './quantity'
import { cleanProjectLabel } from './project-labels'
import { buildShow79Report, mainLedgerTickets } from './show79'
import { ticketSettlementMode } from './project-rules'
import type { LedgerReport } from './reports'
import { buildReportCounts } from './report-counts'
import { buildShow79SettlementState, show79SettlementStatusLabels, type Show79SettlementRecord } from './show79-settlement'

const pickFields = <T, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.map((key) => [key, record[key]])) as Pick<T, K>

export const createLedgerBackup = (data: { suppliers: Supplier[]; projects: Project[]; tickets: TicketRecord[]; refunds?: RefundRecord[]; show79Settlements?: Show79SettlementRecord[] }, exportedAt = new Date().toISOString()) => {
  const refunds = [...new Map((data.refunds ?? data.tickets.flatMap((ticket) => ticket.refunds ?? [])).map((refund) => [refund.id, refund])).values()]
  const show79Settlements = data.show79Settlements ?? []
  const owners = new Set([...data.suppliers, ...data.projects, ...data.tickets, ...refunds, ...show79Settlements].map((record) => record.userId))
  if (owners.size > 1) throw new Error('账号正在切换，请稍后重新备份，避免混合不同账号的资料。')
  return {
    format: 'ticket-profit-ledger',
    version: 2,
    currency: 'THB',
    timeZone: 'Asia/Bangkok',
    exportedAt,
    refunds: refunds.map((record) => pickFields(record, ['id', 'userId', 'ticketId', 'personCount', 'isFull', 'refundRevenueThb', 'returnedCostThb', 'refundDate', 'refundTime', 'note', 'cancelledAt', 'createdAt', 'updatedAt', 'syncStatus'])),
    show79Settlements: show79Settlements.map((record) => pickFields(record, ['id', 'userId', 'month', 'snapshotProfitThb', 'snapshotJimmyThb', 'snapshotPartnersThb', 'jimmyPaidThb', 'partnersPaidThb', 'paymentDate', 'note', 'createdAt', 'updatedAt', 'syncStatus'])),
    // Explicit fields exclude authentication sessions and any future secret fields.
    suppliers: data.suppliers.map((record) => pickFields(record, ['id', 'userId', 'name', 'normalizedName', 'createdAt', 'updatedAt', 'syncStatus', 'mergedIntoId'])),
    projects: data.projects.map((record) => pickFields(record, ['id', 'userId', 'supplierId', 'supplierName', 'name', 'normalizedName', 'subItemName', 'normalizedSubItemName', 'entryMode', 'manualAgentPrice', 'manualCostPrice', 'manualSupplier', 'quantityUnit', 'defaultAmountBasis', 'settlementMode', 'defaultCostThb', 'defaultAgentPriceThb', 'createdAt', 'updatedAt', 'syncStatus', 'mergedIntoId'])),
    // Include deletion markers so a backup does not resurrect deleted tickets.
    tickets: data.tickets.map((record) => pickFields(record, ['guestName', 'id', 'userId', 'issueDate', 'issueTime', 'personCount', 'quantityUnit', 'amountBasis', 'settlementMode', 'entryMode', 'manualProfitThb', 'supplierId', 'supplierName', 'projectId', 'projectName', 'subItemName', 'agentPriceThb', 'costThb', 'note', 'createdAt', 'updatedAt', 'deletedAt', 'syncStatus']))
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
      '客户姓名': ticket.guestName?.trim() || '未填写',
      '曼谷时间': ticket.issueTime || '',
      '人数': isItemQuantity(ticket) ? '' : ticket.personCount ?? '',
      '数量': isItemQuantity(ticket) ? ticket.personCount ?? '' : '',
      '有效人数': ticket.entryMode === 'profit_only' || isItemQuantity(ticket) ? '' : getRefundState(ticket).remainingPeople ?? '',
      '有效数量': ticket.entryMode === 'profit_only' ? '' : isItemQuantity(ticket) ? getRefundState(ticket).remainingPeople ?? '' : '',
      '退票状态': getRefundState(ticket).active.length ? getRefundState(ticket).full ? '已全部退票' : '部分退票' : '未退票',
      '累计退代理 (THB)': getRefundState(ticket).refundRevenueThb,
      '累计成本返还 (THB)': getRefundState(ticket).returnedCostThb,
      '计价方式': ticket.amountBasis === 'per_person' ? `按${quantityLabels(ticket).label}计算` : '整单总额',
      '记录类型': ticket.entryMode === 'profit_only' ? '月结返佣（仅录利润）' : '出票',
      '结算方式': ticketSettlementMode(ticket) === 'monthly' ? '月结' : '日结',
      '供应商': ticket.supplierName,
      '项目': cleanProjectLabel(ticket.projectName) || '未分类项目',
      '子项 / 套餐': cleanProjectLabel(ticket.subItemName),
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
      '创建时间': new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' }),
      '原票编号': ticket.id
    }))

const reportDetailHeaders = ['出票日期', '曼谷时间', '客户姓名', '项目', '子项 / 套餐', '供货商', '有效人数', '有效数量', '记录类型', '结算方式', '退票状态', '利润 (THB)', '备注']

const reportTicketRows = (tickets: TicketRecord[]) => tickets.map((ticket) => {
  const refund = getRefundState(ticket)
  const count = ticket.entryMode === 'profit_only' ? '' : getEffectivePersonCount(ticket) ?? ''
  return {
    '出票日期': ticket.issueDate,
    '曼谷时间': ticket.issueTime || '',
    '客户姓名': ticket.guestName?.trim() || '未填写',
    '项目': cleanProjectLabel(ticket.projectName) || '未分类项目',
    '子项 / 套餐': cleanProjectLabel(ticket.subItemName),
    '供货商': ticket.supplierName,
    '有效人数': isItemQuantity(ticket) ? '' : count,
    '有效数量': isItemQuantity(ticket) ? count : '',
    '记录类型': ticket.entryMode === 'profit_only' ? '月结返佣（仅录利润）' : '出票',
    '结算方式': ticketSettlementMode(ticket) === 'monthly' ? '月结' : '日结',
    '退票状态': refund.active.length ? refund.full ? '已全部退票' : '部分退票' : '未退票',
    '利润 (THB)': getProfit(ticket),
    '备注': ticket.note
  }
})

const reportQuantities = (tickets: TicketRecord[]) => tickets.reduce((total, ticket) => {
  if (ticket.entryMode === 'profit_only') return total
  const count = getEffectivePersonCount(ticket)
  if (count == null) total.unknownCount++
  else if (isItemQuantity(ticket)) total.itemCount += count
  else total.peopleCount += count
  return total
}, { peopleCount: 0, itemCount: 0, unknownCount: 0 })

// Use the already filtered report, including its daily/monthly separation.
// Report exports intentionally contain profit only; the full-ledger export below
// remains available separately for the complete accounting backup.
export const buildReportExportRows = (report: LedgerReport, supplierName: string) => {
  const quantities = reportQuantities(report.records)
  const monthlyRecords = report.mode === 'day' ? report.monthlyRecords : []
  const monthlyQuantities = reportQuantities(monthlyRecords)
  const monthlyCounts = buildReportCounts(monthlyRecords)
  const summary = [{
    '报表标题': report.title,
    '开始日期': report.start,
    '截止日期': report.end,
    '客户筛选': report.guestName?.trim() || '全部客户',
    '供货商': supplierName.trim() || '全部供货商',
    '项目': report.projectName || '全部项目',
    '账务记录数': report.counts.accountingRecordCount,
    '有效订单数': report.counts.effectiveOrderCount,
    '退票单数': report.counts.refundedOrderCount,
    '有效人数': quantities.peopleCount,
    '有效商品数量': quantities.itemCount,
    '数量未填写记录数': quantities.unknownCount,
    '利润合计 (THB)': report.summary.profitThb,
    '单数口径': '账务记录数包含出票及仅录利润记录；有效订单数为未全部退票的出票记录（含商品）；退票单数为至少有一条有效退票的订单数，部分退票和全部退票均计入，已撤销的退票不计入。',
    ...(report.mode === 'day' ? {
      '当日月结另列账务记录数': monthlyCounts.accountingRecordCount,
      '当日月结另列有效订单数': monthlyCounts.effectiveOrderCount,
      '当日月结另列退票单数': monthlyCounts.refundedOrderCount,
      '当日月结另列有效人数': monthlyQuantities.peopleCount,
      '当日月结另列有效商品数量': monthlyQuantities.itemCount,
      '当日月结另列数量未填写记录数': monthlyQuantities.unknownCount,
      '当日月结另列利润 (THB)': report.monthlySummary.profitThb,
      '日报说明': '月结记录另列，按相同单数口径统计，不计入日报账务记录数、有效订单数、退票单数、有效人数、有效数量及利润合计。'
    } : {})
  }]
  return { summary, records: reportTicketRows(report.records), monthlyRecords: reportTicketRows(monthlyRecords) }
}

export const exportReportToXlsx = async (report: LedgerReport, supplierName: string) => {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  const rows = buildReportExportRows(report, supplierName)
  const append = (data: Record<string, string | number>[], name: string, headers?: string[]) => {
    const worksheet = XLSX.utils.json_to_sheet(data, headers ? { header: headers } : undefined)
    worksheet['!cols'] = Object.keys(data[0] ?? Object.fromEntries((headers ?? []).map((header) => [header, '']))).map((key) => ({
      wch: key === '备注' || key === '日报说明' || key === '单数口径' ? 52 : key === '项目' || key === '子项 / 套餐' || key === '客户姓名' ? 28 : Math.max(18, key.length * 2)
    }))
    XLSX.utils.book_append_sheet(workbook, worksheet, name)
  }
  append(rows.summary, '报表汇总')
  append(rows.records, '记录明细', reportDetailHeaders)
  if (rows.monthlyRecords.length) append(rows.monthlyRecords, '当日月结另列', reportDetailHeaders)
  XLSX.writeFile(workbook, `票务盈利报表_${report.start}_${report.end}.xlsx`)
}

export const buildRefundExportRows = (tickets: TicketRecord[]) => {
  const originals = new Map(tickets.map(ticket => [ticket.id, ticket]))
  return [...new Map(tickets.flatMap(ticket => ticket.refunds ?? []).map(refund => [refund.id, refund])).values()].map(refund => {
    const ticket = originals.get(refund.ticketId)
    const item = ticket ? isItemQuantity(ticket) : undefined
    return {
      '退票编号': refund.id, '原票编号': refund.ticketId,
      '客户姓名': ticket?.guestName?.trim() || '未填写', '项目': cleanProjectLabel(ticket?.projectName ?? '') || '原票未找到',
      '子项 / 套餐': cleanProjectLabel(ticket?.subItemName ?? ''), '供货商': ticket?.supplierName ?? '',
      '数量单位': item === undefined ? '未知' : item ? '件' : '人',
      '原人数': item === false ? ticket?.personCount ?? '未记录' : '', '原数量': item ? ticket?.personCount ?? '未记录' : '',
      '退票人数': item === false ? refund.personCount ?? '原人数未知' : '',
      '退回数量': item ? refund.personCount ?? '原数量未知' : '',
      '退票日期': refund.refundDate, '曼谷时间': refund.refundTime, '范围': refund.isFull ? '全部剩余' : '部分',
      '退给代理 (THB)': refund.refundRevenueThb, '供货商返还 (THB)': refund.returnedCostThb,
      '状态': refund.cancelledAt ? '已撤销' : '有效', '撤销时间': refund.cancelledAt ?? '', '备注': refund.note
    }
  })
}

export const exportTicketsToXlsx = async (source: TicketRecord[]) => {
  const tickets = mainLedgerTickets(source)
  const XLSX = await import('xlsx')
  const rows = buildTicketExportRows(tickets)
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.json_to_sheet(rows)
  worksheet['!cols'] = Object.keys(rows[0] ?? {}).map((key) => ({ wch: key === '备注' ? 32 : key === '项目' ? 30 : 22 }))
  XLSX.utils.book_append_sheet(workbook, worksheet, '出票记录')
  const refundRows = buildRefundExportRows(tickets)
  if (refundRows.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(refundRows), '退票明细')
  XLSX.writeFile(workbook, `票务盈利簿_${getBangkokDate()}.xlsx`)
}

const show79SettlementHeaders = ['结算月份', '实际付款日期', 'jimmy 本次支付 / 收回 (THB)', '大狗二狗本次支付 / 收回 (THB)', '登记时月利润 (THB)', '登记时 jimmy 40% (THB)', '登记时大狗二狗 60% (THB)', '备注', '登记时间（曼谷）']

export const buildShow79ExportRows = (tickets: TicketRecord[], date: string, month: string, settlements: Show79SettlementRecord[] = [], exportedAt = new Date().toISOString()) => {
  const report = buildShow79Report(tickets, date, month)
  const settlement = buildShow79SettlementState(tickets, settlements, month)
  const summary = [{
    '月份': month,
    '月订单数': report.records.length,
    '月人数': report.monthPeople,
    '人数未填记录': report.monthUnknown,
    '月实际利润 (THB)': report.profitThb,
    'jimmy 40% (THB)': report.jimmyThb,
    '大狗二狗合计 60% (THB)': report.partnersThb,
    '结算状态': show79SettlementStatusLabels[settlement.status],
    'jimmy 累计已付 (THB)': settlement.paidJimmyThb,
    'jimmy 尚应付 (THB)': Math.max(0, settlement.remainingJimmyThb),
    'jimmy 应收回 (THB)': Math.max(0, -settlement.remainingJimmyThb),
    '大狗二狗累计已付 (THB)': settlement.paidPartnersThb,
    '大狗二狗尚应付 (THB)': Math.max(0, settlement.remainingPartnersThb),
    '大狗二狗应收回 (THB)': Math.max(0, -settlement.remainingPartnersThb),
    '导出时间（曼谷）': new Date(exportedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' }),
    '结算说明': '本次支付 / 收回：正数为支付，负数为收回或冲正；累计已付为支付减收回的净额。利润及应分金额按当前订单计算，登记时快照保留原值。'
  }]
  const settlementRecords = settlement.records.map(record => ({
    '结算月份': record.month,
    '实际付款日期': record.paymentDate,
    'jimmy 本次支付 / 收回 (THB)': record.jimmyPaidThb,
    '大狗二狗本次支付 / 收回 (THB)': record.partnersPaidThb,
    '登记时月利润 (THB)': record.snapshotProfitThb,
    '登记时 jimmy 40% (THB)': record.snapshotJimmyThb,
    '登记时大狗二狗 60% (THB)': record.snapshotPartnersThb,
    '备注': record.note,
    '登记时间（曼谷）': new Date(record.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' })
  }))
  return { summary, records: buildTicketExportRows(report.records), refundRecords: buildRefundExportRows(report.records), settlementRecords }
}

export const exportShow79ToXlsx = async (tickets: TicketRecord[], date: string, month: string, settlements: Show79SettlementRecord[] = []) => {
  const rows = buildShow79ExportRows(tickets, date, month, settlements)
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  const append = (data: Record<string, string | number>[], name: string, headers?: string[]) => {
    const worksheet = XLSX.utils.json_to_sheet(data, headers ? { header: headers } : undefined)
    const keys = Object.keys(data[0] ?? Object.fromEntries((headers ?? []).map(header => [header, ''])))
    worksheet['!cols'] = keys.map(key => ({ wch: key === '备注' || key === '结算说明' ? 52 : key.includes('时间') || key === '客户姓名' ? 28 : Math.max(18, key.length * 2) }))
    if (worksheet['!ref']) {
      const range = XLSX.utils.decode_range(worksheet['!ref'])
      for (let column = 0; column < keys.length; column++) {
        if (!keys[column].includes('(THB)')) continue
        for (let row = 1; row <= range.e.r; row++) {
          const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })]
          if (cell?.t === 'n') cell.z = '#,##0.00;[Red]-#,##0.00'
        }
      }
    }
    XLSX.utils.book_append_sheet(workbook, worksheet, name)
  }
  append(rows.summary, '月度分账')
  append(rows.records, '79秀订单')
  if (rows.refundRecords.length) append(rows.refundRecords, '79秀退票明细')
  append(rows.settlementRecords, '分账登记明细', show79SettlementHeaders)
  XLSX.writeFile(workbook, `79秀独立报表_${month}.xlsx`)
}
