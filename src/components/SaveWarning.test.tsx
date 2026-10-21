import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SaveWarning } from './SaveWarning'
import { SupplierSheet, TicketForm } from '../App'
import type { Project, TicketRecord } from '../types'

const project: Project = { id: 'p', userId: 'u', name: '泰拳', normalizedName: '泰拳', supplierId: 's', supplierName: '供货商', subItemName: '', normalizedSubItemName: '', defaultCostThb: 1, defaultAgentPriceThb: 2, defaultAmountBasis: 'per_person', settlementMode: 'monthly', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', syncStatus: 'synced' }
describe('rule and warning controls', () => {
  it('renders a single confirmation with no accidental form submission buttons', () => {
    const html = renderToStaticMarkup(<SaveWarning messages={['疑似重复', '预计亏损']} saving={false} onBack={() => {}} onContinue={() => {}} />)
    for (const text of ['role="alertdialog"', '返回核对', '确认仍要保存', '疑似重复', '预计亏损']) expect(html).toContain(text)
    expect(html).not.toContain('type="submit"')
    expect(renderToStaticMarkup(<SaveWarning messages={['核对']} saving onBack={() => {}} onContinue={() => {}} />)).toContain('disabled=""')
  })
  it('keeps a historical ticket daily with saved total and amounts despite a monthly per-person catalogue', () => {
    const ticket: TicketRecord = { id: 't', userId: 'u', supplierId: 's', supplierName: project.supplierName, projectId: 'p', projectName: '泰拳', subItemName: '', issueDate: '2026-10-01', personCount: 4, amountBasis: 'total', settlementMode: 'daily', costThb: 600, agentPriceThb: 650, note: '', createdAt: project.createdAt, updatedAt: project.updatedAt, deletedAt: null, syncStatus: 'synced' }
    const html = renderToStaticMarkup(<TicketForm ticket={ticket} projects={[project]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    for (const text of ['日结（计入每日、月度和年度利润）', '保留此记录原结算归属', '฿50.00', 'value="total" selected=""', 'value="650"', 'value="600"']) expect(html).toContain(text)
    expect(html).not.toContain('value="per_person" selected=""')
  })
  it('exposes package default controls and allows commission rule editing too', () => {
    const html = renderToStaticMarkup(<SupplierSheet suppliers={[]} projects={[{ ...project, entryMode: 'profit_only' }]} onAddSupplier={async () => {}} onAddProject={async () => {}} onUpdateProject={async () => {}} onBackup={async () => {}} onClose={() => {}} />)
    for (const text of ['默认计价', '结算方式', '编辑设置', '仅录利润 · 月结']) expect(html).toContain(text)
  })
})
