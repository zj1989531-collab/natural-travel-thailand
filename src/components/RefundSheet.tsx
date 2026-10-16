import { useRef, useState, type FormEvent } from 'react'
import type { RefundInput, TicketRecord } from '../types'
import { createId, formatThb, getBangkokDate, getBangkokTime } from '../lib/format'
import { getRefundState } from '../lib/refunds'
import { defaultRefundAmounts, validateRefundInput } from '../lib/refund-input'
import { getTicketAmounts } from '../lib/ticket-amounts'
import { quantityLabels } from '../lib/quantity'

const customerName = (ticket: TicketRecord) => ticket.guestName?.trim() || '姓名未填写'

export const matchesRefundTicketSearch = (ticket: TicketRecord, search: string) => {
  const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase()
  return normalize([ticket.guestName ?? '', ticket.issueDate, ticket.projectName, ticket.subItemName, ticket.supplierName, ticket.note].join(' ')).includes(normalize(search))
}

export const refundConfirmationText = (ticket: TicketRecord, input: RefundInput, afterProfit: number) =>
  `确认登记此退票吗？\n客户：${customerName(ticket)}\n原票：${ticket.issueDate} · ${ticket.projectName}${ticket.subItemName ? ` / ${ticket.subItemName}` : ''}\n实际退款：${input.refundDate} ${input.refundTime}（曼谷）\n退给代理：${formatThb(input.refundRevenueThb)}\n供货商返还：${formatThb(input.returnedCostThb)}\n退票后利润：${formatThb(afterProfit)}\n将回算原票日期和原月份；此操作只记账，不会转账。`

export function RefundHistory({ ticket, onCancel }: { ticket: TicketRecord; onCancel?: (id: string) => void }) {
  const history = getRefundState(ticket).history
  const { label, unit } = quantityLabels(ticket)
  if (!history.length) return null
  return <details className="refund-history"><summary>退票明细 · {history.length} 笔（含撤销）</summary>{history.map((refund) => <div className="refund-history-row" key={refund.id}>
    <p>{refund.refundDate} {refund.refundTime}（曼谷） · {refund.personCount == null ? `整单（原${label}未知）` : `${refund.personCount} ${unit}`} · {refund.cancelledAt ? '已撤销' : '有效'}</p>
    <p>退给代理 {formatThb(refund.refundRevenueThb)} · 供货商返还 {formatThb(refund.returnedCostThb)}</p>
    {refund.note && <p>{refund.note}</p>}
    {!refund.cancelledAt && onCancel && <button className="text-action" type="button" onClick={() => onCancel(refund.id)} aria-label={`撤销退票 ${refund.refundDate} ${refund.id.slice(0, 6)}`}>撤销此退票</button>}
  </div>)}</details>
}

export function RefundSheet({ tickets, initialTicketId = '', onClose, onSave }: { tickets: TicketRecord[]; initialTicketId?: string; onClose: () => void; onSave: (input: RefundInput) => Promise<void> }) {
  const initial = tickets.find((ticket) => ticket.id === initialTicketId)
  const [operationId] = useState(createId)
  const [selectedId, setSelectedId] = useState(initialTicketId)
  const [search, setSearch] = useState('')
  const [isFull, setIsFull] = useState(true)
  const [people, setPeople] = useState(1)
  const [amounts, setAmounts] = useState(() => initial ? defaultRefundAmounts(initial, true, 1) : { refundRevenueThb: NaN, returnedCostThb: NaN })
  const [date, setDate] = useState(getBangkokDate)
  const [time, setTime] = useState(getBangkokTime)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const ticket = tickets.find((row) => row.id === selectedId)
  const { label, unit } = quantityLabels(ticket ?? {})
  const state = ticket ? getRefundState(ticket) : undefined
  const refundable = tickets.filter((row) => !row.deletedAt && row.entryMode !== 'profit_only' && !getRefundState(row).full)
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt))
    .filter((row) => row.id === selectedId || matchesRefundTicketSearch(row, search))
  const currentProfit = ticket ? getTicketAmounts(ticket).profitThb : 0
  const afterProfit = (Math.round(currentProfit * 100) - Math.round((Number.isFinite(amounts.refundRevenueThb) ? amounts.refundRevenueThb : 0) * 100) + Math.round((Number.isFinite(amounts.returnedCostThb) ? amounts.returnedCostThb : 0) * 100)) / 100
  const changeTicket = (id: string) => {
    setSelectedId(id); setIsFull(true); setPeople(1); setError('')
    const selected = tickets.find((row) => row.id === id)
    setAmounts(selected ? defaultRefundAmounts(selected, true, 1) : { refundRevenueThb: NaN, returnedCostThb: NaN })
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (savingRef.current) return
    if (!ticket) { setError('请先选择原出票记录。'); return }
    const input: RefundInput = { operationId, ticketId: ticket.id, personCount: isFull ? state?.remainingPeople ?? null : people, isFull, ...amounts, refundDate: date, refundTime: time, note }
    try {
      validateRefundInput(ticket, input)
      if (!window.confirm(refundConfirmationText(ticket, input, afterProfit))) return
      savingRef.current = true; setSaving(true); setError('')
      await onSave(input)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '退票未确认，请刷新核对后重试。') }
    finally { savingRef.current = false; setSaving(false) }
  }
  return <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="refund-sheet-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="sheet-handle" /><div className="sheet-title-row"><div><p className="eyebrow">保留原票 · 回算原日 / 原月</p><h2 id="refund-sheet-title">办理退票</h2></div><button className="icon-button" type="button" aria-label="关闭退票" onClick={onClose}>×</button></div>
    <p className="sheet-copy">这里只登记退票，不会实际转账。退票需联网确认；原出票记录不会删除，仅录利润的返佣项目不能按门票退票。</p>
    <form className="ticket-form" onSubmit={submit}>
      <label>查找原票<input type="search" placeholder="搜索客户、日期、项目、供货商或备注" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>原出票记录<select value={selectedId} onChange={(event) => changeTicket(event.target.value)} required><option value="">请选择需要退票的记录</option>{refundable.map((row) => <option key={row.id} value={row.id}>{customerName(row)} · {row.issueDate} {row.issueTime ?? ''} · {row.projectName}{row.subItemName ? ` / ${row.subItemName}` : ''} · {row.supplierName} · 剩余{getRefundState(row).remainingPeople ?? '未知'}{quantityLabels(row).unit} · #{row.id.slice(0, 6)}</option>)}</select></label>
      {!refundable.length && <p className="sheet-copy">没有符合条件的可退票记录。已全部退票和仅录利润的记录不会列在此处。</p>}
      {ticket && <>
        <p className="sheet-copy">客户：<strong>{customerName(ticket)}</strong><br />原票归属日期：{ticket.issueDate} · 原{label}：{ticket.personCount ?? '未记录'} · 已退：{state?.refundedPeople ?? 0} · 剩余：{state?.remainingPeople ?? '未知'}{unit}<br />将重算 {ticket.issueDate} 的当日统计和 {ticket.issueDate.slice(0, 7)} 的月报。</p>
        <label>退票范围<select value={isFull ? 'full' : 'partial'} onChange={(event) => { const full = event.target.value === 'full'; setIsFull(full); setAmounts(defaultRefundAmounts(ticket, full, people)) }}><option value="full">全部剩余{label} / 整单</option><option value="partial" disabled={state?.remainingPeople == null}>部分退票</option></select></label>
        {!isFull && <label>本次退票{label}<input inputMode="numeric" type="number" min="1" max={state?.remainingPeople ?? undefined} step="1" value={Number.isFinite(people) ? people : ''} onChange={(event) => { const value = event.target.value === '' ? NaN : Number(event.target.value); setPeople(value); setAmounts(defaultRefundAmounts(ticket, false, Number.isFinite(value) ? value : 0)) }} required /></label>}
        {ticket.personCount == null && <p className="sheet-copy">旧票{label}未知，只能整单退票，不会擅自补{label}。</p>}
        <div className="form-grid"><label>退票日期（实际退款）<input type="date" max={getBangkokDate()} value={date} onChange={(event) => setDate(event.target.value)} required /></label><label>退票时间（曼谷）<input type="time" step="60" value={time} onChange={(event) => setTime(event.target.value)} required /></label></div>
        <p className="sheet-copy">退票日期填写实际退款当天，可早于观看／出行日期，不能晚于曼谷今天；利润仍回算原票日期和所属月份。</p>
        <p className="sheet-copy">以下为本次实际总额，已预填参考值，可手动修改。有手续费或供货商不返还时，请按实际金额填写。</p>
        <label>本次退给代理（THB，总额）<input inputMode="decimal" type="number" min="0" step="0.01" value={Number.isFinite(amounts.refundRevenueThb) ? amounts.refundRevenueThb : ''} onChange={(event) => setAmounts((current) => ({ ...current, refundRevenueThb: event.target.value === '' ? NaN : Number(event.target.value) }))} required /></label>
        <label>本次供货商返还（THB，总额）<input inputMode="decimal" type="number" min="0" step="0.01" value={Number.isFinite(amounts.returnedCostThb) ? amounts.returnedCostThb : ''} onChange={(event) => setAmounts((current) => ({ ...current, returnedCostThb: event.target.value === '' ? NaN : Number(event.target.value) }))} required /></label>
        <div className={`profit-preview ${afterProfit < 0 ? 'negative' : ''}`}><span>退票后原票利润</span><strong>{formatThb(afterProfit)}</strong></div>
        <label>退票备注（可选）<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：客人取消、手续费、供货商不返还" /></label>
        <RefundHistory ticket={ticket} />
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving || !ticket || state?.full}>{saving ? '正在确认…' : '确认登记退票'}</button></div>
    </form>
  </section></div>
}
