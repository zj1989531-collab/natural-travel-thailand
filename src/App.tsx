import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { createLedgerBackup, downloadLedgerBackup, exportTicketsToXlsx } from './lib/export'
import { formatDate, formatNumber, formatThb, getBangkokDate, getBangkokMonth, getBangkokTime, isValidIssueTime, isValidPersonCount } from './lib/format'
import { PersonCountField } from './components/PersonCountField'
import { ReportView } from './components/ReportView'
import { RefundHistory, RefundSheet } from './components/RefundSheet'
import { DashboardLogo } from './components/DashboardLogo'
import { SummaryPanel } from './components/SummaryPanel'
import { BottomNavigation } from './components/BottomNavigation'
import { isItemQuantity, quantityLabels } from './lib/quantity'
import { ticketDisplay } from './lib/project-labels'
import { getEffectivePersonCount, getRefundState } from './lib/refunds'
import { getTicketAmounts } from './lib/ticket-amounts'
import { ledgerRepository } from './lib/repository'
import { cloudConfigured, getSupabase } from './lib/supabase'
import { canWriteLedger, createSyncQueue, type SyncQueue } from './lib/sync'
import { chooseProject, chooseProjectOption, projectNames, projectOptionLabel } from './lib/project-selection'
import { activeTickets, bySupplier, getProfit, isMonthlySettlementProject, monthDateRange, summarise, ticketsForDailyStats, ticketsInMonth, ticketsInYear, yearDateRange } from './lib/stats'
import type { AmountBasis, EntryMode, Project, ProjectInput, ProjectPricesInput, QuantityUnit, RefundInput, Supplier, TicketInput, TicketRecord } from './types'

type View = 'dashboard' | 'records' | 'reports'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface TicketFormProps {
  ticket?: TicketRecord
  projects: Project[]
  cloudLoginRequired: boolean
  onCancel: () => void
  onManageSuppliers: () => void
  onSave: (input: TicketInput) => Promise<void>
}

const emptyForm = (): TicketInput => ({
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

export function TicketForm({ ticket, projects, cloudLoginRequired, onCancel, onManageSuppliers, onSave }: TicketFormProps) {
  const [form, setForm] = useState<TicketInput>(() => ticket ? {
    quantityUnit: ticket.quantityUnit ?? 'person',
    amountBasis: ticket.amountBasis ?? 'total',
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

  const update = <K extends keyof TicketInput>(key: K, value: TicketInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const supplierName = form.supplierName.trim()
    if (!form.issueDate || !supplierName || !form.projectId) {
      setError('请填写出票日期，并选择项目及适用的套餐；供货商会自动带入。')
      return
    }
    if ((!ticket && !form.issueTime) || (form.issueTime && !isValidIssueTime(form.issueTime))) {
      setError('请填写有效的曼谷时间（HH:mm）。')
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
    setSaving(true)
    try {
      await onSave({ ...form, supplierName })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试。')
      setSaving(false)
    }
  }

  const names = projectNames(projects)
  const availableSubItems = projects.filter((project) => project.name === form.projectName)
  const perPerson = form.amountBasis === 'per_person'
  const { label: countLabel, single } = quantityLabels(form)
  const manualAgentPrice = projects.find((project) => project.id === form.projectId)?.manualAgentPrice
  const amountsComplete = form.entryMode === 'profit_only' ? Number.isFinite(form.manualProfitThb) : Number.isFinite(form.agentPriceThb) && Number.isFinite(form.costThb)
  const totals = getTicketAmounts(form)
  const profit = totals.profitThb

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="sheet" aria-modal="true" aria-labelledby="ticket-form-title" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div>
            <p className="eyebrow">THB · 自动计算利润</p>
            <h2 id="ticket-form-title">{ticket ? '编辑记录' : '新增出票记录'}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label="关闭">×</button>
        </div>
        {cloudLoginRequired && <p className="sheet-copy">保存前请登录云端账号，之后记录和价格修改会自动同步到电脑与手机。</p>}
        <form className="ticket-form" onSubmit={submit}>
          <label>
            出票日期
            <input type="date" value={form.issueDate} onChange={(event) => update('issueDate', event.target.value)} required />
          </label>
          <label>
            时间（曼谷 UTC+7）
            <input type="time" step="60" value={form.issueTime ?? ''} onChange={(event) => update('issueTime', event.target.value)} required={!ticket || Boolean(ticket.issueTime)} />
            {ticket && !ticket.issueTime && <span className="muted">旧记录未记录时间，可手动补填。</span>}
          </label>
          <PersonCountField quantityUnit={form.quantityUnit} value={form.personCount} allowUnknown={Boolean(ticket && ticket.personCount == null && !perPerson)} multiplyAmounts={perPerson} onChange={(value) => update('personCount', value)} />
          <label>
            计价方式
            <select value={form.amountBasis} onChange={(event) => update('amountBasis', event.target.value as AmountBasis)}>
              <option value="per_person">按{countLabel}计算（{single}金额 × {countLabel}）</option>
              <option value="total">整单总额（不乘{countLabel}）</option>
            </select>
          </label>
          {ticket && !perPerson && <p className="sheet-copy">旧记录保留原总额；如切换为按{countLabel}计算，请先核对并填写{single}金额。</p>}
          <label>
            项目
            <select value={form.projectName} onChange={(event) => {
              const name = event.target.value
              setForm((current) => chooseProject(current, projects, name))
            }} required>
              <option value="">请选择项目</option>
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            子项 / 套餐 <span className="muted">（可选）</span>
            <select value={form.projectId} disabled={!form.projectName} onChange={(event) => {
              const id = event.target.value
              setForm((current) => chooseProjectOption(current, projects, id))
            }} required>
              <option value="">{form.projectName ? '请选择子项/套餐' : '请先选择项目'}</option>
              {availableSubItems.map((project) => <option key={project.id} value={project.id}>{projectOptionLabel(project, availableSubItems)}</option>)}
            </select>
          </label>
          {form.supplierName && <p className="sheet-copy">供货商：{form.supplierName}（自动带入）</p>}
          {manualAgentPrice && <p className="sheet-copy">售价不预设，请填写本次{perPerson ? single : '整单'}售价；成本已自动带入。</p>}
          {(form.entryMode === 'profit_only' || isMonthlySettlementProject(form.projectName)) && <p className="sheet-copy">月结返佣项目：仅计入月报，不计入每日票数、售价、成本和利润。</p>}
          {form.entryMode === 'profit_only' && <p className="sheet-copy">{perPerson ? '只填写单人返佣利润，系统按人数计算返佣总额。' : '只填写本次返佣总额，不填写售价或成本。'}请勿重复录入已统计的项目利润。</p>}
          {projects.length === 0 && <button className="inline-action" type="button" onClick={onManageSuppliers}>还没有项目价格，去录入</button>}
          {form.entryMode === 'profit_only' ? <label>{perPerson ? '单人返佣利润（THB）' : '返佣总额（THB）'}<input inputMode="decimal" type="number" min="0" step="0.01" value={form.manualProfitThb ?? ''} onChange={(event) => update('manualProfitThb', event.target.value === '' ? null : Number(event.target.value))} required /></label> : <div className="form-grid">
            <label>
              {perPerson ? `${single}代理售价（THB）` : '代理售价总额（THB）'}
              <input inputMode="decimal" min="0" step="0.01" type="number" value={Number.isFinite(form.agentPriceThb) ? form.agentPriceThb : ''} onChange={(event) => update('agentPriceThb', event.target.value === '' ? Number.NaN : Number(event.target.value))} required />
            </label>
            <label>
              {perPerson ? `${single}供货商成本（THB）` : '供货商成本总额（THB）'}
              <input inputMode="decimal" min="0" step="0.01" type="number" value={Number.isFinite(form.costThb) ? form.costThb : ''} onChange={(event) => update('costThb', event.target.value === '' ? Number.NaN : Number(event.target.value))} required />
            </label>
          </div>}
          {form.entryMode !== 'profit_only' && amountsComplete && <p className="sheet-copy">总售价 {formatThb(totals.agentPriceThb)} · 总成本 {formatThb(totals.costThb)}</p>}
          <div className={`profit-preview ${profit >= 0 || !amountsComplete ? 'positive' : 'negative'}`}>
            <span>{form.entryMode === 'profit_only' ? '本次月结总利润' : '本次总利润'}</span>
            <strong>{amountsComplete ? formatThb(profit) : manualAgentPrice ? '待填写售价' : '待填写金额'}</strong>
          </div>
          <label>
            备注 <span className="muted">（可选）</span>
            <textarea maxLength={300} placeholder="例如航线、特殊说明" value={form.note} onChange={(event) => update('note', event.target.value)} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="sheet-actions">
            <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
            <button className="primary-button" type="submit" disabled={saving}>{saving ? '保存中…' : cloudLoginRequired ? '登录后保存' : '保存记录'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function SupplierSheet({ suppliers, projects, onAddSupplier, onAddProject, onUpdateProject, onBackup, onClose }: {
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
  const [quantityUnit, setQuantityUnit] = useState<QuantityUnit>('person')
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const projectFormRef = useRef<HTMLFormElement>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<'supplier' | 'project' | null>(null)

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

  const addProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving('project')
    setError('')
    try {
      if (editingProject) {
        await onUpdateProject(editingProject.id, { defaultCostThb: Number(cost), defaultAgentPriceThb: manualAgentPrice ? 0 : Number(agentPrice), manualAgentPrice })
      } else {
        await onAddProject({ supplierId: projectSupplierId, name: projectName, subItemName, entryMode, quantityUnit, manualAgentPrice, defaultCostThb: entryMode === 'profit_only' ? 0 : Number(cost), defaultAgentPriceThb: entryMode === 'profit_only' || manualAgentPrice ? 0 : Number(agentPrice) })
      }
      setProjectName('')
      setSubItemName('')
      setCost('')
      setAgentPrice('')
      setEditingProject(null)
      setEntryMode('standard')
      setManualAgentPrice(false); setQuantityUnit('person')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试。')
    } finally {
      setSaving(null)
    }
  }

  const editProject = (project: Project) => {
    setEditingProject(project)
    setEntryMode(project.entryMode ?? 'standard')
    setProjectSupplierId(project.supplierId)
    setProjectName(project.name)
    setSubItemName(project.subItemName)
    setCost(String(project.defaultCostThb))
    setAgentPrice(String(project.defaultAgentPriceThb))
    setManualAgentPrice(project.manualAgentPrice ?? false); setQuantityUnit(project.quantityUnit ?? 'person')
    setError('')
  }

  const cancelProjectEdit = () => {
    setEditingProject(null)
    setEntryMode('standard')
    setManualAgentPrice(false); setQuantityUnit('person')
    setProjectName('')
    setSubItemName('')
    setCost('')
    setAgentPrice('')
    setError('')
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="sheet compact-sheet" aria-modal="true" aria-labelledby="supplier-sheet-title" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div><p className="eyebrow">预先维护价格表</p><h2 id="supplier-sheet-title">供货商与项目</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
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
          {editingProject && <p className="sheet-copy">只更新此套餐的默认价格，不影响已保存的出票记录。</p>}
          <form className="project-form" ref={projectFormRef} onSubmit={addProject}>
            <select value={projectSupplierId} onChange={(event) => setProjectSupplierId(event.target.value)} required disabled={editingProject !== null}>
              <option value="">选择供货商</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
            <input autoComplete="off" placeholder="项目名称，例如：曼谷往返机票" value={projectName} onChange={(event) => setProjectName(event.target.value)} required readOnly={editingProject !== null} />
            <input autoComplete="off" placeholder="子项/套餐名称（可选，例如：经济舱）" value={subItemName} onChange={(event) => setSubItemName(event.target.value)} readOnly={editingProject !== null} />
            {!editingProject && <label>记账方式<select value={entryMode} onChange={(event) => setEntryMode(event.target.value as EntryMode)}><option value="standard">售价减成本</option><option value="profit_only">仅录利润（月结返佣）</option></select></label>}
            {entryMode !== 'profit_only' && <><label>数量单位<select value={quantityUnit} onChange={(event) => setQuantityUnit(event.target.value as QuantityUnit)} disabled={editingProject !== null}><option value="person">人数（人）</option><option value="item">商品数量（件）</option></select></label><label className="checkbox-label"><input type="checkbox" checked={manualAgentPrice} onChange={(event) => setManualAgentPrice(event.target.checked)} />每次录入时手动填写售价</label></>}
            {entryMode === 'profit_only' ? <p className="sheet-copy">此项目无默认成本和售价。每次记账只填写利润，计入月报。</p> : <div className="form-grid">
              <input inputMode="decimal" min="0" step="0.01" type="number" placeholder="供货商成本（THB）" value={cost} onChange={(event) => setCost(event.target.value)} required />
              <input inputMode="decimal" min="0" step="0.01" type="number" placeholder={manualAgentPrice ? '每次手动填写售价' : '代理售价（THB）'} value={manualAgentPrice ? '' : agentPrice} onChange={(event) => setAgentPrice(event.target.value)} required={!manualAgentPrice} disabled={manualAgentPrice} />
            </div>}
            <button className="primary-button full-width" type="submit" disabled={saving !== null}>{saving === 'project' ? '保存中…' : editingProject ? '保存价格修改' : '保存子项价格'}</button>
            {editingProject && <button className="secondary-button" type="button" disabled={saving !== null} onClick={cancelProjectEdit}>取消修改</button>}
          </form>
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}

        <section className="supplier-list" aria-label="已录入的价格表">
          <div className="supplier-list-heading"><span>已录入子项</span><strong>{projects.length}</strong></div>
          {projects.length === 0 ? <p className="supplier-empty">还没有项目子项，请先添加一个。</p> : projects.map((project) => <div className="project-row" key={project.id}><div><strong>{project.name}{project.subItemName ? ` · ${project.subItemName}` : ' · 不分套餐'}</strong><span>{project.supplierName}</span></div><div>{project.entryMode === 'profit_only' ? <strong>仅录利润 · 月结</strong> : <><span>成本 {formatThb(project.defaultCostThb)}</span><strong>售价 {project.manualAgentPrice ? '手动填写' : formatThb(project.defaultAgentPriceThb)}</strong><button className="edit-price-button" type="button" disabled={saving !== null} aria-label={`编辑价格：${project.name} / ${project.subItemName || '不分套餐'} / ${project.supplierName}`} onClick={() => editProject(project)}>编辑价格</button></>}</div></div>)}
        </section>
      </section>
    </div>
  )
}

function LoginSheet({ onClose, onSent }: { onClose: () => void; onSent: (message: string) => void }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  const sendLoginLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = getSupabase()
    if (!client) return
    setSending(true)
    setError('')
    const { error: authError } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: new URL(import.meta.env.BASE_URL, window.location.origin).href }
    })
    setSending(false)
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
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="sheet compact-sheet" aria-modal="true" aria-labelledby="login-title" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div>
            <p className="eyebrow">私有云端备份</p>
            <h2 id="login-title">登录并同步</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <p className="sheet-copy">输入你的邮箱，我们会发送一次性登录链接。你的票务记录只会归属于这个账号。</p>
        <form className="ticket-form" onSubmit={sendLoginLink}>
          <label>
            邮箱
            <input autoComplete="email" inputMode="email" placeholder="name@example.com" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={sending}>{sending ? '发送中…' : '发送登录链接'}</button>
        </form>
      </section>
    </div>
  )
}

export default function App() {
  const [tickets, setTickets] = useState<TicketRecord[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [view, setView] = useState<View>('dashboard')
  const [selectedTicket, setSelectedTicket] = useState<TicketRecord | undefined>()
  const [formOpen, setFormOpen] = useState(false)
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundTicketId, setRefundTicketId] = useState('')
  const [supplierSheetOpen, setSupplierSheetOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [toast, setToast] = useState('')
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [dateFilter, setDateFilter] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [query, setQuery] = useState('')
  const userRef = useRef<User | null>(null)
  const mountedRef = useRef(false)
  const syncAbortRef = useRef<AbortController | null>(null)
  const syncRunnerRef = useRef<() => Promise<void>>(async () => undefined)
  const syncQueueRef = useRef<SyncQueue | null>(null)
  syncQueueRef.current ??= createSyncQueue(() => syncRunnerRef.current())

  const refresh = useCallback(async () => {
    const [nextTickets, nextSuppliers, nextProjects] = await Promise.all([ledgerRepository.getTickets(), ledgerRepository.getSuppliers(), ledgerRepository.getProjects()])
    if (!mountedRef.current) return
    setTickets(nextTickets.map(ticketDisplay))
    setSuppliers(nextSuppliers)
    setProjects(nextProjects)
  }, [])

  syncRunnerRef.current = async () => {
    const targetUser = userRef.current
    if (!targetUser || !mountedRef.current) return
    const controller = new AbortController()
    syncAbortRef.current = controller
    setSyncing(true)
    try {
      const result = await ledgerRepository.synchronise(targetUser, controller.signal)
      if (!mountedRef.current || userRef.current?.id !== targetUser.id || controller.signal.aborted) return
      setSyncMessage(result.synced ? '已同步到云端' : result.message ?? '同步暂未完成，会自动重试。')
      await refresh()
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
    mountedRef.current = true
    const client = getSupabase()
    const applyUser = (nextUser: User | null) => {
      if (!alive) return
      if (userRef.current?.id !== nextUser?.id) {
        syncAbortRef.current?.abort()
        syncQueueRef.current?.clearPending()
        setSyncMessage('')
        setFormOpen(false)
        setRefundOpen(false)
        setSelectedTicket(undefined)
      }
      userRef.current = nextUser
      setUser(nextUser)
    }
    const authListener = client?.auth.onAuthStateChange((_event, session) => {
      authChanged = true
      applyUser(session?.user ?? null)
      // Supabase auth callbacks must finish before making further client calls.
      window.clearTimeout(authSyncTimer)
      authSyncTimer = window.setTimeout(() => { if (alive) void synchronise() }, 0)
    })
    const initialise = async () => {
      try {
        await ledgerRepository.getSettings()
        await refresh()
        if (client) {
          const { data } = await client.auth.getSession()
          if (!authChanged) applyUser(data.session?.user ?? null)
          if (alive) void synchronise()
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
    for (const table of ['suppliers', 'projects', 'tickets', 'ticket_refunds']) {
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

  const today = getBangkokDate()
  const month = getBangkokMonth()
  const monthRange = monthDateRange(month)
  const year = today.slice(0, 4)
  const yearRange = yearDateRange(year)
  const visibleTickets = useMemo(() => activeTickets(tickets).filter((ticket) => {
    const dateMatches = !dateFilter || ticket.issueDate === dateFilter
    const supplierMatches = !supplierFilter || ticket.supplierId === supplierFilter
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const queryMatches = !normalizedQuery || ticket.supplierName.toLocaleLowerCase().includes(normalizedQuery) || ticket.projectName.toLocaleLowerCase().includes(normalizedQuery) || ticket.note.toLocaleLowerCase().includes(normalizedQuery)
    return dateMatches && supplierMatches && queryMatches
  }).sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt)), [tickets, dateFilter, supplierFilter, query])

  const monthlySupplierStats = useMemo(() => bySupplier(ticketsInMonth(tickets, month)), [tickets, month])
  const unsyncedCount = [...tickets, ...suppliers, ...projects, ...tickets.flatMap((ticket) => ticket.refunds ?? [])].filter((record) => record.syncStatus !== 'synced').length

  const openNewForm = () => {
    setSelectedTicket(undefined)
    setFormOpen(true)
  }

  const requestLoginForWrite = () => {
    if (canWriteLedger(cloudConfigured, userRef.current?.id)) return false
    setLoginOpen(true)
    setToast('请先登录同一邮箱，所有修改才能自动同步到云端。')
    return true
  }

  const requireCloudLogin = () => {
    if (requestLoginForWrite()) throw new Error('请先登录云端账号，再保存修改。')
  }

  const openRefund = (id = '') => {
    if (requestLoginForWrite()) return
    setRefundTicketId(id); setRefundOpen(true)
  }
  const saveRefund = async (input: RefundInput) => {
    requireCloudLogin()
    const originalDate = tickets.find((ticket) => ticket.id === input.ticketId)?.issueDate
    await synchronise()
    await ledgerRepository.createRefund(input)
    await refresh()
    setRefundOpen(false)
    setToast(`退票已确认，已回算原出票日期 ${originalDate ?? ''} 的统计和月报。`)
    void synchronise()
  }
  const cancelRefund = async (id: string) => {
    if (requestLoginForWrite()) return
    if (!window.confirm('确认撤销这笔退票登记吗？原日期的利润和有效票量会恢复；退票明细仍保留。这只修改账本，不会转账。')) return
    try {
      await synchronise(); await ledgerRepository.cancelRefund(id); await refresh()
      setToast('退票已撤销，原日期统计已重新计算。'); void synchronise()
    } catch (error) { setToast(error instanceof Error ? error.message : '撤销未完成，请刷新核对。') }
  }

  const saveTicket = async (input: TicketInput) => {
    requireCloudLogin()
    await ledgerRepository.createOrUpdateTicket(input, selectedTicket)
    await refresh()
    setFormOpen(false)
    setToast(input.entryMode === 'profit_only' || isMonthlySettlementProject(input.projectName)
      ? '月结返佣记录已保存，仅计入月报，不计入每日统计。'
      : selectedTicket ? '记录已更新，统计已重新计算。' : '出票记录已保存，统计已更新。')
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
      const [backupSuppliers, backupProjects, backupTickets, backupRefunds] = await Promise.all([
        ledgerRepository.getSuppliers(), ledgerRepository.getProjects(), ledgerRepository.getTickets(), ledgerRepository.getRefunds()
      ])
      const aliases = await ledgerRepository.getCatalogueAliases()
      downloadLedgerBackup(createLedgerBackup({ suppliers: [...backupSuppliers, ...aliases.suppliers], projects: [...backupProjects, ...aliases.projects], tickets: backupTickets, refunds: backupRefunds }))
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
    userRef.current = null
    syncAbortRef.current?.abort()
    syncQueueRef.current?.clearPending()
    await client.auth.signOut()
    setUser(null)
    setSyncMessage('已退出云端账号；数据仍保留在本机。')
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
          {syncing ? '同步中' : user ? unsyncedCount ? '待同步' : syncMessage === '已同步到云端' ? '已同步' : '自动同步' : cloudConfigured ? '未登录' : '本机'}
        </button>
      </header>

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

          <SummaryPanel title="今日概览" subtitle="TODAY" tickets={ticketsForDailyStats(tickets, today)} note="不含月结返佣项目：69秀、79秀、泰拳、嘉年华、格兰岛一日游、潜水。" />
          <SummaryPanel title="本月月报" subtitle={`${monthRange.start} — ${monthRange.end}`} tickets={ticketsInMonth(tickets, month)} note="按出票日期统计每月1日至月底，包含月结返佣项目。" />
          <SummaryPanel title="年度年报" subtitle={`${yearRange.start} — ${yearRange.end}`} tickets={ticketsInYear(tickets, year)} note="按曼谷自然年1月1日至12月31日统计，包含月结返佣及商品利润，退票回算原记录年份。" />

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
                    <div className="rank-name"><strong>{supplier.supplierName}</strong><span>{supplier.count} {ticketsInMonth(tickets, month).some((ticket) => !ticket.deletedAt && ticket.supplierId === supplier.supplierId && isItemQuantity(ticket)) ? '条' : '张'}</span></div>
                    <strong className={supplier.profitThb >= 0 ? 'profit-value' : 'loss-value'}>{formatThb(supplier.profitThb)}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>

          {installPrompt && <button className="install-banner" type="button" onClick={() => void install()}><span>⇩</span> 添加到手机桌面，像 App 一样使用</button>}
        </> : view === 'reports' ? <ReportView tickets={tickets} suppliers={suppliers} projects={projects} /> : <>
          <section className="records-heading">
            <div><p className="eyebrow">全部有效记录</p><h1>出票记录</h1></div>
            <div className="heading-actions"><button className="secondary-button small" type="button" onClick={() => setSupplierSheetOpen(true)}>供货商</button><button className="primary-button small" type="button" onClick={openNewForm}>＋ 新增</button></div>
          </section>
          <section className="filters">
            <input aria-label="搜索供应商或备注" placeholder="搜索供应商或备注" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="filter-row">
              <input aria-label="按日期筛选" type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} />
              <select aria-label="按供应商筛选" value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}>
                <option value="">全部供应商</option>
                {suppliers.map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}</option>)}
              </select>
            </div>
            {(query || dateFilter || supplierFilter) && <button className="clear-filters" type="button" onClick={() => { setQuery(''); setDateFilter(''); setSupplierFilter('') }}>清除筛选</button>}
          </section>
          <div className="record-summary"><span>{visibleTickets.length} 条记录</span><strong>利润 {formatThb(summarise(visibleTickets).profitThb)}</strong></div>
          <section className="records-list">
            {visibleTickets.length === 0 ? <div className="empty-card">没有符合条件的记录。</div> : visibleTickets.map((ticket) => (
              <article className="ticket-card" key={ticket.id}>
                <div className="ticket-card-main">
                  <div><p>{formatDate(ticket.issueDate)} · {ticket.issueTime ? `${ticket.issueTime}（曼谷）` : '时间未记录'} · {ticket.supplierName}</p><strong>{ticket.projectName || '未分类项目'}{ticket.subItemName ? ` · ${ticket.subItemName}` : ''}</strong></div>
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

      <BottomNavigation view={view} onViewChange={setView} onAdd={openNewForm} onRefund={() => openRefund()} />

      {formOpen && <TicketForm ticket={selectedTicket} projects={projects} cloudLoginRequired={cloudConfigured && !user} onCancel={() => setFormOpen(false)} onManageSuppliers={() => { setFormOpen(false); setSupplierSheetOpen(true) }} onSave={saveTicket} />}
      {refundOpen && <RefundSheet tickets={tickets} initialTicketId={refundTicketId} onClose={() => setRefundOpen(false)} onSave={saveRefund} />}
      {supplierSheetOpen && <SupplierSheet suppliers={suppliers} projects={projects} onAddSupplier={addSupplier} onAddProject={addProject} onUpdateProject={updateProject} onBackup={backupAllData} onClose={() => setSupplierSheetOpen(false)} />}
      {loginOpen && <LoginSheet onClose={() => setLoginOpen(false)} onSent={setToast} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      <button className="export-button" onClick={() => void exportTicketsToXlsx(tickets)} type="button" title="导出全部有效记录到 Excel">{view === 'reports' ? '导出全部 Excel' : '导出 Excel'} · {formatNumber(activeTickets(tickets).length)}</button>
    </main>
  )
}
