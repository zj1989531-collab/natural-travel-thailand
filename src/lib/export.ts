import type { Project, Supplier, TicketRecord } from '../types'
import { getBangkokDate } from './format'
import { getProfit } from './stats'

const pickFields = <T, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.map((key) => [key, record[key]])) as Pick<T, K>

export const createLedgerBackup = (data: { suppliers: Supplier[]; projects: Project[]; tickets: TicketRecord[] }, exportedAt = new Date().toISOString()) => {
  const owners = new Set([...data.suppliers, ...data.projects, ...data.tickets].map((record) => record.userId))
  if (owners.size > 1) throw new Error('账号正在切换，请稍后重新备份，避免混合不同账号的资料。')
  return {
    format: 'ticket-profit-ledger',
    version: 1,
    currency: 'THB',
    timeZone: 'Asia/Bangkok',
    exportedAt,
    // Explicit fields exclude authentication sessions and any future secret fields.
    suppliers: data.suppliers.map((record) => pickFields(record, ['id', 'userId', 'name', 'normalizedName', 'createdAt', 'updatedAt', 'syncStatus'])),
    projects: data.projects.map((record) => pickFields(record, ['id', 'userId', 'supplierId', 'supplierName', 'name', 'normalizedName', 'subItemName', 'normalizedSubItemName', 'entryMode', 'defaultCostThb', 'defaultAgentPriceThb', 'createdAt', 'updatedAt', 'syncStatus'])),
    // Include deletion markers so a backup does not resurrect deleted tickets.
    tickets: data.tickets.map((record) => pickFields(record, ['id', 'userId', 'issueDate', 'issueTime', 'entryMode', 'manualProfitThb', 'supplierId', 'supplierName', 'projectId', 'projectName', 'subItemName', 'agentPriceThb', 'costThb', 'note', 'createdAt', 'updatedAt', 'deletedAt', 'syncStatus']))
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

export const exportTicketsToXlsx = async (tickets: TicketRecord[]) => {
  const XLSX = await import('xlsx')
  const rows = tickets
    .filter((ticket) => !ticket.deletedAt)
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt))
    .map((ticket) => ({
      '出票日期': ticket.issueDate,
      '曼谷时间': ticket.issueTime || '',
      '记录类型': ticket.entryMode === 'profit_only' ? '月结返佣（仅录利润）' : '出票',
      '供应商': ticket.supplierName,
      '项目': ticket.projectName || '未分类项目',
      '代理售价 (THB)': ticket.entryMode === 'profit_only' ? '' : ticket.agentPriceThb,
      '供货商成本 (THB)': ticket.entryMode === 'profit_only' ? '' : ticket.costThb,
      '利润 (THB)': getProfit(ticket),
      '备注': ticket.note,
      '创建时间': new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' })
    }))
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.json_to_sheet(rows)
  worksheet['!cols'] = [
    { wch: 14 }, { wch: 12 }, { wch: 24 }, { wch: 20 }, { wch: 30 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 32 }, { wch: 23 }
  ]
  XLSX.utils.book_append_sheet(workbook, worksheet, '出票记录')
  XLSX.writeFile(workbook, `票务盈利簿_${new Date().toISOString().slice(0, 10)}.xlsx`)
}
