import { useMemo, useState } from 'react'
import type { Project, Supplier, TicketRecord } from '../types'
import { formatNumber, formatThb, getBangkokDate, getBangkokMonth, getBangkokTime } from '../lib/format'
import { buildReport, type LedgerReport, type ReportMode, type ReportQuery } from '../lib/reports'
import { activeTickets, getProfit, monthDateRange } from '../lib/stats'
import { projectNames } from '../lib/project-selection'

function RecordTable({ records, caption }: { records: TicketRecord[]; caption: string }) {
  const totalProfit = records.reduce((sum, ticket) => sum + getProfit(ticket), 0)
  return <div className="report-table-scroll" role="region" aria-label={caption} tabIndex={0}>
    <table className="report-table report-record-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">日期 / 时间</th><th scope="col">项目 / 供货商</th><th scope="col">人数</th><th scope="col">利润</th></tr></thead>
      <tbody>{records.map((ticket) => {
        const profit = getProfit(ticket)
        return <tr key={ticket.id}>
          <td>{ticket.issueDate}<small>{ticket.issueTime ? `${ticket.issueTime} 曼谷` : '时间未记录'}</small></td>
          <td><strong>{ticket.projectName || '未分类项目'}{ticket.subItemName ? ` · ${ticket.subItemName}` : ''}</strong><small>{ticket.supplierName} · {ticket.entryMode === 'profit_only' ? '仅录利润' : ticket.amountBasis === 'per_person' ? '按人数计价' : '整单总额'}</small>{ticket.note && <small className="report-record-note">备注：{ticket.note}</small>}</td>
          <td className="report-number">{ticket.personCount == null ? '—' : formatNumber(ticket.personCount)}</td>
          <td className={`report-money ${profit < 0 ? 'loss-value' : 'profit-value'}`}>{formatThb(profit)}</td>
        </tr>
      })}</tbody>
      <tfoot><tr><th scope="row" colSpan={3}>合计 · {records.length} 条记录</th><td className="report-money">{formatThb(totalProfit)}</td></tr></tfoot>
    </table>
  </div>
}

export function ReportPreview({ report, supplierName, pendingCount = 0, generatedAt }: { report: LedgerReport; supplierName: string; pendingCount?: number; generatedAt: string }) {
  return <article className="report-paper" aria-label="格式化报表预览">
    <header className="report-paper-heading">
      <p className="eyebrow">票务盈利簿 · THB · Asia/Bangkok</p>
      <h2>{report.title}</h2>
      <p>{report.mode === 'all' ? '全部已录日期（累计）' : report.start === report.end ? report.start : `${report.start} — ${report.end}`}</p>
      <div className="report-meta"><span>项目：{report.projectName || '全部项目'}</span><span>供货商：{supplierName}</span><span>预览时间：{generatedAt}（曼谷）</span></div>
    </header>
    {pendingCount > 0 && <p className="report-notice">当前账本有 {pendingCount} 条记录待同步；此预览来自本机当前账本，可能包含尚未上传的修改。</p>}
    <div className="report-totals">
      <div className={report.summary.profitThb < 0 ? 'report-loss' : 'report-profit'}><span>总利润</span><strong>{formatThb(report.summary.profitThb)}</strong></div>
    </div>
    <section className="report-quantity" aria-label="项目出票数量查询">
      <h3>项目出票数量查询</h3>
      <div className="report-quantity-metrics"><div><span>出票记录数</span><strong>{formatNumber(report.quantity.recordCount)} 笔</strong></div><div><span>已录人数</span><strong>{formatNumber(report.quantity.peopleCount)} 人</strong></div></div>
      <p className="report-note">门票类项目按每人1张：已录 {formatNumber(report.quantity.peopleCount)} 张；包船、包车等项目仅表示人数。数量查询包含月结出票项目，不受每日利润排除规则影响；仅录返佣利润的记录不计出票数量。</p>
      {report.quantity.unknownCount > 0 && <p className="report-notice">另有 {report.quantity.unknownCount} 笔出票记录未填写人数，以上数量仅为已录部分，不能作为完整门票总数。</p>}
      {report.quantity.days.length > 0 && <div className="report-table-scroll" role="region" aria-label="每日出票数量" tabIndex={0}><table className="report-table report-quantity-table"><caption>每日出票数量</caption><thead><tr><th scope="col">日期</th><th scope="col">出票记录</th><th scope="col">已录人数</th><th scope="col">人数未填</th></tr></thead><tbody>{report.quantity.days.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td className="report-number">{day.recordCount}</td><td className="report-number">{formatNumber(day.peopleCount)}</td><td className="report-number">{day.unknownCount}</td></tr>)}</tbody><tfoot><tr><th scope="row">合计</th><td className="report-number">{report.quantity.recordCount}</td><td className="report-number">{formatNumber(report.quantity.peopleCount)}</td><td className="report-number">{report.quantity.unknownCount}</td></tr></tfoot></table></div>}
    </section>
    <p className="report-counts">利润合计包含 {report.records.length} 条记录 · 已录人数 {formatNumber(report.recordedPeople)} 人</p>
    {report.unknownHeadcounts > 0 && <p className="report-notice">{report.unknownHeadcounts} 条出票记录未填写人数，不计入已录人数；仅录利润记录也不计入出票记录数及已录人数。</p>}
    <p className="report-note">{report.mode === 'day' ? '日报合计不含月结项目；当天月结记录在下方另列，计入所属月份的月报。' : report.mode === 'all' ? '累计报表包含全部已录日期内符合项目和供货商条件的有效记录及月结返佣。' : '包含所选日期范围内的全部有效记录及月结返佣。月报按曼谷自然月1日至月底统计。'}利润均为总额，已按各记录的计价方式计算；旧记录不重复乘人数。</p>

    <section className="report-section"><h3>供货商汇总 · 按利润排序</h3>
      {report.supplierStats.length === 0 ? <p className="report-empty">当前范围没有计入本报表的记录。</p> : <div className="report-table-scroll" role="region" aria-label="供货商汇总" tabIndex={0}>
        <table className="report-table report-supplier-table"><caption>供货商汇总</caption>
          <thead><tr><th scope="col">供货商</th><th scope="col">出票记录</th><th scope="col">利润</th></tr></thead>
          <tbody>{report.supplierStats.map((supplier) => <tr key={supplier.supplierId}><th scope="row">{supplier.supplierName}</th><td className="report-number">{supplier.count}</td><td className={`report-money ${supplier.profitThb < 0 ? 'loss-value' : 'profit-value'}`}>{formatThb(supplier.profitThb)}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">合计</th><td className="report-number">{report.summary.count}</td><td className="report-money">{formatThb(report.summary.profitThb)}</td></tr></tfoot>
        </table>
      </div>}
    </section>
    <section className="report-section"><h3>记录明细</h3>{report.records.length > 0 ? <RecordTable records={report.records} caption="报表记录明细" /> : <p className="report-empty">没有符合当前报表条件的记录。</p>}</section>
    {report.mode === 'day' && report.monthlyRecords.length > 0 && <section className="report-section report-monthly-section"><h3>月结项目另列 · 不计入日报合计</h3><p className="report-note">{report.monthlyRecords.length} 条月结记录 · 利润 {formatThb(report.monthlySummary.profitThb)}，包含在对应月报中。</p><RecordTable records={report.monthlyRecords} caption="当日月结记录（不计入日报合计）" /></section>}
    <footer className="report-footer">按出票日期统计 · 已排除删除记录 · 仅录利润项目不计出票数量 · 修改账本后报表自动更新</footer>
  </article>
}

export function ReportView({ tickets, suppliers, projects = [] }: { tickets: TicketRecord[]; suppliers: Supplier[]; projects?: Project[] }) {
  const [query, setQuery] = useState<ReportQuery>(() => {
    const month = getBangkokMonth()
    const range = monthDateRange(month)
    return { mode: 'month', month, date: getBangkokDate(), startDate: range.start, endDate: range.end, supplierId: '', projectName: '' }
  })
  const result = useMemo(() => {
    try { return { report: buildReport(tickets, query), error: '' } }
    catch (error) { return { report: null, error: error instanceof Error ? error.message : '报表暂时无法生成。' } }
  }, [tickets, query])
  const update = <K extends keyof ReportQuery>(key: K, value: ReportQuery[K]) => setQuery((current) => ({ ...current, [key]: value }))
  const generatedAt = `${getBangkokDate()} ${getBangkokTime()}`
  const names = useMemo(() => projectNames([...projects, ...activeTickets(tickets).map((ticket) => ({ name: ticket.projectName || '未分类项目', entryMode: ticket.entryMode }))]), [projects, tickets])

  return <>
    <section className="records-heading report-screen-heading"><div><p className="eyebrow">在线预览 · 随账本自动更新</p><h1>格式化报表</h1></div><button className="secondary-button small" type="button" disabled={!result.report} onClick={() => window.print()}>打印 / 保存 PDF</button></section>
    <section className="report-controls" aria-label="报表筛选">
      <label>报表类型<select value={query.mode} onChange={(event) => update('mode', event.target.value as ReportMode)}><option value="day">日报</option><option value="month">月报</option><option value="range">自定义日期范围</option><option value="all">全部日期（累计）</option></select></label>
      {query.mode === 'day' && <label>报表日期<input type="date" value={query.date} onChange={(event) => update('date', event.target.value)} /></label>}
      {query.mode === 'month' && <label>报表月份<input type="month" value={query.month} onChange={(event) => update('month', event.target.value)} /></label>}
      {query.mode === 'range' && <><label>开始日期<input type="date" value={query.startDate} onChange={(event) => update('startDate', event.target.value)} /></label><label>结束日期<input type="date" value={query.endDate} onChange={(event) => update('endDate', event.target.value)} /></label></>}
      <label>查询项目<select value={query.projectName ?? ''} onChange={(event) => update('projectName', event.target.value)}><option value="">全部项目</option>{names.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>报表供货商<select value={query.supplierId} onChange={(event) => update('supplierId', event.target.value)}><option value="">全部供货商</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
    </section>
    <p className="report-scroll-hint">手机上可左右滑动表格查看完整列；打印时仅保留报表内容。</p>
    {result.error && <p className="form-error report-error" role="alert">{result.error}</p>}
    {result.report && <ReportPreview report={result.report} supplierName={suppliers.find((supplier) => supplier.id === query.supplierId)?.name ?? (query.supplierId ? '所选供货商' : '全部供货商')} pendingCount={tickets.filter((ticket) => !ticket.deletedAt && ticket.syncStatus !== 'synced').length} generatedAt={generatedAt} />}
  </>
}
