import { useMemo, useState } from 'react'
import type { Project, Supplier, TicketRecord } from '../types'
import { formatNumber, formatThb, getBangkokDate, getBangkokMonth, getBangkokTime } from '../lib/format'
import { buildReport, reportShortcutQuery, type LedgerReport, type ReportMode, type ReportQuery, type ReportShortcut } from '../lib/reports'
import { activeTickets, getProfit, monthDateRange } from '../lib/stats'
import { projectNames } from '../lib/project-selection'
import { getEffectivePersonCount, getRefundState } from '../lib/refunds'
import { isItemQuantity, quantityLabels } from '../lib/quantity'
import { quantityParts } from '../lib/effective-quantities'
import { isIndependentLedgerProject } from '../lib/show79'
import { exportReportToXlsx } from '../lib/export'
import { buildReportCounts } from '../lib/report-counts'
import './report-mobile.css'

const countDefinition = '账务记录数包含未退、已退订单及仅录利润记录；有效订单数包含未全部退票的门票、整单及商品订单，不含仅录利润；退票单数为当前存在有效退票的订单数，部分退票与全部退票均计，已撤销的退票不计。'
const countsText = (counts: ReturnType<typeof buildReportCounts>) => `账务记录数 ${counts.accountingRecordCount} · 有效订单数 ${counts.effectiveOrderCount} · 退票单数 ${counts.refundedOrderCount}`

function RecordTable({ records, caption }: { records: TicketRecord[]; caption: string }) {
  const totalProfit = records.reduce((sum, ticket) => sum + getProfit(ticket), 0)
  const counts = buildReportCounts(records)
  return <><div className="report-table-scroll report-record-desktop" role="region" aria-label={caption} tabIndex={0}>
    <table className="report-table report-record-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">日期 / 时间</th><th scope="col">客户姓名</th><th scope="col">项目 / 供货商</th><th scope="col">人数 / 数量</th><th scope="col">利润</th></tr></thead>
      <tbody>{records.map((ticket) => {
        const profit = getProfit(ticket)
        const refund = getRefundState(ticket)
        const people = getEffectivePersonCount(ticket)
        return <tr key={ticket.id}>
          <td>{ticket.issueDate}<small>{ticket.issueTime ? `${ticket.issueTime} 曼谷` : '时间未记录'}</small></td>
          <td className="report-guest-name">{ticket.guestName?.trim() || <span className="muted">未填写</span>}</td>
          <td><strong>{ticket.projectName || '未分类项目'}{ticket.subItemName ? ` · ${ticket.subItemName}` : ''}</strong><small>{ticket.supplierName} · {ticket.entryMode === 'profit_only' ? '仅录利润' : ticket.amountBasis === 'per_person' ? `按${quantityLabels(ticket).label}计价` : '整单总额'}</small>{refund.active.length > 0 && <small>{refund.full ? '已全部退票' : `已退${refund.refundedPeople}${quantityLabels(ticket).unit}`} · 利润回算原出票日期</small>}{ticket.note && <small className="report-record-note">备注：{ticket.note}</small>}</td>
          <td className="report-number">{ticket.entryMode === 'profit_only' || people == null ? '—' : `${formatNumber(people)}${isItemQuantity(ticket) ? ' 件' : ' 人'}`}</td>
          <td className={`report-money ${profit < 0 ? 'loss-value' : 'profit-value'}`}>{formatThb(profit)}</td>
        </tr>
      })}</tbody>
      <tfoot><tr><th scope="row" colSpan={4}>合计 · {countsText(counts)}</th><td className="report-money">{formatThb(totalProfit)}</td></tr></tfoot>
    </table>
  </div><div className="report-record-cards" role="list" aria-label={caption}>
    {records.map((ticket) => {
      const refund = getRefundState(ticket)
      const people = getEffectivePersonCount(ticket)
      const profit = getProfit(ticket)
      return <article className="report-record-card" role="listitem" key={ticket.id}>
        <div className="report-card-date"><span>{ticket.issueDate}</span><span>{ticket.issueTime ? `${ticket.issueTime} 曼谷` : '时间未记录'}</span></div>
        <div className="report-card-heading"><h4>{ticket.guestName?.trim() || <span className="muted">客户姓名未填写</span>}</h4><div><span>利润</span><strong className={profit < 0 ? 'loss-value' : 'profit-value'}>{formatThb(profit)}</strong></div></div>
        <p className="report-card-project">{ticket.projectName || '未分类项目'}{ticket.subItemName ? ` · ${ticket.subItemName}` : ''}</p>
        <dl><div><dt>供货商</dt><dd>{ticket.supplierName}</dd></div><div><dt>{isItemQuantity(ticket) ? '有效数量' : '有效人数'}</dt><dd>{ticket.entryMode === 'profit_only' ? '仅录利润，不计人数／数量' : people == null ? '未填写' : `${formatNumber(people)} ${isItemQuantity(ticket) ? '件' : '人'}`}</dd></div><div><dt>退票状态</dt><dd>{refund.full ? '已全部退票' : refund.active.length ? `部分退票 · 已退${refund.refundedPeople}${quantityLabels(ticket).unit}` : '未退票'}</dd></div></dl>
        {refund.active.length > 0 && <p className="report-card-note">利润回算原出票日期</p>}
        {ticket.note && <p className="report-card-note">备注：{ticket.note}</p>}
      </article>
    })}
    <div className="report-card-total"><span>{countsText(counts)}</span><strong>利润合计 {formatThb(totalProfit)}</strong></div>
  </div></>
}

export function ReportPreview({ report, supplierName, pendingCount = 0, generatedAt }: { report: LedgerReport; supplierName: string; pendingCount?: number; generatedAt: string }) {
  const itemsOnly = report.projectName === '药品' || report.records.length > 0 && report.records.every(isItemQuantity)
  const unnamedCount = [...report.records, ...(report.mode === 'day' ? report.monthlyRecords : [])].filter(ticket => !ticket.guestName?.trim()).length
  return <article className="report-paper" aria-label="格式化报表预览">
    <header className="report-paper-heading">
      <p className="eyebrow">票务盈利簿 · THB · Asia/Bangkok</p>
      <h2>{report.title}</h2>
      <p>{report.mode === 'all' ? '全部已录日期（累计）' : report.start === report.end ? report.start : `${report.start} — ${report.end}`}</p>
      <div className="report-meta"><span>项目：{report.projectName || '全部项目'}</span><span>客户：{report.guestName || '全部客户'}</span><span>供货商：{supplierName}</span><span>预览时间：{generatedAt}（曼谷）</span></div>
    </header>
    {pendingCount > 0 && <p className="report-notice">当前账本有 {pendingCount} 条记录待同步；此预览来自本机当前账本，可能包含尚未上传的修改。</p>}
    <div className="report-totals">
      <div className={report.summary.profitThb < 0 ? 'report-loss' : 'report-profit'}><span>总利润</span><strong>{formatThb(report.summary.profitThb)}</strong></div>
    </div>
    <div className="report-count-metrics" aria-label="报表订单口径"><div><span>账务记录数</span><strong>{report.counts.accountingRecordCount} 条</strong></div><div><span>有效订单数</span><strong>{report.counts.effectiveOrderCount} 单</strong></div><div><span>退票单数</span><strong>{report.counts.refundedOrderCount} 单</strong></div></div>
    <p className="report-note report-count-definition">{countDefinition}{report.mode === 'day' ? '本组数字不含下方另列的月结记录。' : ''}</p>
    {!itemsOnly && <section className="report-quantity" aria-label="项目出票数量查询">
      <h3>项目出票数量查询</h3>
      <div className="report-quantity-metrics"><div><span>有效出票单数</span><strong>{formatNumber(report.quantity.recordCount)} 单</strong></div><div><span>已录人数</span><strong>{formatNumber(report.quantity.peopleCount)} 人</strong></div></div>
      <p className="report-counts">有效数量：{quantityParts(report.effectiveQuantity).join(' · ')}</p>
      <p className="report-note">门票按有效人数计张数，包船、包车及整船／整车／包台／包厢套餐按有效记录计单数，商品按件数，均已扣除退票。上方人数包含整单项目的参与人数，不等于门票张数。数量查询包含月结出票项目，不受每日利润排除规则影响；仅录返佣利润的记录不计出票数量。</p>
      {report.effectiveQuantity.unknownCount > 0 && <p className="report-notice">另有 {report.effectiveQuantity.unknownCount} 笔门票／商品记录未填写数量，以上数量仅为已录部分，不能作为完整总数。</p>}
      {report.quantity.days.length > 0 && <div className="report-table-scroll" role="region" aria-label="每日出票数量" tabIndex={0}><table className="report-table report-quantity-table"><caption>每日出票数量</caption><thead><tr><th scope="col">日期</th><th scope="col">有效出票单数</th><th scope="col">已录人数</th><th scope="col">人数未填</th></tr></thead><tbody>{report.quantity.days.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td className="report-number">{day.recordCount}</td><td className="report-number">{formatNumber(day.peopleCount)}</td><td className="report-number">{day.unknownCount}</td></tr>)}</tbody><tfoot><tr><th scope="row">合计</th><td className="report-number">{report.quantity.recordCount}</td><td className="report-number">{formatNumber(report.quantity.peopleCount)}</td><td className="report-number">{report.quantity.unknownCount}</td></tr></tfoot></table></div>}
    </section>}
    {(itemsOnly || report.itemQuantity.recordCount > 0) && <section className="report-quantity" aria-label="商品数量查询">
      <h3>商品数量查询</h3>
      <div className="report-quantity-metrics"><div><span>有效商品销售单数</span><strong>{formatNumber(report.itemQuantity.recordCount)} 单</strong></div><div><span>已录数量</span><strong>{formatNumber(report.itemQuantity.quantityCount)} 件</strong></div></div>
      <p className="report-note">商品数量与门票人数分开统计，已扣除退回数量，不计作门票。</p>
      {report.itemQuantity.unknownCount > 0 && <p className="report-notice">另有 {report.itemQuantity.unknownCount} 笔商品记录未填写数量。</p>}
      {report.itemQuantity.days.length > 0 && <div className="report-table-scroll" role="region" aria-label="每日商品数量" tabIndex={0}><table className="report-table report-quantity-table"><caption>每日商品数量</caption><thead><tr><th scope="col">日期</th><th scope="col">有效商品销售单数</th><th scope="col">数量（件）</th></tr></thead><tbody>{report.itemQuantity.days.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td className="report-number">{day.recordCount}</td><td className="report-number">{formatNumber(day.quantityCount)}</td></tr>)}</tbody><tfoot><tr><th scope="row">合计</th><td className="report-number">{report.itemQuantity.recordCount}</td><td className="report-number">{formatNumber(report.itemQuantity.quantityCount)}</td></tr></tfoot></table></div>}
    </section>}
    <p className="report-counts">利润合计包含账务记录数 {report.counts.accountingRecordCount} 条{report.mode === 'day' ? '（月结记录在下方另列）' : ''}</p>
    <p className="report-note">{report.mode === 'day' ? '日报合计不含月结项目；当天月结记录在下方另列，计入所属月份的月报。' : report.mode === 'all' ? '累计报表包含全部已录日期内符合项目和供货商条件的有效记录及月结返佣。' : '包含所选日期范围内的全部有效记录及月结返佣。月报按曼谷自然月1日至月底统计。'}利润均为总额，已按各记录的计价方式计算；旧记录不重复乘人数。</p>

    <section className="report-section"><h3>供货商汇总 · 按利润排序</h3>
      {report.supplierStats.length === 0 ? <p className="report-empty">当前范围没有计入本报表的记录。</p> : <><div className="report-table-scroll report-supplier-desktop" role="region" aria-label="供货商汇总" tabIndex={0}>
        <table className="report-table report-supplier-table"><caption>供货商汇总</caption>
          <thead><tr><th scope="col">供货商</th><th scope="col">账务记录数</th><th scope="col">有效订单数</th><th scope="col">退票单数</th><th scope="col">利润</th></tr></thead>
          <tbody>{report.supplierStats.map((supplier) => <tr key={supplier.supplierId}><th scope="row">{supplier.supplierName}</th><td className="report-number">{supplier.accountingRecordCount}</td><td className="report-number">{supplier.effectiveOrderCount}</td><td className="report-number">{supplier.refundedOrderCount}</td><td className={`report-money ${supplier.profitThb < 0 ? 'loss-value' : 'profit-value'}`}>{formatThb(supplier.profitThb)}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">合计</th><td className="report-number">{report.counts.accountingRecordCount}</td><td className="report-number">{report.counts.effectiveOrderCount}</td><td className="report-number">{report.counts.refundedOrderCount}</td><td className="report-money">{formatThb(report.summary.profitThb)}</td></tr></tfoot>
        </table>
      </div><div className="report-supplier-cards" role="list" aria-label="供货商汇总">{report.supplierStats.map((supplier) => <article className="report-supplier-card" role="listitem" key={supplier.supplierId}><div><strong>{supplier.supplierName}</strong><strong className={supplier.profitThb < 0 ? 'loss-value' : 'profit-value'}>{formatThb(supplier.profitThb)}</strong></div><dl><div><dt>账务记录数</dt><dd>{supplier.accountingRecordCount} 条</dd></div><div><dt>有效订单数</dt><dd>{supplier.effectiveOrderCount} 单</dd></div><div><dt>退票单数</dt><dd>{supplier.refundedOrderCount} 单</dd></div></dl></article>)}<div className="report-card-total"><span>{countsText(report.counts)}</span><strong>利润合计 {formatThb(report.summary.profitThb)}</strong></div></div></>}
    </section>
    <section className="report-section"><h3>记录明细</h3>{unnamedCount > 0 && <p className="report-note">有 {unnamedCount} 条记录未填写客户姓名。</p>}{report.records.length > 0 ? <RecordTable records={report.records} caption="报表记录明细" /> : <p className="report-empty">没有符合当前报表条件的记录。</p>}</section>
    {report.mode === 'day' && report.monthlyRecords.length > 0 && <section className="report-section report-monthly-section"><h3>月结项目另列 · 不计入日报合计</h3><p className="report-note">{countsText(report.monthlyCounts)} · 利润 {formatThb(report.monthlySummary.profitThb)}，包含在对应月报中。</p><RecordTable records={report.monthlyRecords} caption="当日月结记录（不计入日报合计）" /></section>}
    <footer className="report-footer">按原出票日期统计，退票回算原日/月 · 已排除删除记录 · 仅录利润项目不计出票数量 · 修改账本后报表自动更新</footer>
  </article>
}

export function ReportView({ tickets, suppliers, projects = [] }: { tickets: TicketRecord[]; suppliers: Supplier[]; projects?: Project[] }) {
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [query, setQuery] = useState<ReportQuery>(() => {
    const month = getBangkokMonth()
    const range = monthDateRange(month)
    return { mode: 'month', month, date: getBangkokDate(), startDate: range.start, endDate: range.end, supplierId: '', projectName: '', guestName: '' }
  })
  const result = useMemo(() => {
    try { return { report: buildReport(tickets, query), error: '' } }
    catch (error) { return { report: null, error: error instanceof Error ? error.message : '报表暂时无法生成。' } }
  }, [tickets, query])
  const update = <K extends keyof ReportQuery>(key: K, value: ReportQuery[K]) => setQuery((current) => ({ ...current, [key]: value }))
  const applyShortcut = (shortcut: ReportShortcut) => setQuery((current) => reportShortcutQuery(current, shortcut))
  const today = getBangkokDate()
  const currentMonth = today.slice(0, 7)
  const lastMonth = reportShortcutQuery(query, 'last-month', today).month
  const generatedAt = `${getBangkokDate()} ${getBangkokTime()}`
  const names = useMemo(() => {
    const included = (name: string) => !isIndependentLedgerProject(name)
    return projectNames([...projects.filter(project => included(project.name)), ...activeTickets(tickets).filter(ticket => included(ticket.projectName)).map(ticket => ({ name: ticket.projectName || '未分类项目', entryMode: ticket.entryMode }))])
  }, [projects, tickets])
  const supplierName = suppliers.find((supplier) => supplier.id === query.supplierId)?.name ?? (query.supplierId ? '所选供货商' : '全部供货商')
  const exportCurrentReport = async () => {
    if (!result.report || exporting) return
    setExporting(true); setExportError('')
    try { await exportReportToXlsx(result.report, supplierName) }
    catch { setExportError('报表导出失败，请重试。') }
    finally { setExporting(false) }
  }

  return <>
    <section className="records-heading report-screen-heading"><div><p className="eyebrow">在线预览 · 不含独立账本</p><h1>格式化报表</h1></div><div className="heading-actions report-export-actions"><button className="secondary-button small" type="button" disabled={!result.report || exporting} onClick={() => void exportCurrentReport()}>{exporting ? '正在导出…' : '导出当前报表 Excel'}</button><button className="secondary-button small" type="button" disabled={!result.report} onClick={() => window.print()}>打印 / 保存 PDF</button></div></section>
    {exportError && <p className="form-error" role="alert">{exportError}</p>}
    <div className="report-quick-periods" role="group" aria-label="快捷报表日期"><button type="button" className="secondary-button small" aria-pressed={query.mode === 'day' && query.date === today} onClick={() => applyShortcut('today')}>今天</button><button type="button" className="secondary-button small" aria-pressed={query.mode === 'month' && query.month === currentMonth} onClick={() => applyShortcut('this-month')}>本月</button><button type="button" className="secondary-button small" aria-pressed={query.mode === 'month' && query.month === lastMonth} onClick={() => applyShortcut('last-month')}>上月</button></div>
    <section className="report-controls" aria-label="报表筛选">
      <label>报表类型<select value={query.mode} onChange={(event) => update('mode', event.target.value as ReportMode)}><option value="day">日报</option><option value="month">月报</option><option value="range">自定义日期范围</option><option value="all">全部日期（累计）</option></select></label>
      {query.mode === 'day' && <label>报表日期<input type="date" value={query.date} onChange={(event) => update('date', event.target.value)} /></label>}
      {query.mode === 'month' && <label>报表月份<input type="month" value={query.month} onChange={(event) => update('month', event.target.value)} /></label>}
      {query.mode === 'range' && <><label>开始日期<input type="date" value={query.startDate} onChange={(event) => update('startDate', event.target.value)} /></label><label>结束日期<input type="date" value={query.endDate} onChange={(event) => update('endDate', event.target.value)} /></label></>}
      <label>查询项目<select value={query.projectName ?? ''} onChange={(event) => update('projectName', event.target.value)}><option value="">全部项目</option>{names.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>报表供货商<select value={query.supplierId} onChange={(event) => update('supplierId', event.target.value)}><option value="">全部供货商</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
      <label>客户姓名<input type="search" value={query.guestName ?? ''} onChange={(event) => update('guestName', event.target.value)} placeholder="输入姓名查询，可输入部分姓名" /></label>
    </section>
    <p className="report-scroll-hint">手机上以卡片展示记录明细；打印时保留完整报表表格。</p>
    {result.error && <p className="form-error report-error" role="alert">{result.error}</p>}
    {result.report && <ReportPreview report={result.report} supplierName={supplierName} pendingCount={tickets.filter((ticket) => !ticket.deletedAt && ticket.syncStatus !== 'synced').length} generatedAt={generatedAt} />}
  </>
}
