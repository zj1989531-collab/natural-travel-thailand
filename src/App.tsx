import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { exportTicketsToXlsx } from './lib/export'
import { formatDate, formatNumber, formatThb, getBangkokDate, getBangkokMonth } from './lib/format'
import { ledgerRepository } from './lib/repository'
import { cloudConfigured, getSupabase } from './lib/supabase'
import { createSyncQueue, type SyncQueue } from './lib/sync'
import { activeTickets, bySupplier, getProfit, summarise, ticketsInMonth, ticketsOnDate } from './lib/stats'
import type { Project, Supplier, TicketInput, TicketRecord } from './types'

type View = 'dashboard' | 'records'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface TicketFormProps {
  ticket?: TicketRecord
  suppliers: Supplier[]
  projects: Project[]
  onCancel: () => void
  onManageSuppliers: () => void
  onSave: (input: TicketInput) => Promise<void>
}

const emptyForm = (): TicketInput => ({
  issueDate: getBangkokDate(),
  supplierName: '',
  projectId: '',
  projectName: '',
  subItemName: '',
  agentPriceThb: Number.NaN,
  costThb: Number.NaN,
  note: ''
})

function MetricCard({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'profit' | 'cost' }) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SummaryPanel({ title, subtitle, tickets }: { title: string; subtitle: string; tickets: TicketRecord[] }) {
  const summary = summarise(tickets)
  return (
    <section className="summary-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{subtitle}</p>
          <h2>{title}</h2>
        </div>
        <span className="ticket-count">{summary.count} 张</span>
      </div>
      <div className="metrics-grid">
        <MetricCard label="代理售价" value={formatThb(summary.agentPriceThb)} />
        <MetricCard label="供货商成本" value={formatThb(summary.costThb)} tone="cost" />
        <MetricCard label="盈利" value={formatThb(summary.profitThb)} tone="profit" />
      </div>
    </section>
  )
}

function TicketForm({ ticket, suppliers, projects, onCancel, onManageSuppliers, onSave }: TicketFormProps) {
  const [form, setForm] = useState<TicketInput>(() => ticket ? {
    issueDate: ticket.issueDate,
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
      setError('请填写出票日期，并选择供货商和项目。')
      return
    }
    if (!Number.isFinite(form.agentPriceThb) || !Number.isFinite(form.costThb) || form.agentPriceThb < 0 || form.costThb < 0) {
      setError('实收和成本必须是大于或等于 0 的金额。')
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

  const selectedSupplier = suppliers.find((supplier) => supplier.name === form.supplierName)
  const availableProjects = projects.filter((project) => project.supplierId === selectedSupplier?.id)
  const projectNames = [...new Set(availableProjects.map((project) => project.name))]
  const availableSubItems = availableProjects.filter((project) => project.name === form.projectName)
  const profit = (Number.isFinite(form.agentPriceThb) ? form.agentPriceThb : 0) - (Number.isFinite(form.costThb) ? form.costThb : 0)

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
        <form className="ticket-form" onSubmit={submit}>
          <label>
            出票日期
            <input type="date" value={form.issueDate} onChange={(event) => update('issueDate', event.target.value)} required />
          </label>
          <label>
            供货商
            <select value={form.supplierName} onChange={(event) => setForm((current) => ({ ...current, supplierName: event.target.value, projectId: '', projectName: '', subItemName: '', agentPriceThb: Number.NaN, costThb: Number.NaN }))} required>
              <option value="">请选择供货商</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.name}>{supplier.name}</option>)}
            </select>
          </label>
          {suppliers.length === 0 && <button className="inline-action" type="button" onClick={onManageSuppliers}>还没有供货商？现在录入</button>}
          <label>
            项目
            <select value={form.projectName} disabled={!selectedSupplier} onChange={(event) => {
              const nextProjectName = event.target.value
              const noSubItem = availableProjects.find((project) => project.name === nextProjectName && !project.subItemName)
              setForm((current) => noSubItem ? { ...current, projectId: noSubItem.id, projectName: noSubItem.name, subItemName: '', costThb: noSubItem.defaultCostThb, agentPriceThb: noSubItem.defaultAgentPriceThb } : { ...current, projectId: '', projectName: nextProjectName, subItemName: '', agentPriceThb: Number.NaN, costThb: Number.NaN })
            }} required>
              <option value="">{selectedSupplier ? '请选择项目' : '请先选择供货商'}</option>
              {projectNames.map((projectName) => <option key={projectName} value={projectName}>{projectName}</option>)}
            </select>
          </label>
          <label>
            子项 / 套餐 <span className="muted">（可选）</span>
            <select value={form.projectId} disabled={!form.projectName} onChange={(event) => {
              const selectedProject = availableSubItems.find((project) => project.id === event.target.value)
              setForm((current) => selectedProject ? { ...current, projectId: selectedProject.id, projectName: selectedProject.name, subItemName: selectedProject.subItemName, costThb: selectedProject.defaultCostThb, agentPriceThb: selectedProject.defaultAgentPriceThb } : { ...current, projectId: '', subItemName: '' })
            }} required>
              <option value="">{form.projectName ? '请选择子项/套餐' : '请先选择项目'}</option>
              {availableSubItems.map((project) => <option key={project.id} value={project.id}>{project.subItemName || '不分套餐'}</option>)}
            </select>
          </label>
          {selectedSupplier && availableProjects.length === 0 && <button className="inline-action" type="button" onClick={onManageSuppliers}>该供货商还没有项目价格，去录入</button>}
          <div className="form-grid">
            <label>
              代理售价（THB）
              <input inputMode="decimal" min="0" step="0.01" type="number" value={Number.isFinite(form.agentPriceThb) ? form.agentPriceThb : ''} onChange={(event) => update('agentPriceThb', event.target.value === '' ? Number.NaN : Number(event.target.value))} required />
            </label>
            <label>
              供货商成本（THB）
              <input inputMode="decimal" min="0" step="0.01" type="number" value={Number.isFinite(form.costThb) ? form.costThb : ''} onChange={(event) => update('costThb', event.target.value === '' ? Number.NaN : Number(event.target.value))} required />
            </label>
          </div>
          <div className={`profit-preview ${profit >= 0 ? 'positive' : 'negative'}`}>
            <span>本张票盈利</span>
            <strong>{formatThb(profit)}</strong>
          </div>
          <label>
            备注 <span className="muted">（可选）</span>
            <textarea maxLength={300} placeholder="例如航线、特殊说明" value={form.note} onChange={(event) => update('note', event.target.value)} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="sheet-actions">
            <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
            <button className="primary-button" type="submit" disabled={saving}>{saving ? '保存中…' : '保存记录'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function SupplierSheet({ suppliers, projects, onAddSupplier, onAddProject, onUpdateProject, onClose }: {
  suppliers: Supplier[]
  projects: Project[]
  onAddSupplier: (name: string) => Promise<void>
  onAddProject: (input: { supplierId: string; name: string; subItemName: string; defaultCostThb: number; defaultAgentPriceThb: number }) => Promise<void>
  onUpdateProject: (id: string, input: { defaultCostThb: number; defaultAgentPriceThb: number }) => Promise<void>
  onClose: () => void
}) {
  const [supplierName, setSupplierName] = useState('')
  const [projectSupplierId, setProjectSupplierId] = useState('')
  const [projectName, setProjectName] = useState('')
  const [subItemName, setSubItemName] = useState('')
  const [cost, setCost] = useState('')
  const [agentPrice, setAgentPrice] = useState('')
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
        await onUpdateProject(editingProject.id, { defaultCostThb: Number(cost), defaultAgentPriceThb: Number(agentPrice) })
      } else {
        await onAddProject({ supplierId: projectSupplierId, name: projectName, subItemName, defaultCostThb: Number(cost), defaultAgentPriceThb: Number(agentPrice) })
      }
      setProjectName('')
      setSubItemName('')
      setCost('')
      setAgentPrice('')
      setEditingProject(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试。')
    } finally {
      setSaving(null)
    }
  }

  const editProject = (project: Project) => {
    setEditingProject(project)
    setProjectSupplierId(project.supplierId)
    setProjectName(project.name)
    setSubItemName(project.subItemName)
    setCost(String(project.defaultCostThb))
    setAgentPrice(String(project.defaultAgentPriceThb))
    setError('')
  }

  const cancelProjectEdit = () => {
    setEditingProject(null)
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
            <div className="form-grid">
              <input inputMode="decimal" min="0" step="0.01" type="number" placeholder="供货商成本（THB）" value={cost} onChange={(event) => setCost(event.target.value)} required />
              <input inputMode="decimal" min="0" step="0.01" type="number" placeholder="代理售价（THB）" value={agentPrice} onChange={(event) => setAgentPrice(event.target.value)} required />
            </div>
            <button className="primary-button full-width" type="submit" disabled={saving !== null}>{saving === 'project' ? '保存中…' : editingProject ? '保存价格修改' : '保存子项价格'}</button>
            {editingProject && <button className="secondary-button" type="button" disabled={saving !== null} onClick={cancelProjectEdit}>取消修改</button>}
          </form>
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}

        <section className="supplier-list" aria-label="已录入的价格表">
          <div className="supplier-list-heading"><span>已录入子项</span><strong>{projects.length}</strong></div>
          {projects.length === 0 ? <p className="supplier-empty">还没有项目子项，请先添加一个。</p> : projects.map((project) => <div className="project-row" key={project.id}><div><strong>{project.name}{project.subItemName ? ` · ${project.subItemName}` : ' · 不分套餐'}</strong><span>{project.supplierName}</span></div><div><span>成本 {formatThb(project.defaultCostThb)}</span><strong>售价 {formatThb(project.defaultAgentPriceThb)}</strong><button className="edit-price-button" type="button" disabled={saving !== null} aria-label={`编辑价格：${project.name} / ${project.subItemName || '不分套餐'} / ${project.supplierName}`} onClick={() => editProject(project)}>编辑价格</button></div></div>)}
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
    setTickets(nextTickets)
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
    for (const table of ['suppliers', 'projects', 'tickets']) {
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
  const visibleTickets = useMemo(() => activeTickets(tickets).filter((ticket) => {
    const dateMatches = !dateFilter || ticket.issueDate === dateFilter
    const supplierMatches = !supplierFilter || ticket.supplierId === supplierFilter
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const queryMatches = !normalizedQuery || ticket.supplierName.toLocaleLowerCase().includes(normalizedQuery) || ticket.projectName.toLocaleLowerCase().includes(normalizedQuery) || ticket.note.toLocaleLowerCase().includes(normalizedQuery)
    return dateMatches && supplierMatches && queryMatches
  }).sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt)), [tickets, dateFilter, supplierFilter, query])

  const monthlySupplierStats = useMemo(() => bySupplier(ticketsInMonth(tickets, month)), [tickets, month])
  const unsyncedCount = [...tickets, ...suppliers, ...projects].filter((record) => record.syncStatus !== 'synced').length

  const openNewForm = () => {
    setSelectedTicket(undefined)
    setFormOpen(true)
  }

  const saveTicket = async (input: TicketInput) => {
    await ledgerRepository.createOrUpdateTicket(input, selectedTicket)
    await refresh()
    setFormOpen(false)
    setToast(selectedTicket ? '记录已更新，统计已重新计算。' : '出票记录已保存，统计已更新。')
    void synchronise()
  }

  const addSupplier = async (name: string) => {
    await ledgerRepository.createSupplier(name)
    await refresh()
    setToast('供货商已录入，新增出票时可以直接选择。')
    void synchronise()
  }

  const addProject = async (input: { supplierId: string; name: string; subItemName: string; defaultCostThb: number; defaultAgentPriceThb: number }) => {
    await ledgerRepository.createProject(input)
    await refresh()
    setToast('项目价格已录入，新增出票时可以直接选择。')
    void synchronise()
  }

  const updateProject = async (id: string, input: { defaultCostThb: number; defaultAgentPriceThb: number }) => {
    await ledgerRepository.updateProjectPrices(id, input)
    await refresh()
    setToast('项目价格已修改，已有出票记录保持原金额。')
    void synchronise()
  }

  const deleteTicket = async (ticket: TicketRecord) => {
    if (!window.confirm(`确认删除 ${formatDate(ticket.issueDate)} 的「${ticket.supplierName}」记录吗？删除后将不再计入统计。`)) return
    await ledgerRepository.deleteTicket(ticket)
    await refresh()
    setToast('记录已删除，统计已重新计算。')
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
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">฿</div>
          <div>
            <p>票务盈利簿</p>
            <span>THB · Asia/Bangkok</span>
          </div>
        </div>
        <button className="header-action" type="button" onClick={() => void synchronise()} disabled={!user || syncing}>
          {syncing ? '同步中' : user ? '同步' : '本机'}
        </button>
      </header>

      <div className="page-content">
        {view === 'dashboard' ? <>
          <section className="welcome-row">
            <div>
              <p className="eyebrow">{formatDate(today)}</p>
              <h1>今天的盈利，一眼掌握。</h1>
            </div>
            <button className="round-add" onClick={openNewForm} type="button" aria-label="新增出票记录">＋</button>
          </section>

          {cloudConfigured ? (
            <section className={`sync-banner ${user ? 'connected' : ''}`}>
              <div><strong>{user ? '云端自动同步已启用' : '连接云端，换机也不丢账'}</strong><span>{user ? `${user.email ?? '当前账号'} · ${unsyncedCount ? `${unsyncedCount} 条待同步` : syncMessage || '全部记录已同步'}` : '登录后，当前本机记录会安全同步到你的私人账号。'}</span></div>
              {user ? <button type="button" onClick={() => void signOut()}>退出</button> : <button type="button" onClick={() => setLoginOpen(true)}>登录</button>}
            </section>
          ) : (
            <section className="sync-banner warning">
              <div><strong>当前为本机账本模式</strong><span>配置 Supabase 后即可启用邮箱登录与云端同步。</span></div>
            </section>
          )}

          <SummaryPanel title="今日概览" subtitle="TODAY" tickets={ticketsOnDate(tickets, today)} />
          <SummaryPanel title="本月概览" subtitle={month} tickets={ticketsInMonth(tickets, month)} />

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
                    <div className="rank-name"><strong>{supplier.supplierName}</strong><span>{supplier.count} 张 · 代理售价 {formatThb(supplier.agentPriceThb)}</span></div>
                    <strong className={supplier.profitThb >= 0 ? 'profit-value' : 'loss-value'}>{formatThb(supplier.profitThb)}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>

          {installPrompt && <button className="install-banner" type="button" onClick={() => void install()}><span>⇩</span> 添加到手机桌面，像 App 一样使用</button>}
        </> : <>
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
          <div className="record-summary"><span>{visibleTickets.length} 张记录</span><strong>利润 {formatThb(summarise(visibleTickets).profitThb)}</strong></div>
          <section className="records-list">
            {visibleTickets.length === 0 ? <div className="empty-card">没有符合条件的记录。</div> : visibleTickets.map((ticket) => (
              <article className="ticket-card" key={ticket.id}>
                <div className="ticket-card-main">
                  <div><p>{formatDate(ticket.issueDate)} · {ticket.supplierName}</p><strong>{ticket.projectName || '未分类项目'}{ticket.subItemName ? ` · ${ticket.subItemName}` : ''}</strong></div>
                  <strong className={getProfit(ticket) >= 0 ? 'profit-value' : 'loss-value'}>{formatThb(getProfit(ticket))}</strong>
                </div>
                <div className="ticket-meta"><span>代理售价 {formatThb(ticket.agentPriceThb)}</span><span>成本 {formatThb(ticket.costThb)}</span></div>
                {ticket.note && <p className="ticket-note">{ticket.note}</p>}
                <div className="ticket-actions"><button type="button" onClick={() => { setSelectedTicket(ticket); setFormOpen(true) }}>编辑</button><button className="danger-action" type="button" onClick={() => void deleteTicket(ticket)}>删除</button></div>
              </article>
            ))}
          </section>
        </>}
      </div>

      <nav className="bottom-nav" aria-label="主导航">
        <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')} type="button"><span>▦</span>概览</button>
        <button className="nav-add" onClick={openNewForm} type="button" aria-label="新增出票记录">＋</button>
        <button className={view === 'records' ? 'active' : ''} onClick={() => setView('records')} type="button"><span>▤</span>记录</button>
      </nav>

      {formOpen && <TicketForm ticket={selectedTicket} suppliers={suppliers} projects={projects} onCancel={() => setFormOpen(false)} onManageSuppliers={() => { setFormOpen(false); setSupplierSheetOpen(true) }} onSave={saveTicket} />}
      {supplierSheetOpen && <SupplierSheet suppliers={suppliers} projects={projects} onAddSupplier={addSupplier} onAddProject={addProject} onUpdateProject={updateProject} onClose={() => setSupplierSheetOpen(false)} />}
      {loginOpen && <LoginSheet onClose={() => setLoginOpen(false)} onSent={setToast} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      <button className="export-button" onClick={() => void exportTicketsToXlsx(tickets)} type="button" title="导出全部有效记录到 Excel">导出 Excel · {formatNumber(activeTickets(tickets).length)}</button>
    </main>
  )
}
