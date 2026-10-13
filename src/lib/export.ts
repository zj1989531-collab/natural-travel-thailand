import type { TicketRecord } from '../types'
import { getProfit } from './stats'

export const exportTicketsToXlsx = async (tickets: TicketRecord[]) => {
  const XLSX = await import('xlsx')
  const rows = tickets
    .filter((ticket) => !ticket.deletedAt)
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt))
    .map((ticket) => ({
      '出票日期': ticket.issueDate,
      '供应商': ticket.supplierName,
      '项目': ticket.projectName || '未分类项目',
      '代理售价 (THB)': ticket.agentPriceThb,
      '供货商成本 (THB)': ticket.costThb,
      '利润 (THB)': getProfit(ticket),
      '备注': ticket.note,
      '创建时间': new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' })
    }))
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.json_to_sheet(rows)
  worksheet['!cols'] = [
    { wch: 14 }, { wch: 20 }, { wch: 18 }, { wch: 20 }, { wch: 16 }, { wch: 32 }, { wch: 23 }
  ]
  XLSX.utils.book_append_sheet(workbook, worksheet, '出票记录')
  XLSX.writeFile(workbook, `票务盈利簿_${new Date().toISOString().slice(0, 10)}.xlsx`)
}
