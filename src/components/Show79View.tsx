import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { AmountBasis, Project, TicketInput, TicketRecord } from '../types'
import { buildShow79Report, isShow79Project, parseShow79Command, validateShow79Voucher, voucherDate, type Show79VoucherInput } from '../lib/show79'
import { createId, formatThb, getBangkokDate, getBangkokMonth, getBangkokTime } from '../lib/format'
import { createShow79Voucher, downloadVoucher, printVoucher, voucherFilename } from '../lib/show79-voucher'
import { createShow79PreviewGuard, isShow79PreviewCurrent, savedShow79Preview, show79DraftSource, show79PreviewTickets, type Show79PreviewSource } from '../lib/show79-preview'
import { getTicketAmounts } from '../lib/ticket-amounts'
import { getRefundState } from '../lib/refunds'
import { exportShow79ToXlsx } from '../lib/export'
import { RefundHistory } from './RefundSheet'
import { SaveWarning } from './SaveWarning'
import { ticketWarnings, validateDraftAmounts } from '../lib/entry-warnings'
import { resolveProjectRules } from '../lib/project-rules'
import { Show79SettlementPanel } from './Show79SettlementPanel'
import type { Show79SettlementInput, Show79SettlementRecord } from '../lib/show79-settlement'

interface Props {
  tickets: TicketRecord[]
  projects: Project[]
  settlements?: Show79SettlementRecord[]
  onSaveSettlement?: (input: Show79SettlementInput) => Promise<void>
  onSave: (input: TicketInput, existing?: TicketRecord, operationId?: string) => Promise<TicketRecord>
  onDelete: (ticket: TicketRecord) => Promise<void>
  onRefund: (id: string) => void
  onCancelRefund: (id: string) => void
  onManageProjects: () => void
}

type Preview = { url: string; blob: Blob; input: Show79VoucherInput; source: Show79PreviewSource }
type SaveOperation = { draft: TicketInput; existing?: TicketRecord; operationId?: string; generate: boolean }

export function Show79View({ tickets, projects, settlements = [], onSaveSettlement, onSave, onDelete, onRefund, onCancelRefund, onManageProjects }: Props) {
  const [date, setDate] = useState(getBangkokDate)
  const [month, setMonth] = useState(getBangkokMonth)
  const [dayOnly, setDayOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [command, setCommand] = useState('')
  const [commandError, setCommandError] = useState('')
  const [commandMessage, setCommandMessage] = useState('')
  const [pasting, setPasting] = useState(false)
  const [input, setInput] = useState<Show79VoucherInput>(() => ({ guestName: '', date: getBangkokDate(), people: 1 }))
  const showProjects = useMemo(() => projects.filter(project => isShow79Project(project.name) && project.quantityUnit !== 'item'), [projects])
  const [projectId, setProjectId] = useState('')
  const [basis, setBasis] = useState<AmountBasis>('per_person')
  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')
  const [commission, setCommission] = useState('')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState<TicketRecord>()
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const busy = saving || generating
  const saveLock = useRef(false)
  const operationRef = useRef<SaveOperation | null>(null)
  const [pendingSave, setPendingSave] = useState<SaveOperation | null>(null)
  const [savedOrder, setSavedOrder] = useState<TicketRecord>()
  const [warning, setWarning] = useState<{ messages: string[]; key: string; draft: TicketInput; generate: boolean } | null>(null)
  useEffect(() => { setWarning(null) }, [input, projectId, basis, price, cost, commission, note])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<Preview>()
  const urlRef = useRef<string | undefined>(undefined)
  const guardRef = useRef(createShow79PreviewGuard())
  const generationSource = useRef<Show79PreviewSource | undefined>(undefined)
  const latest = useRef({ tickets, input })
  latest.current = { tickets, input }
  // The confirmed return value bridges the render before the parent's refreshed
  // list arrives. Any subsequent list revision must contain the actual order.
  const confirmedRef = useRef<{ ticket: TicketRecord; baseline: TicketRecord[] } | null>(null)
  const pasteRequestRef = useRef(0)
  const pasteLock = useRef(false)
  const mountedRef = useRef(true)
  const commandRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; guardRef.current.invalidate(); pasteRequestRef.current++; if (urlRef.current) URL.revokeObjectURL(urlRef.current) } }, [])
  const project = showProjects.find(project => project.id === projectId)
  useEffect(() => {
    if (!projectId && showProjects.length === 1 && !editing) {
      const only = showProjects[0]
      setProjectId(only.id); setBasis(resolveProjectRules(only).defaultAmountBasis); setPrice(only.manualAgentPrice ? '' : String(only.defaultAgentPriceThb)); setCost(String(only.defaultCostThb))
    }
  }, [projectId, showProjects, editing])
  const result = useMemo(() => {
    try { return { report: buildShow79Report(tickets, date, month), error: '' } }
    catch (e) { return { report: null, error: e instanceof Error ? e.message : '日期无效。' } }
  }, [tickets, date, month])
  const report = result.report
  const records = (dayOnly ? report?.dayRecords : report?.records)?.filter(ticket => !search.trim() || `${ticket.guestName ?? ''} ${ticket.note}`.toLowerCase().includes(search.trim().toLowerCase())) ?? []
  const currentTickets = () => show79PreviewTickets(latest.current.tickets, confirmedRef.current)
  const sourceIsCurrent = (source: Show79PreviewSource) => isShow79PreviewCurrent(source, latest.current.input, currentTickets())
  const closePreview = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = undefined; setPreview(undefined)
  }
  const invalidatePreview = () => { guardRef.current.invalidate(); generationSource.current = undefined; setGenerating(false); closePreview() }
  const visiblePreview = preview && sourceIsCurrent(preview.source) ? preview : undefined
  useEffect(() => {
    const source = generationSource.current ?? preview?.source
    if (source && !sourceIsCurrent(source)) {
      invalidatePreview(); setMessage('订单或退票信息已更新，旧确认单已失效，请重新生成。')
    }
  }, [tickets, input, preview])
  const cancelPaste = () => { pasteRequestRef.current++; pasteLock.current = false; setPasting(false) }
  const update = <K extends keyof Show79VoucherInput>(key: K, value: Show79VoucherInput[K]) => { cancelPaste(); invalidatePreview(); setInput(current => ({ ...current, [key]: value })) }
  const changeFinancial = (change: () => void) => { invalidatePreview(); change() }
  const selectProject = (id: string) => {
    invalidatePreview(); setProjectId(id)
    const selected = showProjects.find(project => project.id === id)
    setPrice(selected && !selected.manualAgentPrice ? String(selected.defaultAgentPriceThb) : '')
    setCost(selected ? String(selected.defaultCostThb) : ''); setCommission('')
    if (selected) setBasis(resolveProjectRules(selected).defaultAmountBasis)
  }
  const showPreview = async (value: Show79VoucherInput, source: Show79PreviewSource = show79DraftSource(value, editing)) => {
    const request = guardRef.current.begin()
    generationSource.current = source
    closePreview(); setError(''); setGenerating(true)
    try {
      validateShow79Voucher(value)
      if (!sourceIsCurrent(source)) throw new Error('订单信息已变化，请重新打开订单后核对。')
      const blob = await guardRef.current.render(request, () => createShow79Voucher(value), () => sourceIsCurrent(source))
      if (!blob || !mountedRef.current) return
      closePreview(); const url = URL.createObjectURL(blob); urlRef.current = url
      setPreview({ url, blob, input: { ...value }, source })
    } catch (e) { if (guardRef.current.isLatest(request) && mountedRef.current) setError((source.kind === 'saved' ? '订单已记账，图片生成失败；请仅重新生成，不要重复保存。' : '未记账，图片生成失败。') + (e instanceof Error ? e.message : '请重试。')) }
    finally { if (guardRef.current.isLatest(request) && mountedRef.current) setGenerating(false) }
  }
  const previewSaved = async (ticket: TicketRecord) => {
    try {
      const current = currentTickets().find(row => row.id === ticket.id && row.userId === ticket.userId)
      if (!current) throw new Error('订单已更新或删除，请刷新核对。')
      const next = savedShow79Preview(current)
      await showPreview(next.input, next.source)
    } catch (e) { setError(e instanceof Error ? e.message : '订单状态已变化，请重新核对。') }
  }
  const fillCommand = (text: string) => {
    if (busy || pendingSave) return
    cancelPaste()
    setCommandError(''); setCommandMessage(''); setError(''); setMessage('')
    try {
      const parsed = parseShow79Command(text)
      invalidatePreview(); setInput(parsed)
      setCommandMessage(`已填入：${parsed.guestName} · ${voucherDate(parsed.date)} · ${parsed.people}人。请核对后生成图片或保存订单。`)
    } catch (e) { setCommandError(e instanceof Error ? e.message : '未能识别订单。') }
  }
  const pasteAndFill = async () => {
    if (busy || pendingSave || pasteLock.current) return
    setCommandError(''); setCommandMessage(''); setError(''); setMessage('')
    if (!navigator.clipboard?.readText) {
      setCommandError('当前浏览器无法直接读取剪贴板。请长按上方输入框黏贴，系统会自动识别；也可输入文字后点“识别当前文字”。')
      commandRef.current?.focus({ preventScroll: true }); return
    }
    const request = ++pasteRequestRef.current
    pasteLock.current = true; setPasting(true)
    try {
      const text = await navigator.clipboard.readText()
      if (request !== pasteRequestRef.current) return
      if (!text.trim()) { setCommandError('剪贴板没有文字。请先复制客户姓名、日期和人数，再点“黏贴/自动填入”。'); return }
      setCommand(text); fillCommand(text)
    } catch {
      if (request !== pasteRequestRef.current) return
      setCommandError('未能读取剪贴板。请允许浏览器黏贴，或长按上方输入框黏贴，系统会自动识别。')
      commandRef.current?.focus({ preventScroll: true })
    } finally { if (request === pasteRequestRef.current) { pasteLock.current = false; setPasting(false) } }
  }
  const clearEntry = () => {
    cancelPaste(); setEditing(undefined); setInput({ guestName: '', date: getBangkokDate(), people: 1 }); setNote(''); setCommission(''); setCommand(''); setCommandError(''); setCommandMessage(''); setWarning(null); setError(''); setMessage('')
    operationRef.current = null; setPendingSave(null)
  }
  const runSave = async (operation: SaveOperation) => {
    if (saveLock.current || pasteLock.current) return
    saveLock.current = true; setSaving(true); setError(''); setMessage(''); setWarning(null); invalidatePreview()
    const baseline = latest.current.tickets
    let generateSaved: TicketRecord | undefined
    try {
      const saved = await onSave(operation.draft, operation.existing, operation.operationId)
      if (!mountedRef.current) return
      confirmedRef.current = { ticket: saved, baseline }
      setSavedOrder(saved); setMonth(saved.issueDate.slice(0, 7)); setDate(saved.issueDate); setDayOnly(false)
      clearEntry()
      setMessage('订单已保存到79秀独立账本，未计入主账本报表。')
      if (operation.generate) generateSaved = saved
    } catch (e) {
      if (mountedRef.current) { setPendingSave(operation); setError((e instanceof Error ? e.message : '订单保存结果尚未确认。') + ' 请重试本次保存；沿用同一编号，不会重复新增。') }
    } finally { saveLock.current = false; if (mountedRef.current) setSaving(false) }
    if (generateSaved && mountedRef.current) await previewSaved(generateSaved)
  }
  const save = async (generate = false, acknowledgedKey?: string) => {
    if (saveLock.current || pasteLock.current || generating) return
    if (pendingSave) { await runSave(pendingSave); return }
    setError(''); setMessage('')
    try {
      validateShow79Voucher(input)
      if (!project) throw new Error('请先选择79秀的供货商套餐。')
      const values = project.entryMode === 'profit_only' ? [commission] : [price, cost]
      if (values.some(value => !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error('请填写本次实际金额，不能留空或填负数。')
      const prior = acknowledgedKey && warning?.key === acknowledgedKey ? warning : undefined
      const draft: TicketInput = prior?.draft ?? { guestName: input.guestName, issueDate: input.date, issueTime: editing ? editing.issueTime ?? null : getBangkokTime(), personCount: input.people, quantityUnit: 'person', amountBasis: basis, entryMode: project.entryMode ?? 'standard', manualProfitThb: project.entryMode === 'profit_only' ? Number(commission) : null, supplierName: project.supplierName, projectId: project.id, projectName: project.name, subItemName: project.subItemName, agentPriceThb: project.entryMode === 'profit_only' ? 0 : Number(price), costThb: project.entryMode === 'profit_only' ? 0 : Number(cost), note }
      validateDraftAmounts(draft)
      const check = ticketWarnings(draft, project, tickets, editing?.id)
      if (check.messages.length && check.key !== acknowledgedKey) { setWarning({ ...check, draft, generate }); return }
      if (!editing) draft.issueTime = getBangkokTime()
      const operation = operationRef.current ?? { draft, existing: editing, operationId: editing ? undefined : createId(), generate: prior?.generate ?? generate }
      operationRef.current = operation
      await runSave(operation)
    } catch (e) { setError(e instanceof Error ? e.message : '订单未保存。') }
  }
  const edit = (ticket: TicketRecord) => {
    cancelPaste(); invalidatePreview(); operationRef.current = null; setPendingSave(null); setSavedOrder(undefined)
    setEditing(ticket); setInput({ guestName: ticket.guestName ?? '', date: ticket.issueDate, people: ticket.personCount ?? 1 })
    setProjectId(ticket.projectId ?? ''); setBasis(ticket.amountBasis ?? 'total'); setPrice(String(ticket.agentPriceThb)); setCost(String(ticket.costThb)); setCommission(ticket.manualProfitThb == null ? '' : String(ticket.manualProfitThb)); setNote(ticket.note); setError(''); setMessage('')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const currentPreview = () => {
    if (preview && sourceIsCurrent(preview.source)) return preview
    invalidatePreview(); setError('订单信息已更新，旧确认单已失效，请重新生成。'); return undefined
  }
  const copyImage = async () => {
    const value = currentPreview(); if (!value) return
    setError(''); setMessage('')
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { setError('当前浏览器不支持复制图片。可长按预览图片选择“复制”，或用手机 Safari / Chrome 打开系统再试。'); return }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': value.blob })])
      if (sourceIsCurrent(value.source)) setMessage('图片已复制。切换到微信，长按聊天输入框尝试粘贴，无需保存到相册。')
      else setError('复制期间订单已更新，请重新生成并复制最新确认单。')
    } catch { setError('图片未能复制。请允许浏览器访问剪贴板后重试，或长按预览图片选择“复制”。') }
  }
  const share = async () => {
    const value = currentPreview(); if (!value) return
    try {
      const file = new File([value.blob], voucherFilename(value.input), { type: 'image/png' })
      if (!navigator.canShare?.({ files: [file] }) || !navigator.share) { setMessage('此浏览器不支持直接分享图片。可尝试“复制图片”，再切换到微信粘贴。'); return }
      await navigator.share({ files: [file], title: '79秀确认单' })
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError('分享未完成，可尝试“复制图片”后到微信粘贴。') }
  }

  return <section className="show79-view">
    <div className="records-heading"><div><p className="eyebrow">独立账本 · THB · 曼谷时间</p><h1>79秀</h1></div><button type="button" className="secondary-button small" onClick={onManageProjects}>供货商 / 套餐</button></div>
    <p className="sheet-copy">79秀的订单、人数和利润独立统计，不计入主账本日报、月报、年报及排行。</p>
    <div className="show79-filters"><label>查询日期<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label>报表月份<input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label></div>
    {result.error && <p role="alert" className="form-error">{result.error}</p>}
    {report && <>
      <div className="show79-metrics"><div><span>当日人数 · {date.replaceAll('-', '/')}</span><strong>{report.dayPeople} 人</strong>{report.dayUnknown > 0 && <small>另有{report.dayUnknown}笔人数未填</small>}</div><div><span>月人数 · {month.replace('-', '/')}</span><strong>{report.monthPeople} 人</strong>{report.monthUnknown > 0 && <small>另有{report.monthUnknown}笔人数未填</small>}</div><div><span>月实际利润</span><strong>{formatThb(report.profitThb)}</strong></div><div><span>月订单数（含退票记录）</span><strong>{report.records.length} 单</strong></div></div>
      <section className="show79-split"><h2>月度分账</h2><p>{month} · 按实际利润分成</p><div><span>jimmy · 40%</span><strong>{formatThb(report.jimmyThb)}</strong></div><div><span>大狗二狗合计 · 60%</span><strong>{formatThb(report.partnersThb)}</strong></div><small>按当月净利润统一计算，保留两位小数；退票回算原记录月份。此处为分账计算，不会自动转账。</small><button type="button" className="secondary-button" onClick={() => void exportShow79ToXlsx(tickets, date, month, settlements).catch(() => setError('导出失败，请重试。'))}>导出当月订单及分账 Excel</button></section>
      {onSaveSettlement && <Show79SettlementPanel key={month} tickets={tickets} records={settlements} month={month} onSave={onSaveSettlement} />}
    </>}
    <section className="show79-entry"><h2>{editing ? '编辑79秀订单' : '生成确认单 / 新增订单'}</h2><p className="sheet-copy" role="status">{editing ? '正在编辑已记账订单；修改保存前，手填预览不代表修改已记账。' : '当前填写内容未记账；预览图片不会保存订单。'}</p>
      {!editing && <div className="show79-command">
        <label>一句话填写<textarea ref={commandRef} disabled={busy || Boolean(pendingSave)} value={command} aria-invalid={Boolean(commandError)} aria-describedby={commandError ? 'show79-command-help show79-command-error' : 'show79-command-help'} onChange={event => { cancelPaste(); setCommand(event.target.value); setCommandError(''); setCommandMessage('') }} onPaste={event => { if (busy || pendingSave) return; const text = event.clipboardData.getData('text/plain'); if (!text.trim()) return; event.preventDefault(); setCommand(text); fillCommand(text) }} placeholder="李湘光 龙粉萍 今天 2个79" /></label>
        <p className="sheet-copy" id="show79-command-help">先复制订单文字，再点“黏贴/自动填入”；也可长按输入框黏贴。例如：李湘光 龙粉萍 今天 2个79。</p>
        <button type="button" className="secondary-button" disabled={busy || pasting || Boolean(pendingSave)} aria-busy={pasting} onClick={() => void pasteAndFill()}>{pasting ? '正在黏贴…' : '黏贴/自动填入'}</button>
        {command.trim() && <button type="button" className="text-action" disabled={busy || pasting || Boolean(pendingSave)} onClick={() => fillCommand(command)}>识别当前文字</button>}
        {commandError && <p className="form-error" id="show79-command-error" role="alert">{commandError}</p>}
        {commandMessage && <p className="sheet-copy" role="status">{commandMessage}</p>}
      </div>}
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save() }} ref={formRef} className="ticket-form"><fieldset className="form-fields" disabled={busy || Boolean(pendingSave)}>
        <label>客户姓名<input value={input.guestName} maxLength={100} disabled={busy} onChange={event => update('guestName', event.target.value)} required /></label>
        <div className="form-grid"><label>观看日期<input type="date" disabled={busy} value={input.date} onChange={event => update('date', event.target.value)} required /></label><label>人数<input type="number" disabled={busy} min="1" step="1" value={Number.isFinite(input.people) ? input.people : ''} onChange={event => update('people', event.target.value === '' ? Number.NaN : Number(event.target.value))} required /></label></div>
        <p className="sheet-copy">时间：18:30–21:30【循环表演】 · 预订单号留空</p>
        <button type="button" className="secondary-button" disabled={busy || pasting} onClick={() => void showPreview(input)}>{busy ? '处理中…' : '预览确认单图片'}</button>
        <details open={Boolean(editing)}><summary>保存到独立账本 · 填写实际金额</summary>
          <label>供货商套餐<select value={projectId} onChange={event => selectProject(event.target.value)}><option value="">请选择79秀套餐</option>{showProjects.map(project => <option key={project.id} value={project.id}>{project.supplierName} · {project.name} · {project.subItemName || '不分套餐'}</option>)}</select></label>
          {!showProjects.length && <button type="button" className="text-action" onClick={onManageProjects}>先录入79秀项目及供货商价格</button>}
          <label>金额单位<select value={basis} onChange={event => changeFinancial(() => setBasis(event.target.value as AmountBasis))}><option value="per_person">每人金额 × 人数</option><option value="total">整单总额</option></select></label>
          {project?.entryMode === 'profit_only' ? <label>{basis === 'per_person' ? '每人实际利润' : '整单实际利润'}（THB）<input type="number" min="0" step="0.01" value={commission} onChange={event => changeFinancial(() => setCommission(event.target.value))} /></label> : <div className="form-grid"><label>{basis === 'per_person' ? '每人售价' : '整单售价'}（THB）<input type="number" min="0" step="0.01" value={price} onChange={event => changeFinancial(() => setPrice(event.target.value))} /></label><label>{basis === 'per_person' ? '每人成本' : '整单成本'}（THB）<input type="number" min="0" step="0.01" value={cost} onChange={event => changeFinancial(() => setCost(event.target.value))} /></label></div>}
          <label>内部备注<textarea value={note} maxLength={300} onChange={event => changeFinancial(() => setNote(event.target.value))} /></label>
          <p className="sheet-copy">按观看日期归入日/月统计；只生成确认单不会新增账本记录，也不会向供应商下单。</p>
          {!warning && <><button type="submit" className="secondary-button" disabled={busy || pasting}>{saving ? '保存中…' : editing ? '保存订单修改' : '保存79秀订单'}</button><button type="button" className="primary-button" disabled={busy || pasting} onClick={() => void save(true)}>{saving ? '保存中…' : '保存并生成确认单'}</button></>}
        </details></fieldset>
        {warning && <SaveWarning messages={warning.messages} saving={busy || pasting} onBack={() => setWarning(null)} onContinue={() => void save(warning.generate, warning.key)} />}
        {pendingSave && <div className="show79-save-retry"><p className="sheet-copy">上次保存结果尚待核对。重试将使用原内容与原编号；开始新订单前，请先在下方核对是否已记账。</p><button type="button" className="primary-button" disabled={busy || pasting} onClick={() => void runSave(pendingSave)}>重试本次保存</button><button type="button" className="text-action" disabled={busy} onClick={() => { invalidatePreview(); clearEntry(); setMessage('已开始新订单；此操作不会撤回上次已提交的记录。') }}>核对后开始新订单</button></div>}
        {editing && !pendingSave && <button type="button" className="text-action" disabled={busy} onClick={() => { invalidatePreview(); clearEntry(); setSavedOrder(undefined) }}>取消编辑</button>}
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="sheet-copy" role="status">{message}</p>}
      {savedOrder && <div className="show79-saved-order"><p className="sheet-copy" role="status">已记账：{savedOrder.guestName} · {voucherDate(savedOrder.issueDate)}。重新生成只读取订单，不会再次保存。</p><button type="button" className="secondary-button" disabled={busy || pasting || Boolean(pendingSave)} onClick={() => void previewSaved(savedOrder)}>重新生成已保存订单确认单</button></div>}
      {visiblePreview && <div className="show79-voucher"><p role="status">{visiblePreview.source.kind === 'saved' ? '已记账订单确认单' : '未记账确认单预览'} · {visiblePreview.input.guestName} · {visiblePreview.input.people}人 · {voucherDate(visiblePreview.input.date)}</p><img src={visiblePreview.url} alt={`${visiblePreview.input.guestName}的79秀确认单，${voucherDate(visiblePreview.input.date)}，${visiblePreview.input.people}人`} /><div className="show79-share"><button type="button" className="primary-button" onClick={() => void copyImage()}>复制图片（无需保存）</button><button type="button" className="secondary-button" onClick={() => void share()}>分享图片（可选择微信）</button><button type="button" className="secondary-button" onClick={() => { const current = currentPreview(); if (current) downloadVoucher(current.url, voucherFilename(current.input)) }}>下载图片</button><button type="button" className="secondary-button" onClick={() => { try { const current = currentPreview(); if (current) printVoucher(current.url) } catch (e) { setError(e instanceof Error ? e.message : "打印失败。") } }}>打印 / 保存 PDF</button></div><p className="sheet-copy">复制图片后可切换微信，长按聊天输入框尝试粘贴，无需保存到相册。能否粘贴成图片取决于手机和微信的支持。</p></div>}
    </section>
    <section className="show79-orders"><h2>79秀订单</h2><div className="show79-filters"><label>订单范围<select value={dayOnly ? 'day' : 'month'} onChange={event => setDayOnly(event.target.value === 'day')}><option value="month">所选月份</option><option value="day">所选日期</option></select></label><label>搜索客户 / 备注<input value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      {!records.length && <p className="empty-card">当前范围没有79秀订单。</p>}
      <div className="records-list">{records.map(ticket => {
        const refund = getRefundState(ticket)
        return <article className="ticket-card" key={ticket.id}><div className="ticket-card-main"><div><p>{ticket.issueDate.replaceAll('-', '/')} · {ticket.supplierName}</p><strong>{ticket.guestName || '旧记录 · 姓名未填'}</strong></div><strong className={getTicketAmounts(ticket).profitThb < 0 ? 'loss-value' : 'profit-value'}>{formatThb(getTicketAmounts(ticket).profitThb)}</strong></div><div className="ticket-meta"><span>{ticket.entryMode === 'profit_only' ? '仅录利润，不计人数' : `有效人数：${refund.remainingPeople ?? '未填'}`}</span><span>{refund.full ? '已全部退票' : refund.active.length ? '部分退票' : '未退票'}</span>{ticket.syncStatus !== 'synced' && <span>等待同步</span>}</div>{ticket.note && <p className="ticket-note">{ticket.note}</p>}<RefundHistory ticket={ticket} onCancel={id => { invalidatePreview(); onCancelRefund(id) }} /><div className="ticket-actions"><button type="button" disabled={busy || pasting || !ticket.guestName || !refund.remainingPeople || ticket.entryMode === 'profit_only'} onClick={() => void previewSaved(ticket).then(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))}>确认单</button>{ticket.entryMode !== 'profit_only' && !refund.full && <button type="button" onClick={() => { invalidatePreview(); onRefund(ticket.id) }}>退票</button>}<button type="button" disabled={busy || Boolean(pendingSave) || Boolean(ticket.refunds?.length)} onClick={() => edit(ticket)}>编辑</button><button type="button" disabled={busy || Boolean(pendingSave) || Boolean(ticket.refunds?.length)} className="danger-action" onClick={() => { invalidatePreview(); void onDelete(ticket) }}>删除</button></div></article>
      })}</div>
    </section>
  </section>
}
