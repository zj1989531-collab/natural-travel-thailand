import type { Project, TicketInput } from '../types'
import { cleanProjectLabel } from './project-labels'

export interface MedicineTicketEntry {
  input: TicketInput
  operationId: string
}

export const isMedicineProject = (project: Pick<Project, 'name' | 'quantityUnit' | 'entryMode'>): boolean =>
  cleanProjectLabel(project.name).normalize('NFKC').replace(/\s+/g, '') === '药品' && project.quantityUnit === 'item' && project.entryMode !== 'profit_only'

/** Validate a single customer's batch without changing any submitted values. */
export function validateMedicineBatchShape(entries: MedicineTicketEntry[]): void {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('请至少选择一种药品。')
  const projects = new Set<string>()
  const operations = new Set<string>()
  let common: { guestName: string; issueDate: string; issueTime: string | null; note: string } | undefined
  entries.forEach((entry, index) => {
    const row = index + 1
    if (!entry || typeof entry !== 'object' || !entry.input || typeof entry.input !== 'object') throw new Error(`第${row}行药品记录不完整，请重新选择药品。`)
    if (typeof entry.operationId !== 'string' || !entry.operationId.trim()) throw new Error(`第${row}行缺少提交编号，请重新打开新增记录。`)
    const input = entry.input
    if (typeof input.projectId !== 'string' || !input.projectId.trim()) throw new Error(`第${row}行未选择有效的药品项目。`)
    const projectId = input.projectId.trim()
    const operationId = entry.operationId.trim()
    if (projects.has(projectId)) throw new Error('同一种药品不能重复添加，请合并数量后再保存。')
    if (operations.has(operationId)) throw new Error('药品记录的提交编号不能重复，请重新打开新增记录。')
    projects.add(projectId)
    operations.add(operationId)
    if (input.guestName != null && typeof input.guestName !== 'string') throw new Error(`第${row}行客户姓名无效。`)
    if (typeof input.note !== 'string') throw new Error(`第${row}行备注无效。`)
    const fields = { guestName: input.guestName?.trim() ?? '', issueDate: input.issueDate, issueTime: input.issueTime ?? null, note: input.note.trim() }
    if (common) {
      if (fields.guestName !== common.guestName) throw new Error('同一批药品的客户姓名必须一致。')
      if (fields.issueDate !== common.issueDate) throw new Error('同一批药品的出票日期必须一致。')
      if (fields.issueTime !== common.issueTime) throw new Error('同一批药品的出票时间必须一致。')
      if (fields.note !== common.note) throw new Error('同一批药品的备注必须一致。')
    } else common = fields
  })
}
