import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { AmountBasis, Project, TicketInput, TicketRecord } from '../types'
import { buildShow79Report, isShow79Project, parseShow79Command, validateShow79Voucher, voucherDate, type Show79VoucherInput } from '../lib/show79'
import { formatThb, getBangkokDate, getBangkokMonth, getBangkokTime } from '../lib/format'
import { createShow79Voucher, downloadVoucher, printVoucher, voucherFilename } from '../lib/show79-voucher'
import { getTicketAmounts } from '../lib/ticket-amounts'
import { getRefundState } from '../lib/refunds'
import { exportShow79ToXlsx } from '../lib/export'
import { RefundHistory } from './RefundSheet'
import { SaveWarning } from './SaveWarning'
import { ticketWarnings, validateDraftAmounts } from '../lib/entry-warnings'
import { resolveProjectRules } from '../lib/project-rules'

interface Props {
  tickets: TicketRecord[]
  projects: Project[]
  onSave: (input: TicketInput, existing?: TicketRecord) => Promise<void>
  onDelete: (ticket: TicketRecord) => Promise<void>
  onRefund: (id: string) => void
  onCancelRefund: (id: string) => void
  onManageProjects: () => void
}

export function Show79View({ tickets, projects, onSave, onDelete, onRefund, onCancelRefund, onManageProjects }: Props) {
  const [date, setDate] = useState(getBangkokDate)
  const [month, setMonth] = useState(getBangkokMonth)
  const [dayOnly, setDayOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [command, setCommand] = useState('')
  const [input, setInput] = useState<Show79VoucherInput>(() => ({ guestName: '', date: getBangkokDate(), people: 1 }))
  const showProjects = useMemo(() => projects.filter(project => isShow79Project(project.name) && project.quantityUnit !== 'item'), [projects])
  const [projectId, setProjectId] = useState('')
  const [basis, setBasis] = useState<AmountBasis>('per_person')
  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')
  const [commission, setCommission] = useState('')
  const [note, setNote] = useState('')
  const [recordTime, setRecordTime] = useState(getBangkokTime)
  const [editing, setEditing] = useState<TicketRecord>()
  const [busy, setBusy] = useState(false)
  const saveLock = useRef(false)
  const [warning, setWarning] = useState<{ messages: string[]; key: string } | null>(null)
  useEffect(() => { setWarning(null) }, [input, projectId, basis, price, cost, commission, note])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<{ url: string; blob: Blob; input: Show79VoucherInput }>()
  const urlRef = useRef<string | undefined>(undefined)
  const generationRef = useRef(0)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => () => { generationRef.current++; if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])
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

  const closePreview = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = undefined; setPreview(undefined)
  }
  const update = <K extends keyof Show79VoucherInput>(key: K, value: Show79VoucherInput[K]) => { generationRef.current++; closePreview(); setInput(current => ({ ...current, [key]: value })) }
  const selectProject = (id: string) => {
    setProjectId(id)
    const selected = showProjects.find(project => project.id === id)
    setPrice(selected && !selected.manualAgentPrice ? String(selected.defaultAgentPriceThb) : '')
    setCost(selected ? String(selected.defaultCostThb) : '')
    if (selected) setBasis(resolveProjectRules(selected).defaultAmountBasis)
  }
  const showPreview = async (value: Show79VoucherInput) => {
    const generation = ++generationRef.current
    setError(''); setBusy(true)
    try {
      const blob = await createShow79Voucher(value)
      if (generation !== generationRef.current) return
      closePreview(); const url = URL.createObjectURL(blob); urlRef.current = url
      setPreview({ url, blob, input: { ...value } })
    } catch (e) { if (generation === generationRef.current) setError(e instanceof Error ? e.message : '图片生成失败。') }
    finally { if (generation === generationRef.current) setBusy(false) }
  }
  const fillCommand = () => {
    try { const parsed = parseShow79Command(command); closePreview(); setInput(parsed); setError(''); setMessage('信息已填入，请核对后生成图片或保存订单。') }
    catch (e) { setError(e instanceof Error ? e.message : '未能识别订单。') }
  }
  const save = async (acknowledgedKey?: string) => {
    if (saveLock.current) return
    setError(''); setMessage('')
    try {
      validateShow79Voucher(input)
      if (!project) throw new Error('请先选择79秀的供货商套餐。')
      const values = project.entryMode === 'profit_only' ? [commission] : [price, cost]
      if (values.some(value => !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error('请填写本次实际金额，不能留空或填负数。')
      const draft: TicketInput = { guestName: input.guestName, issueDate: input.date, issueTime: editing?.issueTime ?? recordTime, personCount: input.people, quantityUnit: 'person', amountBasis: basis, entryMode: project.entryMode ?? 'standard', manualProfitThb: project.entryMode === 'profit_only' ? Number(commission) : null, supplierName: project.supplierName, projectId: project.id, projectName: project.name, subItemName: project.subItemName, agentPriceThb: project.entryMode === 'profit_only' ? 0 : Number(price), costThb: project.entryMode === 'profit_only' ? 0 : Number(cost), note }
      validateDraftAmounts(draft)
      const check = ticketWarnings(draft, project, tickets, editing?.id)
      if (check.messages.length && check.key !== acknowledgedKey) { setWarning(check); return }
      saveLock.current = true; setBusy(true)
      await onSave(draft, editing)
      setMonth(input.date.slice(0, 7)); setDate(input.date); setDayOnly(false)
      setEditing(undefined); setRecordTime(getBangkokTime()); setInput({ guestName: '', date: getBangkokDate(), people: 1 }); closePreview()
      setMessage('订单已保存到79秀独立账本，未计入主账本报表。')
    } catch (e) { setError(e instanceof Error ? e.message : '订单未保存。') }
    finally { saveLock.current = false; setBusy(false) }
  }
  const edit = (ticket: TicketRecord) => {
    closePreview(); setEditing(ticket); setInput({ guestName: ticket.guestName ?? '', date: ticket.issueDate, people: ticket.personCount ?? 1 })
    setProjectId(ticket.projectId ?? ''); setBasis(ticket.amountBasis ?? 'total'); setPrice(String(ticket.agentPriceThb)); setCost(String(ticket.costThb)); setCommission(ticket.manualProfitThb == null ? '' : String(ticket.manualProfitThb)); setNote(ticket.note); setError(''); setMessage('')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const share = async () => {
    if (!preview) return
    try {
      const file = new File([preview.blob], voucherFilename(preview.input), { type: 'image/png' })
      if (!navigator.canShare?.({ files: [file] }) || !navigator.share) {
        setMessage('此浏览器不支持直接分享图片。请下载或长按图片保存，再从微信相册发送。'); return
      }
      await navigator.share({ files: [file], title: '79秀确认单' })
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError('分享未完成，请下载图片后从微信发送。') }
  }

  return <section className="show79-view">
    <div className="records-heading"><div><p className="eyebrow">独立账本 · THB · 曼谷时间</p><h1>79秀</h1></div><button type="button" className="secondary-button small" onClick={onManageProjects}>供货商 / 套餐</button></div>
    <p className="sheet-copy">79秀的订单、人数和利润独立统计，不计入主账本日报、月报、年报及排行。</p>
    <div className="show79-filters"><label>查询日期<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label>报表月份<input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label></div>
    {result.error && <p role="alert" className="form-error">{result.error}</p>}
    {report && <>
      <div className="show79-metrics"><div><span>当日人数 · {date.replaceAll('-', '/')}</span><strong>{report.dayPeople} 人</strong>{report.dayUnknown > 0 && <small>另有{report.dayUnknown}笔人数未填</small>}</div><div><span>月人数 · {month.replace('-', '/')}</span><strong>{report.monthPeople} 人</strong>{report.monthUnknown > 0 && <small>另有{report.monthUnknown}笔人数未填</small>}</div><div><span>月实际利润</span><strong>{formatThb(report.profitThb)}</strong></div><div><span>月订单数（含退票记录）</span><strong>{report.records.length} 单</strong></div></div>
      <section className="show79-split"><h2>月度分账</h2><p>{month} · 按实际利润分成</p><div><span>jimmy · 40%</span><strong>{formatThb(report.jimmyThb)}</strong></div><div><span>大狗二狗合计 · 60%</span><strong>{formatThb(report.partnersThb)}</strong></div><small>按当月净利润统一计算，保留两位小数；退票回算原记录月份。此处为分账计算，不会自动转账。</small><button type="button" className="secondary-button" onClick={() => void exportShow79ToXlsx(tickets, date, month).catch(() => setError('导出失败，请重试。'))}>导出当月订单及分账 Excel</button></section>
    </>}
    <section className="show79-entry"><h2>{editing ? '编辑79秀订单' : '生成确认单 / 新增订单'}</h2>
      {!editing && <div className="show79-command"><label>一句话填写<textarea value={command} onChange={event => setCommand(event.target.value)} placeholder="79 jimmy 2人 今天" /></label><button type="button" className="secondary-button" disabled={busy} onClick={fillCommand}>自动填入</button></div>}
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save() }} ref={formRef} className="ticket-form">
        <label>客户姓名<input value={input.guestName} maxLength={100} disabled={busy} onChange={event => update('guestName', event.target.value)} required /></label>
        <div className="form-grid"><label>观看日期<input type="date" disabled={busy} value={input.date} onChange={event => update('date', event.target.value)} required /></label><label>人数<input type="number" disabled={busy} min="1" step="1" value={Number.isFinite(input.people) ? input.people : ''} onChange={event => update('people', event.target.value === '' ? Number.NaN : Number(event.target.value))} required /></label></div>
        <p className="sheet-copy">时间：18:30–21:30【循环表演】 · 预订单号留空</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void showPreview(input)}>{busy ? '处理中…' : '预览确认单图片'}</button>
        <details open={Boolean(editing)}><summary>保存到独立账本 · 填写实际金额</summary>
          <label>供货商套餐<select value={projectId} onChange={event => selectProject(event.target.value)}><option value="">请选择79秀套餐</option>{showProjects.map(project => <option key={project.id} value={project.id}>{project.supplierName} · {project.name} · {project.subItemName || '不分套餐'}</option>)}</select></label>
          {!showProjects.length && <button type="button" className="text-action" onClick={onManageProjects}>先录入79秀项目及供货商价格</button>}
          <label>金额单位<select value={basis} onChange={event => setBasis(event.target.value as AmountBasis)}><option value="per_person">每人金额 × 人数</option><option value="total">整单总额</option></select></label>
          {project?.entryMode === 'profit_only' ? <label>{basis === 'per_person' ? '每人实际利润' : '整单实际利润'}（THB）<input type="number" min="0" step="0.01" value={commission} onChange={event => setCommission(event.target.value)} /></label> : <div className="form-grid"><label>{basis === 'per_person' ? '每人售价' : '整单售价'}（THB）<input type="number" min="0" step="0.01" value={price} onChange={event => setPrice(event.target.value)} /></label><label>{basis === 'per_person' ? '每人成本' : '整单成本'}（THB）<input type="number" min="0" step="0.01" value={cost} onChange={event => setCost(event.target.value)} /></label></div>}
          <label>内部备注<textarea value={note} maxLength={300} onChange={event => setNote(event.target.value)} /></label>
          <p className="sheet-copy">按观看日期归入日/月统计；只生成确认单不会新增账本记录，也不会向供应商下单。</p>
          {!warning && <button type="submit" className="primary-button" disabled={busy}>{busy ? '处理中…' : editing ? '保存订单修改' : '保存79秀订单'}</button>}
        </details>
        {warning && <SaveWarning messages={warning.messages} saving={busy} onBack={() => setWarning(null)} onContinue={() => void save(warning.key)} />}
        {editing && <button type="button" className="text-action" onClick={() => { setEditing(undefined); setRecordTime(getBangkokTime()); setInput({ guestName: '', date: getBangkokDate(), people: 1 }); closePreview(); setNote('') }}>取消编辑</button>}
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="sheet-copy" role="status">{message}</p>}
      {preview && <div className="show79-voucher"><p>确认单预览 · {preview.input.guestName} · {preview.input.people}人 · {voucherDate(preview.input.date)}</p><img src={preview.url} alt={`${preview.input.guestName}的79秀确认单，${voucherDate(preview.input.date)}，${preview.input.people}人`} /><div className="show79-share"><button type="button" className="primary-button" onClick={() => void share()}>分享图片（可选择微信）</button><button type="button" className="secondary-button" onClick={() => downloadVoucher(preview.url, voucherFilename(preview.input))}>下载图片</button><button type="button" className="secondary-button" onClick={() => { try { printVoucher(preview.url) } catch (e) { setError(e instanceof Error ? e.message : "打印失败。") } }}>打印 / 保存 PDF</button></div><p className="sheet-copy">微信是否出现在分享菜单中取决于手机和浏览器，也可长按图片保存后发送。</p></div>}
    </section>
    <section className="show79-orders"><h2>79秀订单</h2><div className="show79-filters"><label>订单范围<select value={dayOnly ? 'day' : 'month'} onChange={event => setDayOnly(event.target.value === 'day')}><option value="month">所选月份</option><option value="day">所选日期</option></select></label><label>搜索客户 / 备注<input value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      {!records.length && <p className="empty-card">当前范围没有79秀订单。</p>}
      <div className="records-list">{records.map(ticket => {
        const refund = getRefundState(ticket)
        return <article className="ticket-card" key={ticket.id}><div className="ticket-card-main"><div><p>{ticket.issueDate.replaceAll('-', '/')} · {ticket.supplierName}</p><strong>{ticket.guestName || '旧记录 · 姓名未填'}</strong></div><strong className={getTicketAmounts(ticket).profitThb < 0 ? 'loss-value' : 'profit-value'}>{formatThb(getTicketAmounts(ticket).profitThb)}</strong></div><div className="ticket-meta"><span>{ticket.entryMode === 'profit_only' ? '仅录利润，不计人数' : `有效人数：${refund.remainingPeople ?? '未填'}`}</span><span>{refund.full ? '已全部退票' : refund.active.length ? '部分退票' : '未退票'}</span>{ticket.syncStatus !== 'synced' && <span>等待同步</span>}</div>{ticket.note && <p className="ticket-note">{ticket.note}</p>}<RefundHistory ticket={ticket} onCancel={onCancelRefund} /><div className="ticket-actions"><button type="button" disabled={busy || !ticket.guestName || !refund.remainingPeople || ticket.entryMode === 'profit_only'} onClick={() => void showPreview({ guestName: ticket.guestName ?? '', date: ticket.issueDate, people: refund.remainingPeople ?? 0 }).then(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))}>确认单</button>{ticket.entryMode !== 'profit_only' && !refund.full && <button type="button" onClick={() => onRefund(ticket.id)}>退票</button>}<button type="button" disabled={busy || Boolean(ticket.refunds?.length)} onClick={() => edit(ticket)}>编辑</button><button type="button" disabled={busy || Boolean(ticket.refunds?.length)} className="danger-action" onClick={() => void onDelete(ticket)}>删除</button></div></article>
      })}</div>
    </section>
  </section>
}
