import { useEffect, useId, useRef, useState } from 'react'
import type { SyncConflictRecord, SyncConflictSource } from '../lib/sync-conflicts'
import { formatThb, isValidPersonCount } from '../lib/format'
import { getTicketAmounts } from '../lib/ticket-amounts'
import { getRefundState } from '../lib/refunds'
import { resolveProjectRules } from '../lib/project-rules'
import './sync-conflict-panel.css'

interface Props {
  records: SyncConflictRecord[]
  onClose: () => void
  onResolve: (id: string) => Promise<void>
}

const money = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? formatThb(value) : '未填写'
const savedTime = (value: string) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok', hourCycle: 'h23' }) : value || '未记录'
}
const reasonLabels: Record<SyncConflictRecord['reason'], string> = {
  remote_newer: '云端已有更新', refund_locked: '原票已有退票，修改未被接受', upload_rejected: '云端未接受此修改'
}
const tableLabels: Record<SyncConflictRecord['table'], string> = {
  tickets: '订单', projects: '项目套餐', suppliers: '供货商', ticket_refunds: '退票'
}

export const syncConflictSnapshotFields = (record: SyncConflictSource): [string, string][] => {
  const fields: [string, string][] = []
  if ('issueDate' in record) {
    const unit = record.quantityUnit === 'item' ? '件' : '人'
    const refund = getRefundState(record)
    const hasRefunds = Array.isArray(record.refunds)
    const canCalculate = (record.amountBasis !== 'per_person' || typeof record.personCount === 'number' && isValidPersonCount(record.personCount)) &&
      (record.entryMode === 'profit_only' ? Number.isFinite(record.manualProfitThb) : Number.isFinite(record.agentPriceThb) && Number.isFinite(record.costThb))
    const amounts = canCalculate ? getTicketAmounts(record) : null
    fields.push(['客户姓名', record.guestName?.trim() || '未填写'], ['日期', record.issueDate], ['曼谷时间', record.issueTime || '未记录'],
      ['项目', record.projectName || '未分类项目'], ['套餐', record.subItemName || '不分套餐'], ['供货商', record.supplierName],
      ['原人数／数量', record.personCount == null ? '未填写' : `${record.personCount} ${unit}`],
      ['有效人数／数量', record.entryMode === 'profit_only' ? '仅录利润，不计人数／数量' : !hasRefunds ? '未附退票明细，待核对' : refund.remainingPeople == null ? '未填写' : `${refund.remainingPeople} ${unit}`],
      ['计价方式', record.amountBasis === 'per_person' ? `每${unit === '件' ? '件' : '人'}金额 × 数量` : '整单总额'])
    if (record.entryMode === 'profit_only') fields.push(['填写的利润', money(record.manualProfitThb)])
    else fields.push([record.amountBasis === 'per_person' ? `每${unit === '件' ? '件' : '人'}售价` : '整单售价', money(record.agentPriceThb)],
      [record.amountBasis === 'per_person' ? `每${unit === '件' ? '件' : '人'}成本` : '整单成本', money(record.costThb)],
      [hasRefunds ? '实际总售价' : '原票总售价', amounts ? money(amounts.agentPriceThb) : '金额或数量未填完整'], [hasRefunds ? '实际总成本' : '原票总成本', amounts ? money(amounts.costThb) : '金额或数量未填完整'])
    fields.push([hasRefunds || record.entryMode === 'profit_only' ? '实际利润' : '原票利润', amounts ? money(amounts.profitThb) : '金额或数量未填完整'],
      ['退票状态', !hasRefunds ? '未附退票明细，待核对' : refund.full ? '已全部退票' : refund.active.length ? `部分退票 · 已退 ${refund.refundedPeople} ${unit}` : '未退票'],
      ['订单状态', record.deletedAt ? '已删除' : '有效'], ['备注', record.note || '无'])
    if (!hasRefunds) fields.push(['净额说明', '此副本未包含退票明细，请以当前订单核对净额'])
  } else if ('defaultAgentPriceThb' in record) {
    const rules = resolveProjectRules(record)
    fields.push(['项目', record.name], ['套餐', record.subItemName || '不分套餐'], ['供货商', record.supplierName],
      ['记录类型', record.entryMode === 'profit_only' ? '仅录利润' : '普通出票'], ['数量单位', record.quantityUnit === 'item' ? '件' : '人'],
      ['默认计价方式', rules.defaultAmountBasis === 'per_person' ? '按人数／件数计算' : '整单总额'], ['结算方式', rules.settlementMode === 'monthly' ? '月结' : '日结'])
    if (record.entryMode !== 'profit_only') fields.push(['默认售价', record.manualAgentPrice ? '需手动填写' : money(record.defaultAgentPriceThb)], ['默认成本', money(record.defaultCostThb)])
    if (record.mergedIntoId) fields.push(['状态', '已合并至其他项目'])
  } else if ('ticketId' in record) {
    fields.push(['原票编号', record.ticketId], ['退票日期', record.refundDate], ['退票时间（曼谷）', record.refundTime || '未记录'],
      ['退票范围', record.isFull ? '全部剩余' : '部分'], ['退票人数／数量', record.personCount == null ? '原数量未知' : String(record.personCount)],
      ['退给代理', money(record.refundRevenueThb)], ['供货商返还', money(record.returnedCostThb)],
      ['本次利润影响', record.cancelledAt ? '已撤销，不计影响' : money(record.returnedCostThb - record.refundRevenueThb)],
      ['退票状态', record.cancelledAt ? '已撤销' : '有效'], ['备注', record.note || '无'])
  } else {
    fields.push(['供货商名称', record.name], ['状态', record.mergedIntoId ? '已合并至其他供货商' : '有效'])
  }
  fields.push(['记录编号', record.id], ['修改时间（曼谷）', savedTime(record.updatedAt)])
  return fields
}

export const syncConflictLocalText = (record: SyncConflictRecord) => [
  `${tableLabels[record.table]} · 本机保存的修改副本`, `保存原因：${reasonLabels[record.reason]}`, `副本保存时间：${savedTime(record.createdAt)}（曼谷）`,
  ...syncConflictSnapshotFields(record.localRecord).map(([label, value]) => `${label}：${value}`)
].join('\n')

function Snapshot({ source, title }: { source: SyncConflictSource | null; title: string }) {
  const titleId = useId()
  return <section className="sync-conflict-snapshot" aria-labelledby={titleId}><h4 id={titleId}>{title}</h4>{source ? <dl>{syncConflictSnapshotFields(source).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p>未取得可显示的云端记录；这不代表云端记录已删除。请联网刷新账本后核对。</p>}</section>
}

export function SyncConflictPanel({ records, onClose, onResolve }: Props) {
  const titleId = useId()
  const copyId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const fallbackRef = useRef<HTMLTextAreaElement>(null)
  const operationRef = useRef(false)
  const copyLock = useRef(false)
  const [showHistory, setShowHistory] = useState(false)
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(() => new Set())
  const [resolvingId, setResolvingId] = useState('')
  const [copyingId, setCopyingId] = useState('')
  const [fallbackId, setFallbackId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const isResolved = (record: SyncConflictRecord) => Boolean(record.resolvedAt || resolvedIds.has(record.id))
  const pending = records.filter((record) => !isResolved(record))
  const history = records.filter(isResolved)
  const visible = [...(showHistory ? history : pending)].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  const fallback = records.find((record) => record.id === fallbackId)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => { document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus() }
  }, [])
  useEffect(() => { if (fallbackId) { fallbackRef.current?.focus(); fallbackRef.current?.select() } }, [fallbackId])

  const resolve = async (record: SyncConflictRecord) => {
    if (operationRef.current || isResolved(record)) return
    operationRef.current = true
    try {
      if (!window.confirm('保留当前账本并标记已核对？\n\n已取得云端版本的记录采用云端内容。云端未接受、且之后未再编辑的草稿会从活动账本移除；之后已再编辑的内容保留。\n\n本机修改副本继续保留在此设备的已处理历史中；这不会覆盖云端。如需保留本机修改，请先复制内容，核对后手工重新录入。')) return
      setResolvingId(record.id); setError(''); setMessage('')
      await onResolve(record.id)
      setResolvedIds((current) => new Set(current).add(record.id))
      setMessage('已标记为已核对。本机修改副本继续保留，可在“已处理历史”中查看。')
      panelRef.current?.focus({ preventScroll: true })
    } catch (reason) { setError(`核对未完成：${reason instanceof Error ? reason.message : '请稍后重试。'} 副本仍保留，请核对当前账本。`) }
    finally { operationRef.current = false; setResolvingId('') }
  }
  const copy = async (record: SyncConflictRecord) => {
    if (copyLock.current || operationRef.current) return
    copyLock.current = true; setCopyingId(record.id); setError(''); setMessage('')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(syncConflictLocalText(record))
      setMessage('本机修改内容已复制，可核对后手工重新录入。')
    } catch {
      setFallbackId(record.id)
      setError('浏览器未能直接复制。下方已显示本机内容，请长按文字选择并复制。')
    } finally { copyLock.current = false; setCopyingId('') }
  }

  return <div className="sync-conflict-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !operationRef.current) onClose() }}>
    <section ref={panelRef} className="sync-conflict-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(event) => {
      if (event.key === 'Escape' && !operationRef.current) { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key !== 'Tab') return
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? [])].filter((element) => element.getClientRects().length > 0)
      const first = focusable[0], last = focusable.at(-1)
      if (!first || !last) { event.preventDefault(); panelRef.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panelRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }} tabIndex={-1}>
      <header className="sync-conflict-heading"><div><p>当前设备 · 本机副本</p><h2 id={titleId}>同步冲突核对</h2></div><button ref={closeRef} type="button" aria-label="关闭同步冲突核对" disabled={Boolean(resolvingId)} onClick={onClose}>×</button></header>
      <p className="sync-conflict-explanation">本机未被云端接受的修改已另存副本。请比较本机副本与云端记录；此处不会自动用本机内容覆盖云端。副本仅保留在当前设备，清除浏览器资料可能丢失。</p>
      <p className="sync-conflict-explanation">标记已核对后，有云端版本的记录采用云端内容；云端未接受、且之后未再编辑的草稿会从活动账本移除，之后已再编辑的内容保留。本机修改副本仍可在已处理历史中查看。</p>
      <div className="sync-conflict-tabs" role="group" aria-label="副本状态"><button type="button" aria-pressed={!showHistory} disabled={Boolean(resolvingId)} onClick={() => { setShowHistory(false); setFallbackId('') }}>待核对 · {pending.length}</button><button type="button" aria-pressed={showHistory} disabled={Boolean(resolvingId)} onClick={() => { setShowHistory(true); setFallbackId('') }}>已处理历史 · {history.length}</button></div>
      {error && <p className="sync-conflict-error" role="alert">{error}</p>}{message && <p className="sync-conflict-message" role="status">{message}</p>}
      {fallback && <div className="sync-conflict-copy-fallback"><label htmlFor={copyId}>本机内容文字（可长按复制）</label><textarea id={copyId} ref={fallbackRef} readOnly value={syncConflictLocalText(fallback)} onFocus={(event) => event.currentTarget.select()} /></div>}
      <div className="sync-conflict-list">{!visible.length && <p className="sync-conflict-empty">{showHistory ? '没有已处理的副本。' : '没有待核对的副本。'}</p>}{visible.map((record) => <article className="sync-conflict-item" key={record.id}>
        <div className="sync-conflict-item-heading"><h3>{tableLabels[record.table]} · {reasonLabels[record.reason]}</h3><span className={isResolved(record) ? 'is-resolved' : 'is-pending'}>{isResolved(record) ? '已处理' : '待核对'}</span></div>
        <p className="sync-conflict-time">副本保存：{savedTime(record.createdAt)}（曼谷）{record.resolvedAt ? ` · 已核对：${savedTime(record.resolvedAt)}（曼谷）` : ''}</p>
        {record.message && <p className="sync-conflict-reason">原因：{record.message}</p>}
        <div className="sync-conflict-comparison"><Snapshot title="本机保存的修改副本" source={record.localRecord} /><Snapshot title="核对时取得的云端记录" source={record.remoteRecord} /></div>
        <p className="sync-conflict-footnote">云端内容可能继续更新，以上是保存副本时取得的版本。核对后可手工重新录入需要保留的修改。</p>
        <div className="sync-conflict-actions"><button type="button" disabled={Boolean(resolvingId || copyingId)} onClick={() => void copy(record)}>{copyingId === record.id ? '正在复制…' : '复制本机内容'}</button>{!isResolved(record) && <button type="button" className="sync-conflict-resolve" disabled={Boolean(resolvingId || copyingId)} onClick={() => void resolve(record)}>{resolvingId === record.id ? '正在标记…' : '保留当前账本并标记已核对'}</button>}</div>
      </article>)}</div>
    </section>
  </div>
}
