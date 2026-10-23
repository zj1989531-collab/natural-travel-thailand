import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { createLedgerBackup, downloadLedgerBackup, exportTicketsToXlsx } from './lib/export'
import { createId, formatDate, formatNumber, formatThb, getBangkokDate, getBangkokTime, isValidIssueTime, isValidPersonCount } from './lib/format'
import { PersonCountField } from './components/PersonCountField'
import { MedicineItemsField } from './components/MedicineItemsField'
import { buildMedicineTicketInputs, createMedicineLine, type MedicineLine } from './lib/medicine-selection'
import { isMedicineProject, type MedicineTicketEntry } from './lib/medicine-batch'
import { ReportView } from './components/ReportView'
import { RefundHistory, RefundSheet } from './components/RefundSheet'
import { DashboardLogo } from './components/DashboardLogo'
import { SummaryPanel } from './components/SummaryPanel'
import { ProfitTrendPanel } from './components/ProfitTrendPanel'
import { useBangkokDate } from './lib/bangkok-clock'
import { BottomNavigation } from './components/BottomNavigation'
import { Show79View } from './components/Show79View'
import { Show69View } from './components/Show69View'
import { isShow69Project, type Show69RecordInput } from './lib/show69'
import { isBoxingProject } from './lib/boxing'
import { MonthlyTicketsView } from './components/MonthlyTicketsView'
import { SyncConflictPanel } from './components/SyncConflictPanel'
import type { SyncConflictRecord } from './lib/sync-conflicts'
import { isShow79Project, mainLedgerTickets } from './lib/show79'
import type { Show79SettlementInput, Show79SettlementRecord } from './lib/show79-settlement'
import { ProjectPicker } from './components/ProjectPicker'
import { TicketQuickFill } from './components/TicketQuickFill'
import { useDialog } from './lib/use-dialog'
import { readFinancialSubmission } from './lib/financial-submission'
import './components/ticket-entry.css'
import { SaveWarning } from './components/SaveWarning'
import { projectPriceWarnings, ticketWarnings, validateDraftAmounts } from './lib/entry-warnings'
import { resolveProjectRules, ticketSettlementMode } from './lib/project-rules'
import { filterProjects } from './lib/project-search'
import { matchesTicketSearch, type TicketDateRange } from './lib/ticket-search'
import { quantityParts, summariseQuantities } from './lib/effective-quantities'
import { quantityLabels } from './lib/quantity'
import { ticketDisplay } from './lib/project-labels'
import { getEffectivePersonCount, getRefundState } from './lib/refunds'
import { getTicketAmounts, validateAmountPrecision } from './lib/ticket-amounts'
import { ledgerRepository } from './lib/repository'
import { cloudConfigured, getSupabase } from './lib/supabase'
import { canWriteLedger, createSyncQueue, type SyncQueue } from './lib/sync'
import { chooseProject, chooseProjectOption } from './lib/project-selection'
import { activeTickets, bySupplier, getProfit, monthDateRange, summarise, ticketsForDailyStats, ticketsInMonth, ticketsInYear, yearDateRange } from './lib/stats'
import type { AmountBasis, EntryMode, Project, ProjectInput, ProjectPricesInput, QuantityUnit, RefundInput, SettlementMode, Supplier, TicketInput, TicketRecord } from './types'

type View = 'dashboard' | 'records' | 'reports' | 'monthly' | 'show69' | 'show79' | 'boxing'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface TicketFormProps {
  suppliers?: Supplier[]
  ticket?: TicketRecord
  projects: Project[]
  knownTickets?: TicketRecord[]
  cloudLoginRequired: boolean
  onCancel: () => void
  onManageSuppliers: () => void
  onSave: (input: TicketInput, operationId?: string) => Promise<void>
  onSaveMedicine?: (entries: MedicineTicketEntry[]) => Promise<void>
  onShow69?: (input: Show69RecordInput) => void
  onBoxing?: (input: Show69RecordInput) => void
}

const emptyForm = (): TicketInput => ({
  guestName: '',
  quantityUnit: 'person',
  amountBasis: 'per_person',
  personCount: 1,
  issueDate: getBangkokDate(),
  issueTime: getBangkokTime(),
  entryMode: 'standard',
  manualProfitThb: null,
  supplierName: '',
  projectId: '',
  projectName: '',
  subItemName: '',
  agentPriceThb: Number.NaN,
  costThb: Number.NaN,
  note: ''
})

export function TicketForm({ ticket, projects, suppliers = [], knownTickets = [], cloudLoginRequired, onCancel, onManageSuppliers, onSave, onSaveMedicine, onShow69, onBoxing }: TicketFormProps) {
  const [form, setForm] = useState<TicketInput>(() => ticket ? {
    guestName: ticket.guestName ?? '',
    quantityUnit: ticket.quantityUnit ?? 'person',
    amountBasis: ticket.amountBasis ?? 'total',
    settlementMode: ticket.settlementMode,
    personCount: ticket.personCount ?? null,
    issueDate: ticket.issueDate,
    issueTime: ticket.issueTime ?? '',
    entryMode: ticket.entryMode ?? 'standard',
    manualProfitThb: ticket.manualProfitThb ?? null,
    supplierName: ticket.supplierName,
    projectId: ticket.projectId ?? '',
    projectName: ticket.projectName || '',
    subItemName: ticket.subItemName ?? '默认套餐',
    agentPriceThb: ticket.agentPriceThb,
    costThb: ticket.costThb,
    note: ticket.note
  } : emptyForm())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const saveLock = useRef(false)
  const operationRef = useRef<string | undefined>(undefined)
  const [medicineLines, setMedicineLines] = useState<MedicineLine[]>([])
  const medicineOperationRef = useRef<MedicineTicketEntry[] | null>(null)
  const [pendingMedicineSave, setPendingMedicineSave] = useState(false)
  const [filling, setFilling] = useState(false)
  const fillLock = useRef(false)
  const onFillBusy = useCallback((busy: boolean) => { fillLock.current = busy; setFilling(busy) }, [])
  const [warning, setWarning] = useState<{ messages: string[]; key: string } | null>(null)
  const moreSettingsRef = useRef<HTMLDetailsElement>(null)
  const timeInputRef = useRef<HTMLInputElement>(null)
  const medicineMode = !ticket && (pendingMedicineSave || isMedicineProject({ name: form.projectName, quantityUnit: 'item', entryMode: 'standard' }) && projects.some(isMedicineProject))

  const applyFilledForm = (next: TicketInput) => {
    if (saveLock.current || pendingMedicineSave) return
    if (!ticket && isShow69Project(next.projectName) && onShow69) {
      onShow69({ date: next.issueDate, guestName: next.guestName ?? '', people: next.personCount ?? 1 })
      return
    }
    if (!ticket && isBoxingProject(next.projectName) && onBoxing) {
      onBoxing({ date: next.issueDate, guestName: next.guestName ?? '', people: next.personCount ?? 1 })
      return
    }
    setWarning(null); setError(''); setForm(next)
    const selected = projects.find(row => row.id === next.projectId)
    setMedicineLines(!ticket && selected && isMedicineProject(selected) ? [{ ...createMedicineLine(selected), personCount: next.personCount ?? 1, amountBasis: next.amountBasis ?? resolveProjectRules(selected).defaultAmountBasis, agentPriceThb: next.agentPriceThb, costThb: next.costThb }] : [])
  }

  const requestCancel = () => {
    if (saveLock.current) return
    if (pendingMedicineSave && !window.confirm('本次保存结果尚未确认，建议先重试确认，避免重复新增。仍要关闭吗？')) return
    onCancel()
  }
  const dialogRef = useDialog(requestCancel)

  const update = <K extends keyof TicketInput>(key: K, value: TicketInput[K]) => {
    if (saveLock.current || fillLock.current || pendingMedicineSave) return
    setWarning(null)
    setError('')
    setForm((current) => ({ ...current, [key]: value }))
  }

  const attemptMedicineSave = async (acknowledgedKey?: string) => {
    if (saveLock.current || fillLock.current) return
    setError('')
    try {
      if (!onSaveMedicine) throw new Error('药品多选保存尚未打开，请刷新页面重试。')
      let entries = medicineOperationRef.current
      if (!entries) {
        if (!form.issueDate || !form.issueTime || !isValidIssueTime(form.issueTime)) {
          if (moreSettingsRef.current) moreSettingsRef.current.open = true
          timeInputRef.current?.focus()
          throw new Error('请填写有效的出票日期和曼谷时间。')
        }
        const inputs = buildMedicineTicketInputs(form, medicineLines, projects)
        const checks = inputs.map(input => ticketWarnings(input, projects.find(row => row.id === input.projectId), knownTickets))
        const messages = checks.flatMap((check, index) => check.messages.map(message => `${inputs[index].subItemName || '药品子项'}：${message}`))
        const key = JSON.stringify(checks.map(check => check.key))
        if (messages.length && acknowledgedKey !== key) { setWarning({ messages, key }); return }
        entries = inputs.map(input => ({ input, operationId: createId() }))
        medicineOperationRef.current = entries
      }
      setWarning(null); saveLock.current = true; setSaving(true)
      await onSaveMedicine(entries)
    } catch (saveError) {
      const pending = Boolean(medicineOperationRef.current)
      setPendingMedicineSave(pending)
      setError(`${saveError instanceof Error ? saveError.message : '保存未完成。'}${pending ? ' 重试将使用本次原始内容，请勿重复新增。' : ''}`)
      setWarning(null)
    } finally { saveLock.current = false; setSaving(false) }
  }

  const attemptSave = async (acknowledgedKey?: string) => {
    if (medicineMode) { await attemptMedicineSave(acknowledgedKey); return }
    if (saveLock.current || fillLock.current) return
    setError('')
    const supplierName = form.supplierName.trim()
    if (!form.issueDate || !supplierName || !form.projectId) {
      setError('请填写出票日期，并选择项目及适用的套餐；供货商会自动带入。')
      return
    }
    if ((!ticket && !form.issueTime) || (form.issueTime && !isValidIssueTime(form.issueTime))) {
      setError('请填写有效的曼谷时间（HH:mm）。')
      if (moreSettingsRef.current) moreSettingsRef.current.open = true
      timeInputRef.current?.focus()
      return
    }
    if (form.personCount == null ? !ticket || ticket.personCount != null : !isValidPersonCount(form.personCount)) {
      setError(`${quantityLabels(form).label}必须是大于或等于1的整数。`)
      return
    }
    if (form.entryMode === 'profit_only' ? typeof form.manualProfitThb !== 'number' || !Number.isFinite(form.manualProfitThb) || form.manualProfitThb < 0 : !Number.isFinite(form.agentPriceThb) || !Number.isFinite(form.costThb) || form.agentPriceThb < 0 || form.costThb < 0) {
      setError(form.entryMode === 'profit_only' ? '请填写大于或等于0的利润金额。' : '实收和成本必须是大于或等于0的金额。')
      return
    }
    try {
      validateDraftAmounts(form)
      const project = projects.find(row => row.id === form.projectId)
      if (!project) throw new Error('所选套餐已不存在，请重新选择。')
      const chosenSupplier = project.manualSupplier ? suppliers.find(row => row.name === supplierName && row.userId === project.userId) : undefined
      if (project.manualSupplier && !chosenSupplier) throw new Error('请自行选择已录入的供货商。')
      const check = ticketWarnings(form, project, knownTickets, ticket?.id, chosenSupplier?.id ?? project.supplierId)
      if (check.messages.length && acknowledgedKey !== check.key) {
        setWarning(check)
        return
      }
      saveLock.current = true
      setSaving(true)
      operationRef.current ??= createId()
      await onSave({ ...form, supplierName }, operationRef.current)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试。')
      setWarning(null)
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }

  const selectProject = (select: (current: TicketInput) => TicketInput) => {
    if (saveLock.current || fillLock.current || pendingMedicineSave) return
    let next = select(form)
    if (ticket && next.projectId === ticket.projectId) next = { ...next, settlementMode: ticket.settlementMode, quantityUnit: ticket.quantityUnit ?? 'person', entryMode: ticket.entryMode ?? 'standard' }
    applyFilledForm(next)
  }

  const perPerson = form.amountBasis === 'per_person'
  const { label: countLabel, single } = quantityLabels(form)
  const manualAgentPrice = projects.find((project) => project.id === form.projectId)?.manualAgentPrice
  const manualCostPrice = projects.find((project) => project.id === form.projectId)?.manualCostPrice
  const manualSupplier = projects.find((project) => project.id === form.projectId)?.manualSupplier
  const amountsComplete = form.entryMode === 'profit_only' ? Number.isFinite(form.manualProfitThb) : Number.isFinite(form.agentPriceThb) && Number.isFinite(form.costThb)
  const totals = getTicketAmounts(form)
  const profit = totals.profitThb

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={requestCancel}>
      <section ref={dialogRef} tabIndex={-1} className="sheet ticket-entry-sheet" aria-modal="true" aria-labelledby="ticket-form-title" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div>
            <p className="eyebrow">THB · 自动计算利润</p>
            <h2 id="ticket-form-title">{ticket ? '编辑记录' : '新增出票记录'}</h2>
          </div>
          <button className="icon-button" type="button" disabled={saving} onClick={requestCancel} aria-label="关闭">×</button>
        </div>
        {cloudLoginRequired && <p className="sheet-copy">保存前请登录云端账号，之后记录和价格修改会自动同步到电脑与手机。</p>}
        <form className="ticket-form" onInvalidCapture={event => {
          const details = (event.target as HTMLElement).closest('details')
          if (details) details.open = true
        }} onSubmit={event => { event.preventDefault(); void attemptSave() }}>
          {!ticket && <TicketQuickFill projects={projects} current={form} disabled={saving || pendingMedicineSave} onBusyChange={onFillBusy} onFill={applyFilledForm} onShow69={onShow69} onBoxing={onBoxing} />}
          {medicineMode && <section className="ticket-order-summary" aria-label="订单核对摘要"><p><strong>{form.guestName?.trim() || '姓名未填写'}</strong> · {form.issueDate.replaceAll('-', '/')}</p><p>药品 · 已选 {medicineLines.length} 项，各子项数量和利润分别统计。</p></section>}
          {!medicineMode && form.projectId && <section className={`ticket-order-summary${amountsComplete && profit < 0 ? ' is-loss' : ''}`} aria-label="订单核对摘要">
            <p><strong>{form.guestName?.trim() || '姓名未填写'}</strong> · {form.issueDate.replaceAll('-', '/')} · {form.personCount == null ? `${countLabel}未填写` : `${formatNumber(form.personCount)}${quantityLabels(form).unit}`}</p>
            <p className="ticket-order-project">{form.projectName}{form.subItemName ? ` · ${form.subItemName}` : ''}</p>
            <p className="ticket-order-basis">{perPerson ? `按${countLabel}计算 · ${single}金额 × ${countLabel}` : '整单总额 · 不乘人数／数量'}{form.entryMode === 'profit_only'
              ? ` · ${perPerson ? single : '整单'}返佣 ${typeof form.manualProfitThb === 'number' && Number.isFinite(form.manualProfitThb) ? formatThb(form.manualProfitThb) : '待填写'}`
              : ` · ${perPerson ? single : '整单'}售价 ${Number.isFinite(form.agentPriceThb) ? formatThb(form.agentPriceThb) : '待填写'} · ${perPerson ? single : '整单'}成本 ${Number.isFinite(form.costThb) ? formatThb(form.costThb) : '待填写'}`}</p>
            <p className="ticket-order-profit"><span>{form.entryMode === 'profit_only' ? '本次月结总利润' : '本次总利润'}</span><strong>{amountsComplete ? formatThb(profit) : manualCostPrice ? '待填写金额' : manualAgentPrice ? '待填写售价' : '待填写金额'}</strong></p>
          </section>}
          <fieldset className="form-fields" disabled={saving || filling || pendingMedicineSave}>
          <label>
            出票日期
            <input type="date" value={form.issueDate} onChange={(event) => update('issueDate', event.target.value)} required />
          </label>
          <label>客户姓名 <span className="muted">（可选）</span><input value={form.guestName ?? ''} maxLength={100} onChange={event => update('guestName', event.target.value)} /></label>
          {!medicineMode && <PersonCountField quantityUnit={form.quantityUnit} value={form.personCount} allowUnknown={Boolean(ticket && ticket.personCount == null && !perPerson)} multiplyAmounts={perPerson} onChange={(value) => update('personCount', value)} />}
          {ticket && !perPerson && <p className="sheet-copy">旧记录保留原总额；如切换为按{countLabel}计算，请先核对并填写{single}金额。</p>}
          <ProjectPicker projects={projects} form={form}
            selectedOptionIds={medicineMode ? medicineLines.map(line => line.projectId) : []}
            renderOptions={medicineMode ? choices => <MedicineItemsField projects={choices} lines={medicineLines} disabled={saving || filling || pendingMedicineSave} onChange={lines => { if (saveLock.current || fillLock.current || pendingMedicineSave) return; setMedicineLines(lines); setWarning(null); setError('') }} /> : undefined}
            onName={name => selectProject(current => chooseProject(current, projects, name))}
            onOption={(id, name) => selectProject(current => chooseProjectOption({ ...current, projectName: name ?? current.projectName }, projects, id))} />
          {!medicineMode && (manualSupplier ? <label>供货商<select value={form.supplierName} onChange={event => update('supplierName', event.target.value)} required><option value="">请自行选择供货商</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.name}>{supplier.name}</option>)}</select></label> : form.supplierName && <p className="sheet-copy">供货商：{form.supplierName}（自动带入）</p>)}
          {!medicineMode && (manualCostPrice ? <p className="sheet-copy">成本不预设，请填写本次{perPerson ? single : '整单'}成本{manualAgentPrice ? '及代理售价' : '；售价已自动带入'}。</p> : manualAgentPrice && <p className="sheet-copy">售价不预设，请填写本次{perPerson ? single : '整单'}售价；成本已自动带入。</p>)}
          {isShow79Project(form.projectName) && <p className="sheet-copy">79秀独立记账，不计入主账本日报、月报、年报；请前往79秀页面查看分账。</p>}
          {!medicineMode && !isShow69Project(form.projectName) && !isShow79Project(form.projectName) && !isBoxingProject(form.projectName) && form.projectId && <p className="sheet-copy">结算方式：{ticketSettlementMode(form) === 'monthly' ? '月结（计入所属月报、年报，不计每日概览）' : '日结（计入每日、月度和年度利润）'}{ticket && '；保留此记录原结算归属。'}</p>}
          {form.entryMode === 'profit_only' && <p className="sheet-copy">{perPerson ? '只填写单人返佣利润，系统按人数计算返佣总额。' : '只填写本次返佣总额，不填写售价或成本。'}请勿重复录入已统计的项目利润。</p>}
          {projects.length === 0 && <button className="inline-action" type="button" onClick={onManageSuppliers}>还没有项目价格，去录入</button>}
          {!medicineMode && (form.entryMode === 'profit_only' ? <label>{perPerson ? '单人返佣利润（THB）' : '返佣总额（THB）'}<input inputMode="decimal" type="number" min="0" step="0.01" value={form.manualProfitThb ?? ''} onChange={(event) => update('manualProfitThb', event.target.value === '' ? null : Number(event.target.value))} required /></label> : <div className="form-grid">
            <label>
              {perPerson ? `${single}代理售价（THB）` : '代理售价总额（THB）'}
              <input inputMode="decimal" min="0" step="0.01" type="number" value={Number.isFinite(form.agentPriceThb) ? form.agentPriceThb : ''} onChange={(event) => update('agentPriceThb', event.target.value === '' ? Number.NaN : Number(event.target.value))} required />
            </label>
            <label>
              {perPerson ? `${single}供货商成本（THB）` : '供货商成本总额（THB）'}
              <input inputMode="decimal" min="0" step="0.01" type="number" value={Number.isFinite(form.costThb) ? form.costThb : ''} onChange={(event) => update('costThb', event.target.value === '' ? Number.NaN : Number(event.target.value))} required />
            </label>
          </div>)}
          {!medicineMode && form.entryMode !== 'profit_only' && amountsComplete && <p className="sheet-copy">总售价 {formatThb(totals.agentPriceThb)} · 总成本 {formatThb(totals.costThb)}</p>}
          {ticket && !ticket.issueTime && <p className="muted">旧记录未记录时间，可在“更多设置”中手动补填。</p>}
          <details className="ticket-more-settings" ref={moreSettingsRef}>
            <summary>更多设置 · 时间 / 计价方式 / 备注</summary>
            <label>
              时间（曼谷 UTC+7）
              <input ref={timeInputRef} type="time" step="60" value={form.issueTime ?? ''} onChange={(event) => update('issueTime', event.target.value)} required={!ticket || Boolean(ticket.issueTime)} />
            </label>
            {!medicineMode && <label>
              计价方式
              <select value={form.amountBasis} onChange={(event) => update('amountBasis', event.target.value as AmountBasis)}>
                <option value="per_person">按{countLabel}计算（{single}金额 × {countLabel}）</option>
                <option value="total">整单总额（不乘{countLabel}）</option>
              </select>
            </label>}
          <label>
            备注 <span className="muted">（可选）</span>
            <textarea maxLength={300} placeholder="例如航线、特殊说明" value={form.note} onChange={(event) => update('note', event.target.value)} />
          </label>
          </details>
          </fieldset>
          <div className="ticket-save-area">
          {error && <p className="form-error" role="alert">{error}</p>}
          {warning && <SaveWarning messages={warning.messages} saving={saving || filling} onBack={() => setWarning(null)} onContinue={() => void attemptSave(warning.key)} />}
          {!warning && <div className="sheet-actions">
            <button className="secondary-button" type="button" disabled={saving} onClick={requestCancel}>取消</button>
            <button className="primary-button" type="submit" disabled={saving || filling}>{saving ? '保存中…' : cloudLoginRequired ? '登录后保存' : pendingMedicineSave ? '重试本次保存' : '保存记录'}</button>
          </div>}
          </div>
        </form>
      </section>
    </div>
  )
}

export function SupplierSheet({ suppliers, projects, onAddSupplier, onAddProject, onUpdateProject, onBackup, onClose }: {
  suppliers: Supplier[]
  projects: Project[]
  onAddSupplier: (name: string) => Promise<void>
  onAddProject: (input: ProjectInput) => Promise<void>
  onUpdateProject: (id: string, input: ProjectPricesInput) => Promise<void>
  onBackup: () => Promise<void>
  onClose: () => void
}) {
  const [supplierName, setSupplierName] = useState('')
  const [projectSupplierId, setProjectSupplierId] = useState('')
  const [projectName, setProjectName] = useState('')
  const [subItemName, setSubItemName] = useState('')
  const [cost, setCost] = useState('')
  const [agentPrice, setAgentPrice] = useState('')
  const [entryMode, setEntryMode] = useState<EntryMode>('standard')
  const [manualAgentPrice, setManualAgentPrice] = useState(false)
  const [manualCostPrice, setManualCostPrice] = useState(false)
  const [manualSupplier, setManualSupplier] = useState(false)
  const [quantityUnit, setQuantityUnit] = useState<QuantityUnit>('person')
  const [defaultAmountBasis, setDefaultAmountBasis] = useState<AmountBasis | null>(null)
  const [settlementMode, setSettlementMode] = useState<SettlementMode | null>(null)
  const [priceWarning, setPriceWarning] = useState<{ messages: string[]; key: string } | null>(null)
  const projectSaveLock = useRef(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const projectFormRef = useRef<HTMLFormElement>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<'supplier' | 'project' | null>(null)
  const supplierBusy = useRef(false)
  supplierBusy.current = saving !== null
  const requestClose = () => { if (!supplierBusy.current && !projectSaveLock.current) onClose() }
  const dialogRef = useDialog(requestClose)
  const [priceQuery, setPriceQuery] = useState('')
  const [priceSupplierId, setPriceSupplierId] = useState('')
  const filteredProjects = filterProjects(projects, priceQuery, priceSupplierId)
  const projectRules = resolveProjectRules({ name: projectName, subItemName, entryMode, quantityUnit, defaultAmountBasis, settlementMode })

  useEffect(() => { setPriceWarning(null) }, [projectSupplierId, projectName, subItemName, entryMode, quantityUnit, defaultAmountBasis, settlementMode, cost, agentPrice, manualAgentPrice, manualCostPrice, manualSupplier])

  useEffect(() => {
    if (editingProject) projectFormRef.current?.scrollIntoView({ block: 'nearest' })
  }, [editingProject])

  const addSupplier = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving('supplier')
    setError('')
    try {
      await onAddSupplier(supplierName)
      setSupplierName('')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试。')
    } finally {
      setSaving(null)
    }
  }

  const saveProject = async (acknowledgedKey?: string) => {
    if (projectSaveLock.current || saving !== null) return
    setError('')
    try {
      if ((!manualSupplier && !projectSupplierId) || !projectName.trim()) throw new Error('请选择供货商并填写项目名称。')
      const defaultCostThb = entryMode === 'profit_only' || manualCostPrice ? 0 : cost.trim() ? Number(cost) : NaN
      const defaultAgentPriceThb = entryMode === 'profit_only' || manualAgentPrice ? 0 : agentPrice.trim() ? Number(agentPrice) : NaN
      if (![defaultCostThb, defaultAgentPriceThb].every(value => Number.isFinite(value) && value >= 0)) throw new Error('请填写大于或等于0的有效金额。')
      validateAmountPrecision([defaultCostThb, defaultAgentPriceThb])
      const messages = projectPriceWarnings(defaultCostThb, defaultAgentPriceThb, manualAgentPrice || manualCostPrice, entryMode === 'profit_only')
      const key = JSON.stringify([editingProject?.id, projectSupplierId, manualSupplier, projectName, subItemName, entryMode, quantityUnit, projectRules, cost, agentPrice, manualAgentPrice, manualCostPrice])
      if (messages.length && acknowledgedKey !== key) { setPriceWarning({ messages, key }); return }
      projectSaveLock.current = true
      setSaving('project')
      if (editingProject) {
        await onUpdateProject(editingProject.id, { defaultCostThb, defaultAgentPriceThb, manualAgentPrice, manualCostPrice, quantityUnit, ...projectRules })
      } else {
        await onAddProject({ supplierId: projectSupplierId, manualSupplier, name: projectName, subItemName, entryMode, quantityUnit, manualAgentPrice, manualCostPrice, defaultCostThb, defaultAgentPriceThb, ...projectRules })
      }
      setProjectName('')
      setSubItemName('')
      setCost('')
      setAgentPrice('')
      setEditingProject(null)
      setEntryMode('standard')
      setManualAgentPrice(false); setManualCostPrice(false); setManualSupplier(false); setQuantityUnit('person')
      setDefaultAmountBasis(null); setSettlementMode(null); setPriceWarning(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试。')
      setPriceWarning(null)
    } finally {
      projectSaveLock.current = false
      setSaving(null)
    }
  }

  const editProject = (project: Project) => {
    setEditingProject(project)
    setManualSupplier(project.manualSupplier ?? false)
    setEntryMode(project.entryMode ?? 'standard')
    setProjectSupplierId(project.supplierId)
    setProjectName(project.name)
    setSubItemName(project.subItemName)
    setCost(String(project.defaultCostThb))
    setAgentPrice(String(project.defaultAgentPriceThb))
    setManualAgentPrice(project.manualAgentPrice ?? false); setManualCostPrice(project.manualCostPrice ?? false); setQuantityUnit(project.quantityUnit ?? 'person')
    const rules = resolveProjectRules(project)
    setDefaultAmountBasis(rules.defaultAmountBasis); setSettlementMode(rules.settlementMode); setPriceWarning(null)
    setError('')
  }

  const cancelProjectEdit = () => {
    setEditingProject(null)
    setEntryMode('standard')
    setManualAgentPrice(false); setManualCostPrice(false); setManualSupplier(false); setQuantityUnit('person')
    setDefaultAmountBasis(null); setSettlementMode(null); setPriceWarning(null)
    setProjectName('')
    setSubItemName('')
    setCost('')
    setAgentPrice('')
    setError('')
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={requestClose}>
      <section ref={dialogRef} tabIndex={-1} className="sheet compact-sheet" aria-modal="true" aria-labelledby="supplier-sheet-title" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div><p className="eyebrow">预先维护价格表</p><h2 id="supplier-sheet-title">供货商与项目</h2></div>
          <button className="icon-button" type="button" disabled={saving !== null} onClick={requestClose} aria-label="关闭">×</button>
        </div>
        <p className="sheet-copy">先添加供货商，再为每个项目建立子项/套餐、成本和代理售价。出票时选择子项会自动带入这两个价格。</p>
        <button className="secondary-button full-width" type="button" onClick={() => void onBackup()} disabled={saving !== null}>导出全部资料备份</button>

        <section className="management-section">
          <h3>1. 添加供货商</h3>
          <form className="supplier-form" onSubmit={addSupplier}>
            <input autoComplete="off" placeholder="输入供货商名称" value={supplierName} onChange={(event) => setSupplierName(event.target.value)} required />
            <button className="primary-button" type="submit" disabled={saving !== null}>{saving === 'supplier' ? '保存中…' : '添加'}</button>
          </form>
        </section>

        <section className="management-section">
          <h3>{editingProject ? '2. 修改项目价格' : '2. 录入项目与子项价格'}</h3>
          {editingProject && <p className="sheet-copy">只更新此套餐的默认价格和规则，不影响历史出票金额、数量、结算及退票归属。</p>}
          <form className="project-form" ref={projectFormRef} onSubmit={event => { event.preventDefault(); void saveProject() }}>
            <fieldset className="form-fields" disabled={saving !== null}>
            <label className="checkbox-label"><input type="checkbox" checked={manualSupplier} onChange={event => setManualSupplier(event.target.checked)} disabled={editingProject !== null} />出票时再选择供货商（不预设）</label>
            <select value={manualSupplier ? '' : projectSupplierId} onChange={(event) => setProjectSupplierId(event.target.value)} required={!manualSupplier} disabled={editingProject !== null || manualSupplier}>
              <option value="">选择供货商</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
            <input autoComplete="off" placeholder="项目名称，例如：曼谷往返机票" value={projectName} onChange={(event) => setProjectName(event.target.value)} required readOnly={editingProject !== null} />
            <input autoComplete="off" placeholder="子项/套餐名称（可选，例如：经济舱）" value={subItemName} onChange={(event) => setSubItemName(event.target.value)} readOnly={editingProject !== null} />
            {!editingProject && <label>记账方式<select value={entryMode} onChange={(event) => setEntryMode(event.target.value as EntryMode)}><option value="standard">售价减成本</option><option value="profit_only">仅录利润（月结返佣）</option></select></label>}
            {entryMode !== 'profit_only' && <><label>数量单位<select value={quantityUnit} onChange={(event) => setQuantityUnit(event.target.value as QuantityUnit)}><option value="person">人数（人）</option><option value="item">商品数量（件）</option></select></label><label className="checkbox-label"><input type="checkbox" checked={manualAgentPrice} onChange={(event) => setManualAgentPrice(event.target.checked)} />每次录入时手动填写售价</label><label className="checkbox-label"><input type="checkbox" checked={manualCostPrice} onChange={event => setManualCostPrice(event.target.checked)} />每次录入时手动填写成本</label></>}
            <label>默认计价<select value={projectRules.defaultAmountBasis} onChange={event => setDefaultAmountBasis(event.target.value as AmountBasis)}><option value="per_person">{entryMode === 'profit_only' ? '按人数计算返佣' : quantityUnit === 'item' ? '按件计算' : '按人数计算'}</option><option value="total">{entryMode === 'profit_only' ? '返佣总额' : '整单总额'}</option></select></label>
            <label>结算方式<select value={projectRules.settlementMode} onChange={event => setSettlementMode(event.target.value as SettlementMode)} disabled={entryMode === 'profit_only'}><option value="daily">日结</option><option value="monthly">月结</option></select></label>
            <p className="sheet-copy">选择套餐时自动带入，可在出票时临时调整计价；月结不计每日概览，计入所属月报与年报。</p>
            {entryMode === 'profit_only' ? <p className="sheet-copy">此项目无默认成本和售价。每次记账只填写利润，计入月报。</p> : <div className="form-grid">
              <input inputMode="decimal" min="0" step="0.01" type="number" placeholder={manualCostPrice ? '每次手动填写成本' : '供货商成本（THB）'} value={manualCostPrice ? '' : cost} onChange={(event) => setCost(event.target.value)} required={!manualCostPrice} disabled={manualCostPrice} />
              <input inputMode="decimal" min="0" step="0.01" type="number" placeholder={manualAgentPrice ? '每次手动填写售价' : '代理售价（THB）'} value={manualAgentPrice ? '' : agentPrice} onChange={(event) => setAgentPrice(event.target.value)} required={!manualAgentPrice} disabled={manualAgentPrice} />
            </div>}
            </fieldset>
            {priceWarning && <SaveWarning messages={priceWarning.messages} saving={saving !== null} onBack={() => setPriceWarning(null)} onContinue={() => void saveProject(priceWarning.key)} />}
            {!priceWarning && <button className="primary-button full-width" type="submit" disabled={saving !== null}>{saving === 'project' ? '保存中…' : editingProject ? '保存价格修改' : '保存子项价格'}</button>}
            {editingProject && <button className="secondary-button" type="button" disabled={saving !== null} onClick={cancelProjectEdit}>取消修改</button>}
          </form>
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}

        <section className="supplier-list" aria-label="已录入的价格表">
          <div className="supplier-list-heading"><span>已录入子项</span><strong>{priceQuery || priceSupplierId ? `${filteredProjects.length} / ${projects.length}` : projects.length}</strong></div>
          <div className="price-filters" role="region" aria-label="价格表筛选"><label>搜索价格表<input type="search" placeholder="项目、套餐或供货商" value={priceQuery} onChange={event => setPriceQuery(event.target.value)} /></label><label>筛选供货商<select value={priceSupplierId} onChange={event => setPriceSupplierId(event.target.value)}><option value="">全部供货商</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>{(priceQuery || priceSupplierId) && <button className="text-action" type="button" onClick={() => { setPriceQuery(''); setPriceSupplierId('') }}>清除筛选</button>}</div>
          {filteredProjects.length === 0 ? <p className="supplier-empty">{projects.length ? '没有匹配的项目子项，请调整或清除筛选。' : '还没有项目子项，请先添加一个。'}</p> : filteredProjects.map((project) => <div className="project-row" key={project.id}><div><strong>{project.name}{project.subItemName ? ` · ${project.subItemName}` : ' · 不分套餐'}</strong><span>{project.manualSupplier ? '供货商：出票时选择' : project.supplierName}</span><span>{resolveProjectRules(project).defaultAmountBasis === 'total' ? '整单总额' : project.quantityUnit === 'item' ? '按件' : '按人'} · {resolveProjectRules(project).settlementMode === 'monthly' ? '月结' : '日结'}</span></div><div>{project.entryMode === 'profit_only' ? <strong>仅录利润 · 月结</strong> : <><span>成本 {project.manualCostPrice ? '手动填写' : formatThb(project.defaultCostThb)}</span><strong>售价 {project.manualAgentPrice ? '手动填写' : formatThb(project.defaultAgentPriceThb)}</strong></>}<button className="edit-price-button" type="button" disabled={saving !== null} aria-label={`编辑价格：${project.name} / ${project.subItemName || '不分套餐'} / ${project.supplierName}`} onClick={() => editProject(project)}>编辑设置</button></div></div>)}
        </section>
      </section>
    </div>
  )
}

function LoginSheet({ onClose, onSent }: { onClose: () => void; onSent: (message: string) => void }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const requestClose = () => { if (!sendingRef.current) onClose() }
  const dialogRef = useDialog(requestClose)

  const sendLoginLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = getSupabase()
    if (!client) return
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      const { error: authError } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: new URL(import.meta.env.BASE_URL, window.location.origin).href }
      })
      if (authError) {
        setError(/email address not authorized/i.test(authError.message)
        ? '请使用注册 Supabase 时的邮箱。其他邮箱需要先配置云端邮件服务。'
        : /email rate limit exceeded/i.test(authError.message)
          ? '登录邮件发送过于频繁，请稍后再试。'
          : authError.message)
        return
      }
      onSent('登录链接已发送，请到邮箱打开链接完成同步。')
      onClose()
    } catch {
      setError('登录邮件尚未确认发送，请检查网络后重试。')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={requestClose}>
      <section ref={dialogRef} tabIndex={-1} className="sheet compact-sheet" aria-modal="true" aria-labelledby="login-title" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div>
            <p className="eyebrow">私有云端备份</p>
            <h2 id="login-title">登录并同步</h2>
          </div>
          <button className="icon-button" type="button" disabled={sending} onClick={requestClose} aria-label="关闭">×</button>
        </div>
        <p className="sheet-copy">输入你的邮箱，我们会发送一次性登录链接。你的票务记录只会归属于这个账号。</p>
        <form className="ticket-form" onSubmit={sendLoginLink}>
          <label>
            邮箱
            <input autoComplete="email" inputMode="email" placeholder="name@example.com" type="email" disabled={sending} value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={sending}>{sending ? '发送中…' : '发送登录链接'}</button>
        </form>
      </section>
    </div>
  )
}

export default function App() {
  const today = useBangkokDate()
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  useEffect(() => {
    const check = () => setOffline(navigator.onLine === false)
    window.addEventListener('online', check); window.addEventListener('offline', check)
    return () => { window.removeEventListener('online', check); window.removeEventListener('offline', check) }
  }, [])
  const [tickets, setTickets] = useState<TicketRecord[]>([])
  const [show79Settlements, setShow79Settlements] = useState<Show79SettlementRecord[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [view, setView] = useState<View>('dashboard')
  const [show69Draft, setShow69Draft] = useState<{ id: string; accountId: string; input?: Show69RecordInput }>()
  const [boxingDraft, setBoxingDraft] = useState<{ id: string; accountId: string; input?: Show69RecordInput }>()
  const monthlyChannel = view === 'show69' || view === 'show79' || view === 'boxing' ? view : undefined
  const monthlyView = view === 'monthly' || Boolean(monthlyChannel)
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }) }, [view])
  const [selectedTicket, setSelectedTicket] = useState<TicketRecord | undefined>()
  const [formOpen, setFormOpen] = useState(false)
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundTicketId, setRefundTicketId] = useState('')
  const [supplierSheetOpen, setSupplierSheetOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [localUserId, setLocalUserId] = useState('')
  const [ready, setReady] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [toast, setToast] = useState('')
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [dateFilter, setDateFilter] = useState('')
  const [recordDateRange, setRecordDateRange] = useState<TicketDateRange>('all')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [query, setQuery] = useState('')
  const [syncConflicts, setSyncConflicts] = useState<SyncConflictRecord[]>([])
  const [conflictsOpen, setConflictsOpen] = useState(false)
  const userRef = useRef<User | null>(null)
  const accountEpochRef = useRef(0)
  const accountReadyRef = useRef(!cloudConfigured)
  const mountedRef = useRef(false)
  const syncAbortRef = useRef<AbortController | null>(null)
  const syncRunnerRef = useRef<() => Promise<void>>(async () => undefined)
  const syncQueueRef = useRef<SyncQueue | null>(null)
  syncQueueRef.current ??= createSyncQueue(() => syncRunnerRef.current())

  const refresh = useCallback(async () => {
    const epoch = accountEpochRef.current
    const [nextTickets, nextSuppliers, nextProjects, nextSettlements, nextConflicts] = await Promise.all([ledgerRepository.getTickets(), ledgerRepository.getSuppliers(), ledgerRepository.getProjects(), ledgerRepository.getShow79Settlements(), ledgerRepository.getSyncConflicts(true)])
    if (!mountedRef.current || epoch !== accountEpochRef.current) return
    setTickets(nextTickets.map(ticketDisplay))
    setSuppliers(nextSuppliers)
    setProjects(nextProjects)
    setShow79Settlements(nextSettlements)
    setSyncConflicts(nextConflicts)
    return nextConflicts
  }, [])

  syncRunnerRef.current = async () => {
    const targetUser = userRef.current
    if (!targetUser || !mountedRef.current || !accountReadyRef.current) return
    const controller = new AbortController()
    syncAbortRef.current = controller
    setSyncing(true)
    try {
      const result = await ledgerRepository.synchronise(targetUser, controller.signal)
      if (!mountedRef.current || userRef.current?.id !== targetUser.id || controller.signal.aborted) return
      const refreshedConflicts = await refresh()
      if (!mountedRef.current || userRef.current?.id !== targetUser.id || controller.signal.aborted) return
      setSyncMessage(result.synced ? refreshedConflicts?.some(row => !row.resolvedAt) ? '正常记录已同步，有异常记录待核对。' : '已同步到云端' : result.message ?? '同步暂未完成，会自动重试。')
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted && userRef.current?.id === targetUser.id) {
        setSyncMessage(error instanceof Error ? error.message : '同步暂未完成，本机记录已保留。')
      }
    } finally {
      if (syncAbortRef.current === controller) syncAbortRef.current = null
      if (mountedRef.current) setSyncing(false)
    }
  }

  const synchronise = useCallback(() => syncQueueRef.current!.request(), [])

  useEffect(() => {
    let alive = true
    let authChanged = false
    let authSyncTimer: number | undefined
    let activeAuthId: string | null | undefined
    let activationTask: Promise<boolean> = Promise.resolve(false)
    mountedRef.current = true
    const client = getSupabase()
    const applyUser = (nextUser: User | null) => {
      if (!alive) return Promise.resolve(false)
      const nextId = nextUser?.id ?? null
      if (activeAuthId === nextId) {
        userRef.current = nextUser; setUser(nextUser)
        return activationTask
      }
      activeAuthId = nextId
      const epoch = ++accountEpochRef.current
      accountReadyRef.current = false
      {
        syncAbortRef.current?.abort()
        syncQueueRef.current?.clearPending()
        setSyncMessage('')
        setSyncing(false)
        setFormOpen(false)
        setRefundOpen(false)
        setSupplierSheetOpen(false)
        setConflictsOpen(false)
        setSelectedTicket(undefined)
        setShow69Draft(undefined)
        setBoxingDraft(undefined)
        setTickets([]); setSuppliers([]); setProjects([]); setShow79Settlements([]); setSyncConflicts([])
        setQuery(''); setSupplierFilter(''); setToast('')
      }
      userRef.current = nextUser
      setUser(nextUser)
      activationTask = ledgerRepository.activateAccount(nextId).then(async () => {
        if (!alive || epoch !== accountEpochRef.current) return false
        accountReadyRef.current = true
        await refresh()
        return alive && epoch === accountEpochRef.current
      }).catch(error => {
        if (alive && epoch === accountEpochRef.current) {
          accountReadyRef.current = false
          setToast(error instanceof Error ? error.message : '账号账本尚未打开，请刷新后重试。')
        }
        return false
      })
      return activationTask
    }
    const authListener = client?.auth.onAuthStateChange((_event, session) => {
      authChanged = true
      // Only local activation runs here; defer Supabase calls beyond its auth lock.
      void applyUser(session?.user ?? null).then(activated => {
        if (!alive || !activated) return
        window.clearTimeout(authSyncTimer)
        authSyncTimer = window.setTimeout(() => { if (alive) void synchronise() }, 0)
      })
    })
    const initialise = async () => {
      try {
        const settings = await ledgerRepository.getSettings()
        if (alive) setLocalUserId(settings.localUserId)
        if (client) {
          const { data } = await client.auth.getSession()
          if (!authChanged) await applyUser(data.session?.user ?? null)
          else await activationTask
          if (alive) void synchronise()
        } else {
          await ledgerRepository.activateAccount(null)
          accountReadyRef.current = true
          await refresh()
        }
      } catch (error) {
        if (alive) setToast(error instanceof Error ? error.message : '打开账本时遇到问题，请刷新后重试。')
      } finally {
        if (alive) setReady(true)
      }
    }
    void initialise()
    return () => {
      alive = false
      mountedRef.current = false
      accountEpochRef.current++
      window.clearTimeout(authSyncTimer)
      authListener?.data.subscription.unsubscribe()
      syncAbortRef.current?.abort()
      syncQueueRef.current?.clearPending()
    }
  }, [refresh, synchronise])

  useEffect(() => {
    const client = getSupabase()
    if (!client || !user) return
    let alive = true
    let debounceTimer: number | undefined
    const scheduleSync = () => {
      window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(() => { if (alive) void synchronise() }, 180)
    }
    let channel = client.channel(`ledger:${user.id}`)
    for (const table of ['suppliers', 'projects', 'tickets', 'ticket_refunds', 'show79_settlements']) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${user.id}` }, scheduleSync)
    }
    channel.subscribe((status) => {
      // Pull again on initial subscription and reconnect so events missed while
      // the websocket was down are recovered.
      if (status === 'SUBSCRIBED') scheduleSync()
    })
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') scheduleSync()
    }
    const retryTimer = window.setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') scheduleSync()
    }, 30000)
    window.addEventListener('online', scheduleSync)
    window.addEventListener('focus', syncWhenVisible)
    document.addEventListener('visibilitychange', syncWhenVisible)
    return () => {
      alive = false
      window.clearTimeout(debounceTimer)
      window.clearInterval(retryTimer)
      window.removeEventListener('online', scheduleSync)
      window.removeEventListener('focus', syncWhenVisible)
      document.removeEventListener('visibilitychange', syncWhenVisible)
      void client.removeChannel(channel)
    }
  }, [user?.id, synchronise])

  useEffect(() => {
    const receiveInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', receiveInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', receiveInstallPrompt)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 3600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const month = today.slice(0, 7)
  const monthRange = monthDateRange(month)
  const year = today.slice(0, 4)
  const yearRange = yearDateRange(year)
  const visibleTickets = useMemo(() => activeTickets(mainLedgerTickets(tickets)).filter(ticket => matchesTicketSearch(ticket, {
    query, supplierId: supplierFilter, date: dateFilter, range: recordDateRange, today
  })).sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt)), [tickets, dateFilter, recordDateRange, supplierFilter, query, today])

  const mainTickets = useMemo(() => mainLedgerTickets(tickets), [tickets])

  const monthlySupplierStats = useMemo(() => bySupplier(ticketsInMonth(tickets, month)), [tickets, month])
  const unsyncedCount = [...tickets, ...suppliers, ...projects, ...tickets.flatMap((ticket) => ticket.refunds ?? [])].filter((record) => record.syncStatus !== 'synced').length

  const openNewForm = () => {
    setSelectedTicket(undefined)
    setFormOpen(true)
  }

  const requestLoginForWrite = () => {
    if (!accountReadyRef.current) {
      setToast('正在切换账号账本，请稍后再操作。')
      return true
    }
    if (canWriteLedger(cloudConfigured, userRef.current?.id)) return false
    setLoginOpen(true)
    setToast('请先登录同一邮箱，所有修改才能自动同步到云端。')
    return true
  }

  const requireCloudLogin = () => {
    if (requestLoginForWrite()) throw new Error('请先登录云端账号，再保存修改。')
  }

  const financialAccountId = user?.id ?? (cloudConfigured ? '' : localUserId)
  const openShow69 = (input?: Show69RecordInput) => {
    setShow69Draft({ id: createId(), accountId: financialAccountId, input })
    setFormOpen(false)
    setSelectedTicket(undefined)
    setView('show69')
  }
  const openBoxing = (input?: Show69RecordInput) => {
    setBoxingDraft({ id: createId(), accountId: financialAccountId, input })
    setFormOpen(false)
    setSelectedTicket(undefined)
    setView('boxing')
  }
  const openRefund = (id = '') => {
    if (requestLoginForWrite()) return
    try {
      const pending = readFinancialSubmission(window.localStorage, financialAccountId, 'refund')
      setRefundTicketId(pending?.ticketId ?? id); setRefundOpen(true)
    } catch { setToast('无法读取待核对的退票，请先检查浏览器储存权限，避免重复登记。') }
  }
  const saveRefund = async (input: RefundInput) => {
    requireCloudLogin()
    const epoch = accountEpochRef.current
    const originalDate = tickets.find((ticket) => ticket.id === input.ticketId)?.issueDate
    await synchronise()
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开当前账本。')
    requireCloudLogin()
    const saved = await ledgerRepository.createRefund(input)
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开原账号核对此笔退票。')
    setTickets(current => current.map(ticket => ticket.id !== saved.ticketId ? ticket : { ...ticket, refunds: [...(ticket.refunds ?? []).filter(refund => refund.id !== saved.id), saved] }))
    let refreshed = true
    try { await refresh() } catch { refreshed = false }
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开原账号核对此笔退票。')
    setToast(saved.cancelledAt ? '已核对：原退票已撤销，未新增退票。' : refreshed ? `退票已确认，已回算原出票日期 ${originalDate ?? ''} 的统计和月报。` : '退票已确认；页面刷新未完成，请同步核对，无需再次登记。')
    void synchronise()
  }
  const cancelRefund = async (id: string) => {
    if (requestLoginForWrite()) return
    const epoch = accountEpochRef.current
    if (!window.confirm('确认撤销这笔退票登记吗？原日期的利润和有效票量会恢复；退票明细仍保留。这只修改账本，不会转账。')) return
    try {
      await synchronise()
      if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开当前账本。')
      requireCloudLogin()
      await ledgerRepository.cancelRefund(id); await refresh()
      if (epoch !== accountEpochRef.current) return
      setToast('退票已撤销，原日期统计已重新计算。'); void synchronise()
    } catch (error) { setToast(error instanceof Error ? error.message : '撤销未完成，请刷新核对。') }
  }

  const saveTicket = async (input: TicketInput, operationId?: string) => {
    requireCloudLogin()
    const epoch = accountEpochRef.current
    const saved = await ledgerRepository.createOrUpdateTicket(input, selectedTicket, operationId)
    if (epoch !== accountEpochRef.current) return
    setTickets(current => [...current.filter(row => row.id !== saved.id), ticketDisplay(saved)])
    let refreshed = true
    try { await refresh() } catch { refreshed = false }
    if (epoch !== accountEpochRef.current) return
    setFormOpen(false)
    setToast(!refreshed ? '订单已保存；页面刷新未完成，请同步核对，无需再次保存。' : isShow79Project(saved.projectName) ? '79秀订单已保存，独立计算，不计入主账本报表。' : ticketSettlementMode(saved) === 'monthly'
      ? '月结记录已保存，计入所属月报、年报，不计入每日统计。'
      : selectedTicket ? '记录已更新，统计已重新计算。' : '出票记录已保存，统计已更新。')
    void synchronise()
  }

  const saveMedicine = async (entries: MedicineTicketEntry[]) => {
    requireCloudLogin()
    const epoch = accountEpochRef.current
    const saved = await ledgerRepository.createMedicineTickets(entries)
    if (epoch !== accountEpochRef.current) return
    const ids = new Set(saved.map(row => row.id))
    setTickets(current => [...current.filter(row => !ids.has(row.id)), ...saved.map(ticketDisplay)])
    let refreshed = true
    try { await refresh() } catch { refreshed = false }
    if (epoch !== accountEpochRef.current) return
    setFormOpen(false)
    setToast(refreshed ? `${saved.length} 项药品明细已保存，数量和利润已分别统计。` : '药品明细已全部保存；页面刷新未完成，请同步核对，无需再次保存。')
    void synchronise()
  }

  const saveShow79 = async (input: TicketInput, existing?: TicketRecord, operationId?: string): Promise<TicketRecord> => {
    requireCloudLogin()
    const epoch = accountEpochRef.current
    const saved = await ledgerRepository.createOrUpdateTicket(input, existing, operationId)
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开当前账本。')
    setTickets(current => [...current.filter(row => row.id !== saved.id), ticketDisplay(saved)])
    try { await refresh() }
    catch { if (epoch === accountEpochRef.current) setToast('79秀订单已保存；页面刷新未完成，请同步核对，无需再次保存。') }
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开当前账本。')
    void synchronise()
    return saved
  }

  const saveIndependentRecord = async (kind: 'show69' | 'boxing', input: Show69RecordInput, existing?: TicketRecord, operationId?: string): Promise<TicketRecord> => {
    requireCloudLogin()
    const epoch = accountEpochRef.current
    const saved = kind === 'show69' ? await ledgerRepository.createOrUpdateShow69Record(input, existing, operationId) : await ledgerRepository.createOrUpdateBoxingRecord(input, existing, operationId)
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开当前账本。')
    setTickets(current => [...current.filter(row => row.id !== saved.id), ticketDisplay(saved)])
    try { await refresh() }
    catch { if (epoch === accountEpochRef.current) setToast(`${kind === 'show69' ? '69秀' : '泰拳'}记录已保存；页面刷新未完成，请同步核对，无需再次保存。`) }
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开当前账本。')
    void synchronise()
    return saved
  }
  const saveShow69 = (input: Show69RecordInput, existing?: TicketRecord, operationId?: string) => saveIndependentRecord('show69', input, existing, operationId)
  const saveBoxing = (input: Show69RecordInput, existing?: TicketRecord, operationId?: string) => saveIndependentRecord('boxing', input, existing, operationId)

  const saveShow79Settlement = async (input: Show79SettlementInput) => {
    requireCloudLogin()
    const epoch = accountEpochRef.current
    await synchronise()
    if (epoch !== accountEpochRef.current) throw new Error('账号已切换，请重新打开当前账本。')
    requireCloudLogin()
    const saved = await ledgerRepository.createShow79Settlement(input)
    if (epoch !== accountEpochRef.current) return
    setShow79Settlements(current => [...current.filter(row => row.id !== saved.id), saved])
    let refreshed = true
    try { await refresh() } catch { refreshed = false }
    if (epoch !== accountEpochRef.current) return
    setToast(refreshed ? '分账登记已保存；此操作只记录已发生的付款，不会转账。' : '分账已确认登记；页面刷新未完成，请同步核对，无需再次登记或付款。')
    void synchronise()
  }

  const addSupplier = async (name: string) => {
    requireCloudLogin()
    await ledgerRepository.createSupplier(name)
    await refresh()
    setToast('供货商已录入，新增出票时可以直接选择。')
    void synchronise()
  }

  const addProject = async (input: ProjectInput) => {
    requireCloudLogin()
    await ledgerRepository.createProject(input)
    await refresh()
    setToast('项目价格已录入，新增出票时可以直接选择。')
    void synchronise()
  }

  const updateProject = async (id: string, input: ProjectPricesInput) => {
    requireCloudLogin()
    await ledgerRepository.updateProjectPrices(id, input)
    await refresh()
    setToast('项目价格已修改，已有出票记录保持原金额。')
    void synchronise()
  }

  const backupAllData = async () => {
    try {
      const [backupSuppliers, backupProjects, backupTickets, backupRefunds, backupSettlements] = await Promise.all([
        ledgerRepository.getSuppliers(), ledgerRepository.getProjects(), ledgerRepository.getTickets(), ledgerRepository.getRefunds(), ledgerRepository.getShow79Settlements()
      ])
      const aliases = await ledgerRepository.getCatalogueAliases()
      downloadLedgerBackup(createLedgerBackup({ suppliers: [...backupSuppliers, ...aliases.suppliers], projects: [...backupProjects, ...aliases.projects], tickets: backupTickets, refunds: backupRefunds, show79Settlements: backupSettlements }))
      setToast('全部资料备份已导出，包含供货商、项目价格、出票记录及退票明细。')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '备份未完成，请稍后重试。')
    }
  }

  const deleteTicket = async (ticket: TicketRecord) => {
    if (requestLoginForWrite()) return
    if (!window.confirm(`确认删除 ${formatDate(ticket.issueDate)} 的「${ticket.supplierName}」记录吗？删除后将不再计入统计。`)) return
    try {
      await ledgerRepository.deleteTicket(ticket); await refresh()
      setToast('记录已删除，统计已重新计算。'); void synchronise()
    } catch (error) { setToast(error instanceof Error ? error.message : '删除未完成，请刷新核对。') }
  }

  const resolveSyncConflict = async (id: string) => {
    requireCloudLogin()
    await ledgerRepository.resolveSyncConflict(id)
    await refresh()
    void synchronise()
  }

  const install = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    const result = await installPrompt.userChoice
    if (result.outcome === 'accepted') setToast('已添加到设备桌面。')
    setInstallPrompt(null)
  }

  const signOut = async () => {
    const client = getSupabase()
    if (!client) return
    const epoch = ++accountEpochRef.current
    accountReadyRef.current = false
    userRef.current = null
    setUser(null)
    setTickets([]); setSuppliers([]); setProjects([]); setShow79Settlements([]); setSyncConflicts([])
    setFormOpen(false); setRefundOpen(false); setSupplierSheetOpen(false); setConflictsOpen(false)
    setSelectedTicket(undefined)
    setShow69Draft(undefined)
    setBoxingDraft(undefined)
    syncAbortRef.current?.abort()
    syncQueueRef.current?.clearPending()
    try {
      await ledgerRepository.activateAccount(null)
      const { error } = await client.auth.signOut()
      if (error) throw error
      if (epoch === accountEpochRef.current) accountReadyRef.current = true
      setSyncMessage('已退出云端账号；本机缓存已锁定，重新登录后可查看。')
    } catch (error) {
      setToast(`退出尚未完成，本机账本仍保持锁定，请刷新后核对。${error instanceof Error ? error.message : ''}`)
    }
  }

  if (!ready) {
    return <main className="loading-screen"><div className="loading-mark">฿</div><p>正在打开你的盈利簿…</p></main>
  }

  return (
    <main className={`app-shell${view === 'reports' ? ' report-view' : ''}`}>
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">฿</div>
          <div>
            <p>票务盈利簿</p>
            <span>THB · Asia/Bangkok</span>
          </div>
        </div>
        <button className="header-action" type="button" onClick={() => void synchronise()} disabled={!user || syncing}>
          {syncing ? '同步中' : user ? syncConflicts.some(row => !row.resolvedAt) ? '待核对' : unsyncedCount ? '待同步' : syncMessage === '已同步到云端' ? '已同步' : '自动同步' : cloudConfigured ? '未登录' : '本机'}
        </button>
      </header>

      {syncConflicts.length > 0 && <section className="sync-conflict-banner" aria-label="同步记录核对"><div><strong>{syncConflicts.some(row => !row.resolvedAt) ? `${syncConflicts.filter(row => !row.resolvedAt).length} 条同步记录待核对` : '同步核对历史'}</strong><p>本机修改副本已保留，可查看差异后处理。</p></div><button type="button" className="secondary-button" onClick={() => setConflictsOpen(true)}>查看记录</button></section>}

      <div className="page-content">
        {view === 'dashboard' ? <>
          <section className="welcome-row">
            <div className="welcome-brand">
              <p className="eyebrow">{formatDate(today)}</p>
              <DashboardLogo />
            </div>
          </section>

          {cloudConfigured ? (
            <section className={`sync-banner ${user ? 'connected' : ''}`}>
              <div><strong>{user ? '云端自动同步已启用' : '登录后自动同步电脑与手机'}</strong><span>{user ? `${user.email ?? '当前账号'} · ${unsyncedCount ? `${unsyncedCount} 条待同步 · ` : ''}${syncing ? '正在同步…' : syncMessage || '正在连接云端…'}` : '请登录同一邮箱。未登录时不能保存修改，避免资料只留在本机。'}</span></div>
              {user ? <button type="button" onClick={() => void signOut()}>退出</button> : <button type="button" onClick={() => setLoginOpen(true)}>登录</button>}
            </section>
          ) : (
            <section className="sync-banner warning">
              <div><strong>当前为本机账本模式</strong><span>配置 Supabase 后即可启用邮箱登录与云端同步。</span></div>
            </section>
          )}

          <SummaryPanel title="今日概览" subtitle="TODAY" tickets={ticketsForDailyStats(tickets, today)} note="按记录保存的结算方式统计；不含69秀、79秀、泰拳独立记录及其他月结返佣项目。" />
          <SummaryPanel title="本月月报" subtitle={`${monthRange.start} — ${monthRange.end}`} tickets={ticketsInMonth(tickets, month)} note="按出票日期统计每月1日至月底，包含其他月结返佣；69秀、79秀、泰拳独立记录。" />
          <ProfitTrendPanel tickets={mainTickets} today={today} pendingCount={unsyncedCount} offline={offline} />
          <SummaryPanel title="年度年报" subtitle={`${yearRange.start} — ${yearRange.end}`} tickets={ticketsInYear(tickets, year)} note="按曼谷自然年统计，包含其他月结返佣及商品利润；69秀、79秀、泰拳独立记录，退票回算原记录年份。" />

          <section className="ranking-section">
            <div className="section-heading">
              <div><p className="eyebrow">{month}</p><h2>供应商盈利排行</h2></div>
              <button className="text-action" type="button" onClick={() => setSupplierSheetOpen(true)}>管理供货商</button>
            </div>
            {monthlySupplierStats.length === 0 ? <div className="empty-card">本月还没有出票记录。<button type="button" onClick={openNewForm}>现在记第一张票</button></div> : (
              <div className="rank-list">
                {monthlySupplierStats.map((supplier, index) => (
                  <div className="rank-row" key={supplier.supplierId}>
                    <span className={`rank-number rank-${index + 1}`}>{index + 1}</span>
                    <div className="rank-name"><strong>{supplier.supplierName}</strong><span>{quantityParts(summariseQuantities(ticketsInMonth(tickets, month).filter(ticket => ticket.supplierId === supplier.supplierId))).join(' · ')}</span></div>
                    <strong className={supplier.profitThb >= 0 ? 'profit-value' : 'loss-value'}>{formatThb(supplier.profitThb)}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>

          {installPrompt && <button className="install-banner" type="button" onClick={() => void install()}><span>⇩</span> 添加到手机桌面，像 App 一样使用</button>}
        </> : monthlyView ? <MonthlyTicketsView selected={monthlyChannel} onSelect={channel => { setShow69Draft(undefined); setBoxingDraft(undefined); setView(channel) }} onBack={() => setView('dashboard')}>
          {view === 'show69' ? <Show69View key={`show69:${financialAccountId}:${show69Draft?.id ?? ''}`} accountId={financialAccountId} initialInput={show69Draft?.accountId === financialAccountId ? show69Draft.input : undefined} tickets={tickets} onSave={saveShow69} onDelete={deleteTicket} />
            : view === 'boxing' ? <Show69View kind="boxing" key={`boxing:${financialAccountId}:${boxingDraft?.id ?? ''}`} accountId={financialAccountId} initialInput={boxingDraft?.accountId === financialAccountId ? boxingDraft.input : undefined} tickets={tickets} onSave={saveBoxing} onDelete={deleteTicket} />
            : view === 'show79' ? <Show79View key={user?.id ?? 'local'} accountId={financialAccountId} tickets={tickets} projects={projects} settlements={show79Settlements} onSaveSettlement={saveShow79Settlement} onSave={saveShow79} onDelete={deleteTicket} onRefund={openRefund} onCancelRefund={id => void cancelRefund(id)} onManageProjects={() => setSupplierSheetOpen(true)} /> : null}
        </MonthlyTicketsView> : view === 'reports' ? <ReportView tickets={mainTickets} suppliers={suppliers} projects={projects} /> : <>
          <section className="records-heading">
            <div><p className="eyebrow">全部有效记录</p><h1>出票记录</h1></div>
            <div className="heading-actions"><button className="secondary-button small" type="button" onClick={() => setSupplierSheetOpen(true)}>供货商</button><button className="primary-button small" type="button" onClick={openNewForm}>＋ 新增</button></div>
          </section>
          <section className="filters">
            <input type="search" aria-label="搜索客户、项目、套餐或供货商" placeholder="搜索客户、项目、套餐或供货商" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="record-date-shortcuts" role="group" aria-label="快捷日期范围">{([['today', '今天'], ['month', '本月'], ['all', '全部']] as const).map(([range, label]) => <button key={range} type="button" aria-pressed={!dateFilter && recordDateRange === range} onClick={() => { setDateFilter(''); setRecordDateRange(range) }}>{label}</button>)}</div>
            <div className="filter-row">
              <input aria-label="按日期筛选" type="date" value={dateFilter} onChange={(event) => { setDateFilter(event.target.value); setRecordDateRange('all') }} />
              <select aria-label="按供应商筛选" value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}>
                <option value="">全部供应商</option>
                {suppliers.map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}</option>)}
              </select>
            </div>
            <p className="record-date-range">{dateFilter ? `日期：${dateFilter.replaceAll('-', '/')}（曼谷）` : recordDateRange === 'today' ? `今天：${today.replaceAll('-', '/')}（曼谷）` : recordDateRange === 'month' ? `本月：${monthRange.start.replaceAll('-', '/')} — ${monthRange.end.replaceAll('-', '/')}（曼谷自然月）` : '日期范围：全部已录日期'} · 可同时搜索姓名、备注及筛选供货商。</p>
            {(query || dateFilter || supplierFilter || recordDateRange !== 'all') && <button className="clear-filters" type="button" onClick={() => { setQuery(''); setDateFilter(''); setSupplierFilter(''); setRecordDateRange('all') }}>清除筛选</button>}
          </section>
          <div className="record-summary"><span>{visibleTickets.length} 条记录</span><strong>利润 {formatThb(summarise(visibleTickets).profitThb)}</strong></div>
          <section className="records-list">
            {visibleTickets.length === 0 ? <div className="empty-card">没有符合条件的记录。</div> : visibleTickets.map((ticket) => (
              <article className="ticket-card" key={ticket.id}>
                <div className="ticket-card-main">
                  <div><p>{formatDate(ticket.issueDate)} · {ticket.issueTime ? `${ticket.issueTime}（曼谷）` : '时间未记录'} · {ticket.supplierName}</p><strong>{ticket.projectName || '未分类项目'}{ticket.subItemName ? ` · ${ticket.subItemName}` : ''}</strong><p>客户：{ticket.guestName?.trim() || '未填写'}</p></div>
                  <strong className={getProfit(ticket) >= 0 ? 'profit-value' : 'loss-value'}>{formatThb(getProfit(ticket))}</strong>
                </div>
                <div className="ticket-meta"><span>{getEffectivePersonCount(ticket) == null ? `${quantityLabels(ticket).label}未记录` : `有效 ${formatNumber(getEffectivePersonCount(ticket)!)} ${quantityLabels(ticket).unit}`}</span><span>{ticket.amountBasis === 'per_person' ? `按${quantityLabels(ticket).label}计算` : '整单总额'}</span>{getRefundState(ticket).active.length > 0 && <span>{getRefundState(ticket).full ? '已全部退票' : `已退 ${getRefundState(ticket).refundedPeople} ${quantityLabels(ticket).unit}`} · 回算原日/月</span>}{ticket.entryMode === 'profit_only' ? <span>月底返佣 · 仅录利润</span> : <><span>净售价 {formatThb(getTicketAmounts(ticket).agentPriceThb)}</span><span>净成本 {formatThb(getTicketAmounts(ticket).costThb)}</span></>}</div>
                {ticket.note && <p className="ticket-note">{ticket.note}</p>}
                <RefundHistory ticket={ticket} onCancel={(id) => void cancelRefund(id)} />
                <div className="ticket-actions">{ticket.entryMode !== 'profit_only' && !getRefundState(ticket).full && <button type="button" onClick={() => openRefund(ticket.id)}>退票</button>}<button type="button" disabled={Boolean(ticket.refunds?.length)} onClick={() => { setSelectedTicket(ticket); setFormOpen(true) }}>编辑</button><button className="danger-action" type="button" disabled={Boolean(ticket.refunds?.length)} onClick={() => void deleteTicket(ticket)}>删除</button></div>
              </article>
            ))}
          </section>
        </>}
      </div>

      <BottomNavigation view={monthlyView ? 'monthly' : view === 'records' || view === 'reports' ? view : 'dashboard'} onViewChange={next => { setShow69Draft(undefined); setBoxingDraft(undefined); setView(next) }} onAdd={() => view === 'show69' ? openShow69() : view === 'boxing' ? openBoxing() : openNewForm()} onRefund={() => openRefund()} />

      {formOpen && <TicketForm ticket={selectedTicket} projects={projects} suppliers={suppliers} knownTickets={tickets} cloudLoginRequired={cloudConfigured && !user} onCancel={() => setFormOpen(false)} onManageSuppliers={() => { setFormOpen(false); setSupplierSheetOpen(true) }} onSave={saveTicket} onSaveMedicine={saveMedicine} onShow69={openShow69} onBoxing={openBoxing} />}
      {refundOpen && <RefundSheet key={financialAccountId} accountId={financialAccountId} tickets={refundTicketId || view === 'show79' ? tickets : mainTickets} initialTicketId={refundTicketId} onClose={() => setRefundOpen(false)} onSave={saveRefund} />}
      {supplierSheetOpen && <SupplierSheet suppliers={suppliers} projects={projects} onAddSupplier={addSupplier} onAddProject={addProject} onUpdateProject={updateProject} onBackup={backupAllData} onClose={() => setSupplierSheetOpen(false)} />}
      {loginOpen && <LoginSheet onClose={() => setLoginOpen(false)} onSent={setToast} />}
      {conflictsOpen && <SyncConflictPanel records={syncConflicts} onClose={() => setConflictsOpen(false)} onResolve={resolveSyncConflict} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {!monthlyView && view !== 'reports' && <button className="export-button" onClick={() => void exportTicketsToXlsx(mainTickets)} type="button" title="导出全部有效记录到 Excel">导出 Excel · {formatNumber(activeTickets(mainTickets).length)}</button>}
    </main>
  )
}
