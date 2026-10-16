import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { TicketRecord } from '../types'
import { createId, formatThb, getBangkokDate } from '../lib/format'
import { buildShow79SettlementState, show79SettlementStatusLabels, validateShow79SettlementInput, type Show79SettlementInput, type Show79SettlementRecord, type Show79SettlementState } from '../lib/show79-settlement'
import './Show79SettlementPanel.css'

export interface Show79SettlementPanelProps {
  tickets: TicketRecord[]
  records: Show79SettlementRecord[]
  month: string
  onSave: (input: Show79SettlementInput) => Promise<void>
  disabled?: boolean
}

export function Show79SettlementPanel({ tickets, records, month, onSave, disabled = false }: Show79SettlementPanelProps) {
  const result = useMemo(() => {
    try { return { state: buildShow79SettlementState(tickets, records, month), error: '' } }
    catch (reason) { return { state: null, error: reason instanceof Error ? reason.message : '本月结算暂时无法计算。' } }
  }, [tickets, records, month])
  if (!result.state) return <details className="show79-settlement"><summary>本月结算：无法计算</summary><p className="form-error" role="alert">{result.error}</p></details>
  // Changing months starts a fresh draft, including retry identity and feedback.
  return <SettlementMonth key={month} state={result.state} onSave={onSave} disabled={disabled} />
}

function SettlementMonth({ state, onSave, disabled }: { state: Show79SettlementState; onSave: (input: Show79SettlementInput) => Promise<void>; disabled: boolean }) {
  const [date, setDate] = useState(getBangkokDate)
  const [jimmy, setJimmy] = useState(() => state.remainingJimmyThb.toFixed(2))
  const [partners, setPartners] = useState(() => state.remainingPartnersThb.toFixed(2))
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const savingRef = useRef(false)
  const touchedRef = useRef(false)
  const mountedRef = useRef(true)
  // Keep both the identity and exact expected snapshot when a result is unknown.
  const operationRef = useRef<{ fingerprint: string; input: Show79SettlementInput } | null>(null)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  useEffect(() => {
    if (!touchedRef.current && !savingRef.current) {
      setJimmy(state.remainingJimmyThb.toFixed(2)); setPartners(state.remainingPartnersThb.toFixed(2))
    }
  }, [state.remainingJimmyThb, state.remainingPartnersThb])

  const edit = (update: () => void) => {
    if (savingRef.current || disabled) return
    touchedRef.current = true; setError(''); setMessage(''); update()
  }
  const fillDifference = () => edit(() => { setJimmy(state.remainingJimmyThb.toFixed(2)); setPartners(state.remainingPartnersThb.toFixed(2)) })
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (savingRef.current || disabled) return
    setError(''); setMessage('')
    try {
      if (!jimmy.trim() || !partners.trim()) throw new Error('请填写两方本次实际金额；未支付或收回的一方请填0。')
      const values = { month: state.month, paymentDate: date, jimmyPaidThb: Number(jimmy), partnersPaidThb: Number(partners), note: note.trim() }
      const fingerprint = JSON.stringify(values)
      if (!operationRef.current || operationRef.current.fingerprint !== fingerprint) {
        operationRef.current = { fingerprint, input: { operationId: createId(), ...values, expectedProfitThb: state.profitThb, expectedJimmyPaidThb: state.paidJimmyThb, expectedPartnersPaidThb: state.paidPartnersThb } }
      }
      const input = operationRef.current.input
      validateShow79SettlementInput(input)
      savingRef.current = true; setSaving(true)
      await onSave(input)
      if (!mountedRef.current) return
      operationRef.current = null; touchedRef.current = true
      setJimmy(''); setPartners(''); setNote(''); setDate(getBangkokDate())
      setMessage('本次分账已登记，请核对最新累计金额。这里只记账，不会转账。')
    } catch (reason) {
      // A stale-state rejection cannot have committed; a retry may use the
      // refreshed snapshot. Unknown network results keep their original ID.
      if ((reason as { code?: string })?.code === '40001') operationRef.current = null
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : '登记结果尚未确认，请同步核对后重试；未修改内容会沿用本次编号。')
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  const payees = [
    { name: 'jimmy · 40%', due: state.jimmyThb, paid: state.paidJimmyThb, remaining: state.remainingJimmyThb },
    { name: '大狗二狗合计 · 60%', due: state.partnersThb, paid: state.paidPartnersThb, remaining: state.remainingPartnersThb }
  ]
  return <details className="show79-settlement">
    <summary>本月结算：{show79SettlementStatusLabels[state.status]}<small>{state.month.replace('-', '/')}</small></summary>
    <div className="show79-settlement-body">
      <p>当前月实际净利润：<strong>{formatThb(state.profitThb)}</strong></p>
      <div className="show79-settlement-payees">{payees.map(payee => <section className="show79-settlement-payee" key={payee.name}>
        <h3>{payee.name}</h3><dl>
          <div><dt>当前应分成</dt><dd>{formatThb(payee.due)}</dd></div>
          <div><dt>累计净已付</dt><dd>{formatThb(payee.paid)}</dd></div>
          <div className={`show79-settlement-difference${payee.remaining < 0 ? ' show79-settlement-recover' : ''}`}><dt>{payee.remaining < 0 ? '应收回' : '尚应付'}</dt><dd>{formatThb(Math.abs(payee.remaining))}</dd></div>
        </dl>
      </section>)}</div>
      {state.status === 'adjustment' && <p className="show79-settlement-description">当月利润已与历史快照不同，请按当前差额补付或收回；历史分账记录保留。</p>}
      <p className="show79-settlement-description">累计净已付＝历次付出减收回。当前差额为负时表示应收回；亏损仍按40%／60%计算。</p>
      <form className="show79-settlement-form" onSubmit={event => void submit(event)}>
        <fieldset disabled={disabled || saving}>
          <legend>登记已实际发生的分账</legend>
          <p className="show79-settlement-description">以下是本次增量金额，不会覆盖历史。正数表示已付出，负数表示已收回或冲正；这里只登记，不会自动转账。</p>
          <label>实际付款日期（曼谷）<input type="date" value={date} max={getBangkokDate()} onChange={event => edit(() => setDate(event.target.value))} required /></label>
          <div className="show79-settlement-amounts">
            <label>jimmy 本次实际金额（THB）<input inputMode="decimal" type="number" step="0.01" value={jimmy} onChange={event => edit(() => setJimmy(event.target.value))} required /></label>
            <label>大狗二狗本次实际金额（THB）<input inputMode="decimal" type="number" step="0.01" value={partners} onChange={event => edit(() => setPartners(event.target.value))} required /></label>
          </div>
          <button className="text-action" type="button" onClick={fillDifference}>填入当前差额</button>
          <label>本次分账备注（收回／冲正必填）<textarea value={note} maxLength={300} onChange={event => edit(() => setNote(event.target.value))} placeholder="例如：10月分账；退票后收回多付金额" /></label>
          <button className="primary-button" type="submit" aria-busy={saving}>{saving ? '正在登记…' : '登记本次分账'}</button>
        </fieldset>
        {disabled && <p className="show79-settlement-description">当前暂不能登记，请先登录并完成同步后重试。</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {message && <p className="show79-settlement-success" role="status">{message}</p>}
      </form>
      <section className="show79-settlement-history" aria-label="分账历史">
        <h3>分账历史 · {state.records.length} 笔</h3>
        {!state.records.length ? <p className="show79-settlement-description">尚未登记分账；展示的应分成不会自动记为已支付。</p> : <ol>{state.records.map(record => <li key={record.id}>
          <strong>{record.paymentDate.replaceAll('-', '/')} · 实际付款日期</strong>
          <p>本次实际金额：jimmy {formatThb(record.jimmyPaidThb)} · 大狗二狗 {formatThb(record.partnersPaidThb)}</p>
          <p>登记时快照：净利润 {formatThb(record.snapshotProfitThb)} · jimmy {formatThb(record.snapshotJimmyThb)} · 大狗二狗 {formatThb(record.snapshotPartnersThb)}</p>
          {record.note && <p>备注：{record.note}</p>}
          <small>{record.syncStatus === 'synced' ? '已确认' : '等待同步确认'}</small>
        </li>)}</ol>}
      </section>
    </div>
  </details>
}
