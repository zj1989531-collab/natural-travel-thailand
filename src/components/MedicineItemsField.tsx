import { useId } from 'react'
import type { Project } from '../types'
import { formatThb, MAX_PERSON_COUNT } from '../lib/format'
import { isMedicineProject } from '../lib/medicine-batch'
import { medicineLineAmounts, summariseMedicineLines, toggleMedicineProject, updateMedicineLine, type MedicineLine } from '../lib/medicine-selection'
import './medicine-items-field.css'

export interface MedicineItemsFieldProps {
  projects: Project[]
  lines: MedicineLine[]
  onChange: (lines: MedicineLine[]) => void
  disabled?: boolean
}

export function MedicineItemsField({ projects, lines, onChange, disabled = false }: MedicineItemsFieldProps) {
  const id = useId()
  const options = projects.filter(project => isMedicineProject(project) && !project.mergedIntoId)
  const summary = summariseMedicineLines(lines, options)
  const update = (projectId: string, changes: Partial<Omit<MedicineLine, 'projectId'>>) => {
    if (!disabled) onChange(updateMedicineLine(lines, projectId, changes))
  }
  return <section className="medicine-items-field" aria-label="药品多选明细">
    <fieldset className="medicine-options" disabled={disabled}>
      <legend>药品子项（可多选）</legend>
      <p>可同时勾选男、女等子项；每项分别填写数量和金额，供应商按各自子项带入。</p>
      {options.map(project => <label key={project.id}>
        <input type="checkbox" checked={lines.some(line => line.projectId === project.id)} onChange={event => { if (!disabled) onChange(toggleMedicineProject(lines, project, event.target.checked)) }} />
        <span><strong>{project.subItemName || '不分子项'}</strong><small>{project.supplierName}</small></span>
      </label>)}
      {!options.length && <p className="form-error" role="alert">当前没有可选药品子项，请先录入按件计算的药品价格。</p>}
    </fieldset>
    {!lines.length && <p className="medicine-selection-empty" role="status">请至少勾选1个药品子项，可同时选择多个。</p>}
    {lines.map((line, index) => {
      const project = options.find(option => option.id === line.projectId)
      const title = project ? `${project.subItemName || '不分子项'} · ${project.supplierName}` : '已移除的药品子项'
      const perItem = line.amountBasis === 'per_person'
      let amounts: ReturnType<typeof medicineLineAmounts> | null = null
      let problem = ''
      try { amounts = medicineLineAmounts(line) } catch (reason) { problem = reason instanceof Error ? reason.message : '请填写完整数量和金额。' }
      const prefix = `${id}-medicine-${index}`
      return <article className="medicine-line" key={line.projectId} aria-label={title}>
        <header><h3>{title}</h3><button type="button" className="text-action" aria-label={`移除 ${title}`} disabled={disabled} onClick={() => { if (!disabled) onChange(lines.filter(item => item.projectId !== line.projectId)) }}>移除</button></header>
        {!project && <p className="form-error" role="alert">此子项已从目录移除，请移除此项或重新选择。</p>}
        <p className="medicine-price-basis">{perItem ? '单件金额 × 件数，计算本项总额。' : '整单金额，不再乘件数；数量仍按件记录。'}{project?.manualAgentPrice && ' 售价需手动填写。'}</p>
        <label htmlFor={`${prefix}-quantity`}>数量（件）<input id={`${prefix}-quantity`} type="number" inputMode="numeric" min="1" max={MAX_PERSON_COUNT} step="1" required disabled={disabled || !project} value={typeof line.personCount === 'number' && Number.isFinite(line.personCount) ? line.personCount : ''} onChange={event => update(line.projectId, { personCount: event.target.value === '' ? null : Number(event.target.value) })} /></label>
        <div className="medicine-line-amounts">
          <label htmlFor={`${prefix}-sale`}>{perItem ? '单件售价' : '整单售价'}（THB）<input id={`${prefix}-sale`} type="number" inputMode="decimal" min="0" step="0.01" required disabled={disabled || !project} value={Number.isFinite(line.agentPriceThb) ? line.agentPriceThb : ''} onChange={event => update(line.projectId, { agentPriceThb: event.target.value === '' ? Number.NaN : Number(event.target.value) })} /></label>
          <label htmlFor={`${prefix}-cost`}>{perItem ? '单件成本' : '整单成本'}（THB）<input id={`${prefix}-cost`} type="number" inputMode="decimal" min="0" step="0.01" required disabled={disabled || !project} value={Number.isFinite(line.costThb) ? line.costThb : ''} onChange={event => update(line.projectId, { costThb: event.target.value === '' ? Number.NaN : Number(event.target.value) })} /></label>
        </div>
        <p className={`medicine-line-profit${amounts && amounts.profitThb < 0 ? ' is-loss' : ''}`}><span>本项总利润</span><strong>{amounts && project ? formatThb(amounts.profitThb) : '待填写完整'}</strong></p>
        {problem && <p className="medicine-line-help">{problem}</p>}
      </article>
    })}
    <section className="medicine-selection-summary" aria-label="药品合计">
      <p>已选 {summary.selectedCount} 项{summary.quantity != null ? ` · 合计 ${summary.quantity} 件` : ''}</p>
      {!summary.complete && lines.length > 0 && <p>请填写完整各项数量、售价和成本后核对合计。</p>}
      <dl><div><dt>总销售额</dt><dd>{summary.agentPriceThb == null ? '待填写完整' : formatThb(summary.agentPriceThb)}</dd></div><div><dt>总成本</dt><dd>{summary.costThb == null ? '待填写完整' : formatThb(summary.costThb)}</dd></div><div className={summary.profitThb != null && summary.profitThb < 0 ? 'is-loss' : ''}><dt>总利润</dt><dd>{summary.profitThb == null ? '待填写完整' : formatThb(summary.profitThb)}</dd></div></dl>
    </section>
  </section>
}
