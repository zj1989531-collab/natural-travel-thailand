import { useId, useMemo, useState } from 'react'
import type { TicketRecord } from '../types'
import { formatThb } from '../lib/format'
import { buildProfitTrend, type ProfitTrend } from '../lib/profit-trend'

const signedMoney = (amount: number) => `${amount > 0 ? '+' : ''}${formatThb(amount)}`
const axisMoney = (amount: number) => new Intl.NumberFormat('en-US', { notation: Math.abs(amount) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(amount) < 1 ? 2 : 1 }).format(amount)

export function ProfitTrendChart({ trend, selectedDate, onSelect }: { trend: ProfitTrend; selectedDate: string; onSelect: (date: string) => void }) {
  const descriptionId = useId()
  const width = 360, height = 200, left = 48, right = 12, top = 16, bottom = 30
  const values = trend.days.flatMap(day => [day.dailyProfitThb, day.monthlyProfitThb])
  const low = Math.min(0, ...values), high = Math.max(0, ...values)
  const padding = (high - low || 1) * 0.12
  const min = low < 0 ? low - padding : 0
  const max = high > 0 ? high + padding : low < 0 ? 0 : 1
  const x = (index: number) => left + (trend.days.length === 1 ? (width - left - right) / 2 : index / (trend.days.length - 1) * (width - left - right))
  const y = (amount: number) => top + (max - amount) / (max - min) * (height - top - bottom)
  const selected = Math.max(0, trend.days.findIndex(day => day.date === selectedDate))
  const indices = [...new Set([0, Math.floor((trend.days.length - 1) / 2), trend.days.length - 1])]
  const points = (key: 'dailyProfitThb' | 'monthlyProfitThb') => trend.days.map((day, index) => `${x(index)},${y(day[key])}`).join(' ')
  return <svg className="profit-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日利润走势" aria-describedby={descriptionId}
    onClick={event => {
      const box = event.currentTarget.getBoundingClientRect()
      if (!box.width) return
      const position = (event.clientX - box.left) / box.width * width
      const index = Math.max(0, Math.min(trend.days.length - 1, Math.round((position - left) / (width - left - right) * (trend.days.length - 1))))
      onSelect(trend.days[index].date)
    }}>
    <desc id={descriptionId}>按出票日期显示每日非累计利润。绿色实线为日结，橙色虚线为月结；零线下方表示亏损。可用下方日期选择和每日明细查看精确金额。</desc>
    {[min, (min + max) / 2, max].map((amount, index) => <g key={index}><line x1={left} x2={width - right} y1={y(amount)} y2={y(amount)} stroke="#e5ece7" /><text x={left - 7} y={y(amount) + 4} textAnchor="end">{axisMoney(amount)}</text></g>)}
    <line className="trend-zero" x1={left} x2={width - right} y1={y(0)} y2={y(0)} />
    {low < 0 && high > 0 && <text x={left - 7} y={y(0) + 4} textAnchor="end">0</text>}
    <text x={left} y={10}>THB</text>
    <polyline className="trend-daily-line" points={points('dailyProfitThb')} vectorEffect="non-scaling-stroke" />
    <polyline className="trend-monthly-line" points={points('monthlyProfitThb')} vectorEffect="non-scaling-stroke" />
    <line x1={x(selected)} x2={x(selected)} y1={top} y2={height - bottom} stroke="#8a9f94" strokeDasharray="2 4" />
    <circle cx={x(selected)} cy={y(trend.days[selected].dailyProfitThb)} r="4" fill="#176a59" stroke="white" />
    <rect x={x(selected) - 3.5} y={y(trend.days[selected].monthlyProfitThb) - 3.5} width="7" height="7" fill="#b66a19" stroke="white" />
    {indices.map(index => <text key={index} x={x(index)} y={height - 9} textAnchor="middle">{Number(trend.days[index].date.slice(8))}日</text>)}
  </svg>
}

export function ProfitTrendPanel({ tickets, today, pendingCount = 0, offline = false }: { tickets: TicketRecord[]; today: string; pendingCount?: number; offline?: boolean }) {
  // Null follows the current Bangkok month. A chosen historic month stays put.
  const [historicMonth, setHistoricMonth] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [monthError, setMonthError] = useState('')
  const currentMonth = today.slice(0, 7)
  const month = historicMonth && historicMonth < currentMonth ? historicMonth : currentMonth
  const trend = useMemo(() => buildProfitTrend(tickets, month, today), [tickets, month, today])
  const selected = trend.days.find(day => day.date === selectedDate) ?? trend.days.at(-1)!
  const unavailable = trend.percentageUnavailable === 'no_records' ? '上期无记录，仅展示金额差额。' : trend.percentageUnavailable === 'zero' ? '上期利润为零，仅展示金额差额。' : trend.percentageUnavailable === 'loss' ? '上期为亏损，仅展示金额差额。' : ''
  return <section className="summary-panel profit-trend-panel" aria-label="利润分析">
    <div className="section-heading"><div><p className="eyebrow">PROFIT INSIGHTS</p><h2>利润走势与对比</h2></div><span className="ticket-count">{trend.mode === 'to_date' ? '截至今天' : '整月对比'}</span></div>
    <p className="trend-caption">{trend.mode === 'to_date' ? '本月截至今天，对比上月同期；上月天数不足时取月底。' : '历史月份按整月对比上个月整月。'}</p>
    <div className="trend-month-controls"><label>分析月份<input aria-label="分析月份" type="month" value={month} max={currentMonth} onChange={event => {
      const value = event.target.value
      if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value) || value > currentMonth) { setMonthError('请选择当前或历史月份。'); return }
      setHistoricMonth(value === currentMonth ? null : value); setSelectedDate(''); setMonthError('')
    }} /></label><button className="secondary-button" type="button" disabled={month === currentMonth} onClick={() => { setHistoricMonth(null); setSelectedDate(''); setMonthError('') }}>返回本月</button></div>
    {monthError && <p className="form-error" role="alert">{monthError}</p>}
    {(offline || pendingCount > 0) && <p className="trend-notice" role="status">{offline ? '当前离线，展示本机已缓存数据。' : '展示本机当前数据。'}{pendingCount > 0 ? `有 ${pendingCount} 条资料待同步，联网后自动更新。` : offline ? '联网后将自动核对云端修改。' : ''}</p>}
    <div className="trend-comparison">
      <div className="trend-period"><span>本期利润</span><strong className={trend.current.totalProfitThb < 0 ? 'loss-value' : 'profit-value'}>{formatThb(trend.current.totalProfitThb)}</strong><small>{trend.currentRange.start} — {trend.currentRange.end}</small></div>
      <div className="trend-period"><span>上期利润</span><strong className={trend.previous.totalProfitThb < 0 ? 'loss-value' : ''}>{formatThb(trend.previous.totalProfitThb)}</strong><small>{trend.previousRange.start} — {trend.previousRange.end}</small></div>
    </div>
    <p className={`trend-difference ${trend.differenceThb < 0 ? 'loss-value' : 'profit-value'}`}>较上期{trend.differenceThb > 0 ? '增加' : trend.differenceThb < 0 ? '减少' : '持平'} <strong>{signedMoney(trend.differenceThb)}</strong>{trend.percentage != null && <span>（{trend.percentage > 0 ? '+' : ''}{trend.percentage.toFixed(1)}%）</span>}</p>
    {unavailable && <p className="trend-caption">{unavailable}</p>}
    <div className="trend-table-scroll" role="region" aria-label="日结与月结利润对比" tabIndex={0}><table className="trend-table"><thead><tr><th scope="col">结算方式</th><th scope="col">本期</th><th scope="col">上期</th></tr></thead><tbody>{(['daily', 'monthly'] as const).map(mode => { const key = mode === 'daily' ? 'dailyProfitThb' : 'monthlyProfitThb'; return <tr key={mode}><th scope="row">{mode === 'daily' ? '日结利润' : '月结利润'}</th><td>{formatThb(trend.current[key])}</td><td>{formatThb(trend.previous[key])}</td></tr> })}</tbody></table></div>
    <div className="trend-chart-heading"><h3>每日利润</h3><span>非累计 · THB</span></div>
    <div className="trend-legend"><span><i className="trend-daily-swatch" />日结利润</span><span><i className="trend-monthly-swatch" />月结利润</span></div>
    {!trend.current.recordCount && <p className="trend-notice">{trend.mode === 'to_date' ? '本月截至今天暂无记录。' : '当前月份暂无记录。'}无记录的日期按零显示。</p>}
    <ProfitTrendChart trend={trend} selectedDate={selected.date} onSelect={setSelectedDate} />
    <p className="trend-caption">点击图中日期查看，或使用下方日期选择。</p>
    <label className="trend-date-picker">查看日期<select value={selected.date} onChange={event => setSelectedDate(event.target.value)}>{trend.days.map(day => <option key={day.date} value={day.date}>{day.date}</option>)}</select></label>
    <div className="trend-day-detail" role="status" aria-label="所选日期利润"><strong>{selected.date}</strong><span>日结 {formatThb(selected.dailyProfitThb)}</span><span>月结 {formatThb(selected.monthlyProfitThb)}</span><b>合计 {formatThb(selected.totalProfitThb)}</b></div>
    <details className="trend-details"><summary>展开每日明细</summary><div className="trend-table-scroll" role="region" aria-label="每日利润明细" tabIndex={0}><table className="trend-table"><thead><tr><th scope="col">日期</th><th scope="col">日结</th><th scope="col">月结</th><th scope="col">合计</th></tr></thead><tbody>{trend.days.map(day => <tr key={day.date}><th scope="row"><button type="button" onClick={() => setSelectedDate(day.date)} aria-label={`查看${day.date}利润`}>{day.date.slice(5)}</button></th><td>{formatThb(day.dailyProfitThb)}</td><td>{formatThb(day.monthlyProfitThb)}</td><td>{formatThb(day.totalProfitThb)}</td></tr>)}</tbody><tfoot><tr><th scope="row">合计</th><td>{formatThb(trend.current.dailyProfitThb)}</td><td>{formatThb(trend.current.monthlyProfitThb)}</td><td>{formatThb(trend.current.totalProfitThb)}</td></tr></tfoot></table></div></details>
    <p className="stats-note">{trend.mode === 'to_date' ? '此处只统计本月1日至今天；上方本月月报仍统计整月，若有未来日期记录，金额可能不同。' : '所选月份整月与上个月整月对比，月份天数可能不同。'}月结利润按出票日期展示，不代表已到账；退票损益回算原出票日期。与主账本一致，不含79秀独立账本。</p>
  </section>
}
