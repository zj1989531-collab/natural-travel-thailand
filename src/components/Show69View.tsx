import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Project, TicketInput, TicketRecord } from '../types'
import { createId, formatThb, getBangkokDate, getBangkokMonth, getBangkokTime, isValidCalendarDate, isValidPersonCount, MAX_PERSON_COUNT } from '../lib/format'
import { isShow69Project, parseShow69Command, validateShow69Record, type Show69RecordInput } from '../lib/show69'
import { isBoxingProject, parseBoxingCommand } from '../lib/boxing'
import { boxingCategoryForTicket, monthlyPricingOptions, resolveMonthlyPricing, type MonthlyRecordKind } from '../lib/monthly-pricing'
import { parseTicketCommand } from '../lib/ticket-command'
import { isCarnivalProject, isKohLarnDayTripProject } from '../lib/project-rules'
import { createMonthlyTicketSnapshot } from '../lib/monthly-ticket-snapshot'
import { getTicketAmounts, getOriginalTicketAmounts } from '../lib/ticket-amounts'
import { getRefundState } from '../lib/refunds'
import { RefundHistory } from './RefundSheet'
import './Show69View.css'

interface Props {
  kind?: MonthlyRecordKind
  accountId?: string
  initialInput?: Show69RecordInput
  projects?: Project[]
  tickets: TicketRecord[]
  onSave: (input: Show69RecordInput, existing?: TicketRecord, operationId?: string, snapshot?: TicketInput) => Promise<TicketRecord>
  onDelete: (ticket: TicketRecord) => Promise<void>
  onRefund?: (ticketId: string) => void
  onCancelRefund?: (refundId: string) => void
  onManageProjects?: () => void
}

type SaveOperation = { input: Show69RecordInput; existing?: TicketRecord; operationId?: string; snapshot?: TicketInput }
const emptyInput = (): Show69RecordInput => ({ date: getBangkokDate(), guestName: '', people: 1 })

export function Show69View({ kind = 'show69', accountId, initialInput, projects = [], tickets, onSave, onDelete, onRefund, onCancelRefund, onManageProjects }: Props) {
  const title = kind === 'boxing' ? '泰拳' : kind === 'kohlarn' ? '格兰岛一日游' : kind === 'carnival' ? '东方嘉年华' : '69秀'
  const requiresPackage = kind === 'kohlarn' || kind === 'carnival'
  const needsFrozenMonthlySnapshot = requiresPackage
  const commandHelpId = `${kind}-command-help`
  const [input, setInput] = useState<Show69RecordInput>(() => initialInput ? { ...initialInput } : emptyInput())
  const [editing, setEditing] = useState<TicketRecord>()
  const [command, setCommand] = useState('')
  const [commandError, setCommandError] = useState('')
  const [commandMessage, setCommandMessage] = useState(initialInput ? `已填入${title}信息，请核对日期、所有人姓名和人数后保存。` : '')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [pendingSave, setPendingSave] = useState<SaveOperation | null>(null)
  const [month, setMonth] = useState(getBangkokMonth)
  const [date, setDate] = useState(getBangkokDate)
  const [dayOnly, setDayOnly] = useState(false)
  const [search, setSearch] = useState('')
  const mountedRef = useRef(true)
  const accountRef = useRef({ accountId, kind })
  const accountEpochRef = useRef(0)
  const mutationLock = useRef(false)
  const pasteLock = useRef(false)
  const pasteRequest = useRef(0)
  const operationRef = useRef<SaveOperation | null>(null)
  const commandRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const latest = useRef({ tickets, onSave, onDelete, accountId, kind })
  latest.current = { tickets, onSave, onDelete, accountId, kind }
  const busy = saving || deleting
  const pricingOptions = useMemo(() => editing ? [] : monthlyPricingOptions(kind, projects, input.boxingCategory), [editing, kind, projects, input.boxingCategory])
  const pricingResult = useMemo(() => {
    if (editing || kind === 'boxing' && !input.boxingCategory) return { pricing: undefined, error: '' }
    try { return { pricing: resolveMonthlyPricing(kind, input, projects), error: '' } }
    catch (failure) { return { pricing: undefined, error: failure instanceof Error ? failure.message : '请核对所选价格套餐。' } }
  }, [editing, kind, input, projects])
  const pricing = pricingResult.pricing
  const selectedProjectId = input.projectId ?? (pricingOptions.length === 1 ? pricingOptions[0].id : '')
  const invalidProjectSelection = !editing && Boolean(input.projectId?.trim()) && !pricingOptions.some(project => project.id === input.projectId?.trim())
  const entryAmounts = editing ? getTicketAmounts({ ...editing, personCount: input.people })
    : pricing && isValidPersonCount(input.people) ? getOriginalTicketAmounts({ ...pricing, personCount: input.people, amountBasis: 'per_person', entryMode: 'standard' }) : undefined
  const originalAmounts = editing ? getOriginalTicketAmounts({ ...editing, personCount: 1 }) : undefined
  const categoryLabel = (category: Show69RecordInput['boxingCategory']) => category === 'asian' ? '亚洲人' : category === 'western' ? '欧美人' : '未标注票种'

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; accountEpochRef.current++; pasteRequest.current++ }
  }, [])

  useEffect(() => {
    if (accountRef.current.accountId === accountId && accountRef.current.kind === kind) return
    accountRef.current = { accountId, kind }
    accountEpochRef.current++; pasteRequest.current++
    mutationLock.current = false; pasteLock.current = false; operationRef.current = null
    setInput(emptyInput()); setEditing(undefined); setCommand(''); setCommandError(''); setCommandMessage('')
    setError(''); setMessage(''); setSaving(false); setDeleting(false); setPasting(false); setPendingSave(null)
    setDayOnly(false); setMonth(getBangkokMonth()); setDate(getBangkokDate()); setSearch('')
  }, [accountId, kind])

  const isCurrent = (epoch: number, owner: string | undefined) => mountedRef.current && epoch === accountEpochRef.current && latest.current.accountId === owner && latest.current.kind === kind
  const cancelPaste = () => { pasteRequest.current++; pasteLock.current = false; setPasting(false) }
  const clearEntry = () => {
    cancelPaste(); operationRef.current = null; setPendingSave(null); setEditing(undefined); setInput(emptyInput())
    setCommand(''); setCommandError(''); setCommandMessage(''); setError('')
  }
  const update = <K extends keyof Show69RecordInput>(field: K, value: Show69RecordInput[K]) => {
    cancelPaste(); setInput(current => ({ ...current, [field]: value })); setError(''); setMessage('')
  }
  const fill = (text: string) => {
    if (mutationLock.current || operationRef.current) return
    cancelPaste(); setCommandError(''); setCommandMessage(''); setError(''); setMessage('')
    try {
      const parsed: Show69RecordInput = kind === 'boxing' ? parseBoxingCommand(text) : kind === 'show69' ? parseShow69Command(text) : (() => {
        const commandText = kind === 'kohlarn'
          ? text.replace(/^(?:格兰岛(?:出海|跟团)?一日游)(?:\s*出票|\s*记录)?格式\s*[:：]?\s*(?:\r?\n|$)/i, '格兰岛出海一日游\n')
          : text.replace(/^(?:东方)?嘉年华(?:\s*出票|\s*记录)?格式\s*[:：]?\s*(?:\r?\n|$)/i, '东方嘉年华\n')
        const command = parseTicketCommand(commandText, monthlyPricingOptions(kind, projects))
        if (!command.fields.issueDate || !command.fields.guestName || !command.fields.personCount) throw new Error('请填写日期、所有人姓名和人数后再识别。')
        return { date: command.fields.issueDate, guestName: command.fields.guestName, people: command.fields.personCount, projectId: command.candidates.length === 1 ? command.candidates[0].id : undefined }
      })()
      setInput(parsed)
      setCommandMessage(`已填入：${parsed.date.replaceAll('-', '/')} · ${parsed.guestName} · ${parsed.people}人。${kind === 'boxing' && !parsed.boxingCategory ? '请选择亚洲人或欧美人票种后保存。' : '请核对套餐和价格后保存。'}`)
    } catch (failure) { setCommandError(failure instanceof Error ? failure.message : '未能识别，请核对日期、所有人姓名和人数。') }
  }
  const pasteAndFill = async () => {
    if (mutationLock.current || operationRef.current || pasteLock.current) return
    cancelPaste(); setCommandError(''); setCommandMessage(''); setError(''); setMessage('')
    if (!navigator.clipboard?.readText) {
      setCommandError('当前浏览器无法直接读取剪贴板，请长按输入框粘贴，系统会自动识别。')
      commandRef.current?.focus(); return
    }
    const request = ++pasteRequest.current
    const epoch = accountEpochRef.current
    const owner = latest.current.accountId
    pasteLock.current = true; setPasting(true)
    try {
      const text = await navigator.clipboard.readText()
      if (!isCurrent(epoch, owner) || request !== pasteRequest.current) return
      if (!text.trim()) { setCommandError('剪贴板没有文字，请先复制日期、所有人姓名和人数。'); return }
      setCommand(text); fill(text)
    } catch {
      if (!isCurrent(epoch, owner) || request !== pasteRequest.current) return
      setCommandError('未能读取剪贴板，请允许浏览器粘贴，或长按上方输入框粘贴。')
      commandRef.current?.focus()
    } finally {
      if (isCurrent(epoch, owner) && request === pasteRequest.current) { pasteLock.current = false; setPasting(false) }
    }
  }
  const runSave = async (operation: SaveOperation) => {
    if (mutationLock.current || pasteLock.current) return
    const epoch = accountEpochRef.current
    const owner = latest.current.accountId
    mutationLock.current = true; setSaving(true); setError(''); setMessage('')
    try {
      const saved = await latest.current.onSave(operation.input, operation.existing, operation.operationId, operation.snapshot)
      if (!isCurrent(epoch, owner)) return
      clearEntry(); setMonth(saved.issueDate.slice(0, 7)); setDate(saved.issueDate); setDayOnly(false); setSearch('')
      setMessage(operation.existing ? `${title}记录已更新。` : `${title}记录已保存，不计入主账本报表。`)
    } catch (failure) {
      if (!isCurrent(epoch, owner)) return
      setPendingSave(operation)
      setError(`${failure instanceof Error ? failure.message : '保存结果尚未确认。'} 请重试本次保存，系统会沿用原内容和原编号。`)
    } finally {
      if (isCurrent(epoch, owner)) { mutationLock.current = false; setSaving(false) }
    }
  }
  const save = async () => {
    if (mutationLock.current || pasteLock.current) return
    if (operationRef.current) { await runSave(operationRef.current); return }
    setError(''); setMessage('')
    try {
      validateShow69Record(input)
      const matched = editing ? undefined : resolveMonthlyPricing(kind, input, projects)
      const snapshot = needsFrozenMonthlySnapshot && !editing ? createMonthlyTicketSnapshot(input, matched!, getBangkokTime()) : undefined
      const operation: SaveOperation = { input: { ...input, guestName: input.guestName.trim(), ...(!editing ? { projectId: matched?.project?.id, boxingCategory: matched?.boxingCategory } : {}) }, existing: editing, operationId: editing ? undefined : createId(), snapshot }
      operationRef.current = operation
      await runSave(operation)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '记录未保存，请核对填写内容。') }
  }
  const edit = (ticket: TicketRecord) => {
    if (mutationLock.current || operationRef.current || ticket.refunds?.length) return
    cancelPaste(); setEditing(ticket); setInput({ date: ticket.issueDate, guestName: ticket.guestName ?? '', people: ticket.personCount ?? Number.NaN, projectId: ticket.projectId ?? undefined, boxingCategory: kind === 'boxing' ? boxingCategoryForTicket(ticket) : undefined })
    setCommand(''); setCommandError(''); setCommandMessage(''); setError(''); setMessage('')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const remove = async (ticket: TicketRecord) => {
    if (mutationLock.current || operationRef.current || pasteLock.current || ticket.refunds?.length) return
    const epoch = accountEpochRef.current
    const owner = latest.current.accountId
    mutationLock.current = true; setDeleting(true); setError(''); setMessage('')
    try {
      await latest.current.onDelete(ticket)
      if (isCurrent(epoch, owner) && editing?.id === ticket.id && !latest.current.tickets.some(row => row.id === ticket.id && !row.deletedAt)) clearEntry()
    } catch (failure) {
      if (isCurrent(epoch, owner)) setError(failure instanceof Error ? failure.message : '删除未完成，请刷新核对。')
    } finally {
      if (isCurrent(epoch, owner)) { mutationLock.current = false; setDeleting(false) }
    }
  }
  const report = useMemo(() => {
    if (!isValidCalendarDate(date) || !isValidCalendarDate(`${month}-01`)) return { dayRecords: [], records: [], dayPeople: 0, monthPeople: 0, dayUnknown: 0, monthUnknown: 0, profitThb: 0, error: '请选择有效的日期和月份。' }
    const matching = kind === 'boxing' ? isBoxingProject : kind === 'kohlarn' ? isKohLarnDayTripProject : kind === 'carnival' ? isCarnivalProject : isShow69Project
    const all = tickets.filter(ticket => !ticket.deletedAt && matching(ticket.projectName) && isValidCalendarDate(ticket.issueDate))
    const sort = (rows: TicketRecord[]) => rows.sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    const dayRecords = sort(all.filter(ticket => ticket.issueDate === date))
    const records = sort(all.filter(ticket => ticket.issueDate.startsWith(`${month}-`)))
    const people = (rows: TicketRecord[]) => rows.reduce((sum, ticket) => sum + (ticket.entryMode === 'profit_only' ? 0 : getRefundState(ticket).remainingPeople ?? 0), 0)
    const unknown = (rows: TicketRecord[]) => rows.filter(ticket => ticket.entryMode !== 'profit_only' && getRefundState(ticket).remainingPeople == null).length
    const profitThb = records.reduce((sum, ticket) => sum + Math.round(getTicketAmounts(ticket).profitThb * 100), 0) / 100
    return { dayRecords, records, dayPeople: people(dayRecords), monthPeople: people(records), dayUnknown: unknown(dayRecords), monthUnknown: unknown(records), profitThb, error: '' }
  }, [tickets, kind, date, month])
  const records = (dayOnly ? report.dayRecords : report.records)?.filter(ticket => !search.trim() || `${ticket.guestName ?? ''} ${ticket.note}`.toLowerCase().includes(search.trim().toLowerCase())) ?? []

  return <section className="show79-view show69-view">
    <div className="records-heading"><div><p className="eyebrow">独立账本 · THB · 曼谷时间</p><h1>{title}</h1></div>{onManageProjects && <button type="button" className="secondary-button small" onClick={onManageProjects}>供货商 / 套餐</button>}</div>
    <p className="sheet-copy">{title}的订单、人数和利润独立统计，不计入主账本日报、月报、年报及排行。</p>
    <div className="show79-filters"><label>查询日期<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label>报表月份<input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label></div>
    {report.error && <p role="alert" className="form-error">{report.error}</p>}
    {!report.error && <div className="show79-metrics" aria-label={`${title}统计`}><div><span>当日人数 · {date.replaceAll('-', '/')}</span><strong>{report.dayPeople} 人</strong>{report.dayUnknown > 0 && <small>另有{report.dayUnknown}笔人数未填</small>}</div><div><span>月人数 · {month.replace('-', '/')}</span><strong>{report.monthPeople} 人</strong>{report.monthUnknown > 0 && <small>另有{report.monthUnknown}笔人数未填</small>}</div><div><span>月实际利润</span><strong>{formatThb(report.profitThb)}</strong></div><div><span>月订单数（含退票记录）</span><strong>{report.records.length} 单</strong></div></div>}
    <section className="show79-entry"><h2>{editing ? `编辑${title}订单` : `新增${title}订单`}</h2>
      {!editing && <div className="show79-command">
        <label>一键填写信息<textarea ref={commandRef} rows={4} disabled={busy || Boolean(pendingSave)} value={command} aria-invalid={Boolean(commandError)} aria-describedby={commandHelpId} placeholder={`${title}记录格式\n日期：10月23\n名字（所有人）：韩廷富,邵建华,江华兴\n人数：3${kind === 'boxing' ? '\n票种：亚洲人' : requiresPackage ? '\n套餐：C' : ''}`} onChange={event => { cancelPaste(); setCommand(event.target.value); setCommandError(''); setCommandMessage('') }} onPaste={event => {
          if (mutationLock.current || operationRef.current) return
          const text = event.clipboardData.getData('text/plain')
          if (!text.trim()) return
          event.preventDefault(); setCommand(text); fill(text)
        }} /></label>
        <p className="sheet-copy" id={commandHelpId}>日期可写 10.18、10/18、今天、明天或10月18日；未写年份时使用曼谷当前年份。{requiresPackage ? '请写明一个套餐。' : ''}核对下方信息后保存。</p>
        <button type="button" className="secondary-button" disabled={busy || pasting || Boolean(pendingSave)} aria-busy={pasting} onClick={() => void pasteAndFill()}>{pasting ? '正在粘贴…' : '粘贴 / 自动填入'}</button>
        {command.trim() && <button type="button" className="text-action" disabled={busy || pasting || Boolean(pendingSave)} onClick={() => fill(command)}>识别当前文字</button>}
        {commandError && <p className="form-error" role="alert">{commandError}</p>}
        {commandMessage && <p className="sheet-copy" role="status">{commandMessage}</p>}
      </div>}
      <form className="ticket-form" ref={formRef} onSubmit={(event: FormEvent) => { event.preventDefault(); void save() }}>
        <fieldset className="form-fields" disabled={busy || Boolean(pendingSave)}>
          <label>日期<input type="date" required value={input.date} onChange={event => update('date', event.target.value)} /></label>
          <label>名字（所有人）<textarea required rows={3} maxLength={100} value={input.guestName} placeholder="填写所有人的姓名，用逗号分隔" onChange={event => update('guestName', event.target.value)} /></label>
          <label>人数<input type="number" inputMode="numeric" required min="1" max={MAX_PERSON_COUNT} step="1" value={Number.isFinite(input.people) ? input.people : ''} onChange={event => update('people', event.target.value === '' ? Number.NaN : Number(event.target.value))} /></label>
          {kind === 'boxing' && (editing ? <p className="sheet-copy">票种：{categoryLabel(boxingCategoryForTicket(editing))} · 保留原记录</p> : <label>票种<select required value={input.boxingCategory ?? ''} onChange={event => {
            cancelPaste(); setInput(current => ({ ...current, boxingCategory: (event.target.value || undefined) as Show69RecordInput['boxingCategory'], projectId: undefined })); setError(''); setMessage('')
          }}><option value="" disabled>请选择亚洲人或欧美人</option><option value="asian">亚洲人</option><option value="western">欧美人</option></select></label>)}
          {!editing && (kind !== 'boxing' || input.boxingCategory) && pricingOptions.length > 1 && <label>{requiresPackage ? '套餐' : '供货商套餐'}<select required value={selectedProjectId} onChange={event => update('projectId', event.target.value || undefined)}><option value="" disabled>请选择本次价格套餐</option>{pricingOptions.map(project => <option key={project.id} value={project.id}>{project.supplierName} · {project.name}{project.subItemName ? ` · ${project.subItemName}` : ''}</option>)}</select></label>}
          {editing ? <p className="sheet-copy">保留原记录的套餐、金额与计价方式，仅修改日期、姓名和人数。</p> : pricing?.project && <p className="sheet-copy">价格套餐：{pricing.project.supplierName} · {pricing.project.name}{pricing.project.subItemName ? ` · ${pricing.project.subItemName}` : ''}</p>}
          {kind === 'boxing' && !editing && !input.boxingCategory && <p className="sheet-copy" role="status">请选择亚洲人或欧美人票种，系统将自动带入对应价格。</p>}
          {pricingResult.error && <p className="form-error" role="alert">{pricingResult.error}</p>}
          {pricingResult.error && invalidProjectSelection && <button type="button" className="secondary-button" onClick={() => update('projectId', undefined)}>重新匹配价格</button>}
          {(pricing || editing) && <section className="show69-pricing" aria-label={editing ? '原记录价格' : '自动匹配价格'}>
            <p>{editing ? editing.amountBasis === 'per_person' ? '原记录每人金额' : '原记录整单金额' : '每人价格'}（THB）</p>
            <dl><div><dt>代理价</dt><dd>{formatThb(editing ? originalAmounts!.agentPriceThb : pricing!.agentPriceThb)}</dd></div><div><dt>成本</dt><dd>{formatThb(editing ? originalAmounts!.costThb : pricing!.costThb)}</dd></div><div><dt>利润</dt><dd>{formatThb(editing ? originalAmounts!.profitThb : pricing!.profitThb)}</dd></div></dl>
            {entryAmounts ? <><p>{editing?.amountBasis === 'total' || editing && !editing.amountBasis ? '整单合计' : `${input.people} 人合计`}（THB）</p><dl><div><dt>总售价</dt><dd>{formatThb(entryAmounts.agentPriceThb)}</dd></div><div><dt>总成本</dt><dd>{formatThb(entryAmounts.costThb)}</dd></div><div><dt>总利润</dt><dd>{formatThb(entryAmounts.profitThb)}</dd></div></dl></> : <p className="sheet-copy">请填写有效人数以计算合计。</p>}
          </section>}
          <button type="submit" className="primary-button" disabled={busy || pasting}>{saving ? '保存中…' : editing ? '保存修改' : '保存记录'}</button>
        </fieldset>
        {editing && !pendingSave && <button type="button" className="text-action" disabled={busy} onClick={() => { clearEntry(); setMessage('') }}>取消编辑</button>}
        {pendingSave && <div className="show69-retry"><p className="sheet-copy">请先核对这次保存结果。重试会沿用原内容和原编号，避免重复新增。</p><button type="button" className="primary-button" disabled={busy || pasting} onClick={() => void runSave(pendingSave)}>重试本次保存</button><button type="button" className="text-action" disabled={busy || pasting} onClick={() => { clearEntry(); setMessage('已开始新记录，请在下方核对上次保存结果。') }}>核对后开始新记录</button></div>}
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="sheet-copy" role="status">{message}</p>}
    </section>
    <section className="show79-orders"><h2>{title}订单</h2><div className="show79-filters"><label>订单范围<select value={dayOnly ? 'day' : 'month'} onChange={event => setDayOnly(event.target.value === 'day')}><option value="month">指定月份</option><option value="day">指定日期</option></select></label><label>搜索客户 / 备注<input value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      {!records.length && <p className="empty-card">当前范围没有{title}订单。</p>}
      <div className="records-list">{records.map(ticket => {
        const amounts = getTicketAmounts(ticket)
        const refund = getRefundState(ticket)
        return <article className="ticket-card" key={ticket.id}>
        <div className="ticket-card-main"><div><p>{ticket.issueDate.replaceAll('-', '/')}</p><strong className="show69-names">{ticket.guestName?.trim() || '姓名未记录'}</strong></div><strong>{ticket.personCount ?? '未填'} 人</strong></div>
        {kind === 'boxing' && <p className="sheet-copy">票种：{categoryLabel(boxingCategoryForTicket(ticket))}</p>}
        <div className="show69-record-amounts"><span>净售价 {formatThb(amounts.agentPriceThb)}</span><span>净成本 {formatThb(amounts.costThb)}</span><strong>净利润 {formatThb(amounts.profitThb)}</strong></div>
        {ticket.syncStatus !== 'synced' && <p className="sheet-copy">等待同步</p>}
        {Boolean(ticket.refunds?.length) && <p className="sheet-copy">此记录已有退票明细，保留原记录。</p>}
        <RefundHistory ticket={ticket} onCancel={onCancelRefund} />
        <div className="ticket-actions">{onRefund && ticket.entryMode !== 'profit_only' && !refund.full && <button type="button" disabled={busy || pasting || Boolean(pendingSave)} onClick={() => onRefund(ticket.id)}>退票</button>}<button type="button" disabled={busy || pasting || Boolean(pendingSave) || Boolean(ticket.refunds?.length)} onClick={() => edit(ticket)}>编辑</button><button type="button" className="danger-action" disabled={busy || pasting || Boolean(pendingSave) || Boolean(ticket.refunds?.length)} onClick={() => void remove(ticket)}>删除</button></div>
      </article>})}</div>
    </section>
  </section>
}
