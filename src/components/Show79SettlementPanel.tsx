import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { TicketRecord } from '../types'
import { createId, formatThb, getBangkokDate } from '../lib/format'
import { buildShow79SettlementState, show79SettlementStatusLabels, validateShow79SettlementInput, type Show79SettlementInput, type Show79SettlementRecord, type Show79SettlementState } from '../lib/show79-settlement'
import './Show79SettlementPanel.css'
import { useFinancialSubmission } from '../lib/use-financial-submission'

export interface Show79SettlementPanelProps {
  tickets: TicketRecord[]
  records: Show79SettlementRecord[]
  month: string
  onSave: (input: Show79SettlementInput) => Promise<void>
  financialReviewMessage?: string
  disabled?: boolean
  accountId?: string
}

export function Show79SettlementPanel({ tickets, records, month, onSave, financialReviewMessage, disabled = false, accountId }: Show79SettlementPanelProps) {
  const journal = useFinancialSubmission(accountId ?? tickets[0]?.userId ?? records[0]?.userId ?? '', 'settlement')
  const effectiveMonth = journal.pending?.month ?? month
  const confirmedRecords = useMemo(() => records.filter((record) => record.syncStatus === 'synced'), [records])
  const pendingRecords = useMemo(() => records.filter((record) => record.syncStatus !== 'synced' && record.month === effectiveMonth)
    .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), [records, effectiveMonth])
  const result = useMemo(() => {
    try { return { state: buildShow79SettlementState(tickets, confirmedRecords, effectiveMonth), error: '' } }
    catch (reason) { return { state: null, error: reason instanceof Error ? reason.message : '本月结算暂时无法计算。' } }
  }, [tickets, confirmedRecords, effectiveMonth])
  if (!result.state) return <details className="show79-settlement"><summary>本月结算：无法计算</summary><p className="form-error" role="alert">{result.error}</p></details>
  // A pending submission takes precedence over month navigation until confirmed.
  return <SettlementMonth key={effectiveMonth} state={result.state} pendingRecords={pendingRecords} financialReviewMessage={financialReviewMessage} onSave={onSave} disabled={disabled} journal={journal} />
}

function SettlementMonth({ state, pendingRecords, financialReviewMessage, onSave, disabled, journal }: { state: Show79SettlementState; pendingRecords: Show79SettlementRecord[]; financialReviewMessage?: string; onSave: (input: Show79SettlementInput) => Promise<void>; disabled: boolean; journal: ReturnType<typeof useFinancialSubmission<'settlement'>> }) {
  const [date, setDate] = useState(journal.pending?.paymentDate ?? getBangkokDate())
  const [jimmy, setJimmy] = useState(() => journal.pending?.jimmyPaidThb.toFixed(2) ?? state.remainingJimmyThb.toFixed(2))
  const [partners, setPartners] = useState(() => journal.pending?.partnersPaidThb.toFixed(2) ?? state.remainingPartnersThb.toFixed(2))
  const [note, setNote] = useState(journal.pending?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const savingRef = useRef(false)
  const touchedRef = useRef(Boolean(journal.pending))
  const mountedRef = useRef(true)
  const hasPendingHistory = pendingRecords.length > 0
  // Keep both the identity and exact expected snapshot when a result is unknown.
  const operationRef = useRef<Show79SettlementInput | null>(journal.pending)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  useEffect(() => {
    if (!touchedRef.current && !savingRef.current && !journal.pending) {
      setJimmy(state.remainingJimmyThb.toFixed(2)); setPartners(state.remainingPartnersThb.toFixed(2))
    }
  }, [state.remainingJimmyThb, state.remainingPartnersThb, journal.pending])

  const edit = (update: () => void) => {
    if (savingRef.current || disabled || hasPendingHistory || journal.pending || journal.error) return
    touchedRef.current = true; setError(''); setMessage(''); update()
  }
  const fillDifference = () => edit(() => { setJimmy(state.remainingJimmyThb.toFixed(2)); setPartners(state.remainingPartnersThb.toFixed(2)) })
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (savingRef.current || disabled || (hasPendingHistory && !journal.pending)) return
    setError(''); setMessage('')
    try {
      if (!jimmy.trim() || !partners.trim()) throw new Error('请填写两方本次实际金额；未支付或收回的一方请填0。')
      const values = { month: state.month, paymentDate: date, jimmyPaidThb: Number(jimmy), partnersPaidThb: Number(partners), note: note.trim() }
      if (!operationRef.current) {
        const input = { operationId: createId(), ...values, expectedProfitThb: state.profitThb, expectedJimmyPaidThb: state.paidJimmyThb, expectedPartnersPaidThb: state.paidPartnersThb }
        validateShow79SettlementInput(input)
        operationRef.current = journal.stage(input)
      }
      const input = operationRef.current
      validateShow79SettlementInput(input)
      savingRef.current = true; setSaving(true)
      await onSave(input)
      journal.clear(input.operationId)
      if (!mountedRef.current) return
      operationRef.current = null; touchedRef.current = true
      setJimmy(''); setPartners(''); setNote(''); setDate(getBangkokDate())
      setMessage('本次分账已登记，请核对最新累计金额。这里只记账，不会转账。')
    } catch (reason) {
      // A stale-state rejection cannot have committed; a retry may use the
      // refreshed snapshot. Unknown network results keep their original ID.
      if ((reason as { code?: string })?.code === '40001' && operationRef.current) {
        journal.clear(operationRef.current.operationId)
        operationRef.current = null
      }
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
      {hasPendingHistory && <p className="financial-pending" role="status">{financialReviewMessage ? `历史分账需要人工核对：${financialReviewMessage} 为避免重复付款，待确认记录未计入累计金额，且新的分账登记已暂时锁定。` : `本月有 ${pendingRecords.length} 笔历史分账等待云端确认。为避免重复付款，待确认记录未计入累计金额，且新的分账登记已暂时锁定。`}</p>}
      <form className="show79-settlement-form" onSubmit={event => void submit(event)}>
        <fieldset disabled={disabled || saving || hasPendingHistory || Boolean(journal.pending) || Boolean(journal.error)}>
          <legend>登记已实际发生的分账</legend>
          <p className="show79-settlement-description">以下是本次增量金额，不会覆盖历史。正数表示已付出，负数表示已收回或冲正；这里只登记，不会自动转账。</p>
          <label>实际付款日期（曼谷）<input type="date" value={date} max={getBangkokDate()} onChange={event => edit(() => setDate(event.target.value))} required /></label>
          <div className="show79-settlement-amounts">
            <label>jimmy 本次实际金额（THB）<input inputMode="decimal" type="number" step="0.01" value={jimmy} onChange={event => edit(() => setJimmy(event.target.value))} required /></label>
            <label>大狗二狗本次实际金额（THB）<input inputMode="decimal" type="number" step="0.01" value={partners} onChange={event => edit(() => setPartners(event.target.value))} required /></label>
          </div>
          <button className="text-action" type="button" onClick={fillDifference}>填入当前差额</button>
          <label>本次分账备注（收回／冲正必填）<textarea value={note} maxLength={300} onChange={event => edit(() => setNote(event.target.value))} placeholder="例如：10月分账；退票后收回多付金额" /></label>
          {!journal.pending && !hasPendingHistory && <button className="primary-button" type="submit" aria-busy={saving}>登记本次分账</button>}
        </fieldset>
        {journal.pending && <div className="financial-pending"><p role="status">{journal.pending.month.replace('-', '/')} 有一笔分账结果待核对，原金额、日期和备注已锁定。请先核对／重试原笔，完成后才能登记新付款。</p><button className="primary-button" type="submit" disabled={disabled || saving || Boolean(journal.error)}>{saving ? '正在登记…' : '核对／重试本次分账'}</button></div>}
        {disabled && <p className="show79-settlement-description">当前暂不能登记，请先登录并完成同步后重试。</p>}
        {(error || journal.error) && <p className="form-error" role="alert">{error || journal.error}</p>}
        {message && <p className="show79-settlement-success" role="status">{message}</p>}
      </form>
      <section className="show79-settlement-history" aria-label="已确认分账历史">
        <h3>已确认分账历史 · {state.records.length} 笔</h3>
        {!state.records.length ? <p className="show79-settlement-description">尚未登记分账；展示的应分成不会自动记为已支付。</p> : <ol>{state.records.map(record => <li key={record.id}>
          <strong>{record.paymentDate.replaceAll('-', '/')} · 实际付款日期</strong>
          <p>本次实际金额：jimmy {formatThb(record.jimmyPaidThb)} · 大狗二狗 {formatThb(record.partnersPaidThb)}</p>
          <p>登记时快照：净利润 {formatThb(record.snapshotProfitThb)} · jimmy {formatThb(record.snapshotJimmyThb)} · 大狗二狗 {formatThb(record.snapshotPartnersThb)}</p>
          {record.note && <p>备注：{record.note}</p>}
          <small>{record.syncStatus === 'synced' ? '已确认' : '等待同步确认'}</small>
        </li>)}</ol>}
      </section>
      {pendingRecords.length > 0 && <section className="financial-pending show79-pending-history" aria-label="待核对的历史分账">
        <h3>待核对的历史分账 · {pendingRecords.length} 笔</h3>
        <p>这些本机历史分账尚未获得云端确认，未计入“累计净已付”或本月差额。请先核对后再付款，避免重复分账。</p>
        <ol>{pendingRecords.map(record => <li key={record.id}>
          <strong>{record.paymentDate.replaceAll('-', '/')} · 等待云端确认</strong>
          <p>本次实际金额：jimmy {formatThb(record.jimmyPaidThb)} · 大狗二狗 {formatThb(record.partnersPaidThb)}</p>
          {record.note && <p>备注：{record.note}</p>}
        </li>)}</ol>
      </section>}
    </div>
  </details>
}
