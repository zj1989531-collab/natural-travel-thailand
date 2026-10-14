import type { TicketRecord } from '../types'
import { formatThb } from '../lib/format'
import { summarise } from '../lib/stats'

export function SummaryPanel({ title, subtitle, tickets, note }: { title: string; subtitle: string; tickets: TicketRecord[]; note?: string }) {
  const summary = summarise(tickets)
  return <section className="summary-panel">
    <div className="section-heading">
      <div><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div>
      <span className="ticket-count">{summary.count} 张</span>
    </div>
    <div className="metrics-grid">
      <div className={`metric-card ${summary.profitThb < 0 ? 'loss' : 'profit'}`}>
        <span>利润</span><strong>{formatThb(summary.profitThb)}</strong>
      </div>
    </div>
    {note && <p className="stats-note">{note}</p>}
  </section>
}
