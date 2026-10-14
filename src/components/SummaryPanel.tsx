import type { TicketRecord } from '../types'
import { formatThb } from '../lib/format'
import { summarise } from '../lib/stats'
import { quantityParts, summariseQuantities } from '../lib/effective-quantities'

export function SummaryPanel({ title, subtitle, tickets, note }: { title: string; subtitle: string; tickets: TicketRecord[]; note?: string }) {
  const summary = summarise(tickets)
  return <section className="summary-panel">
    <div className="section-heading">
      <div><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div>
      <div className="quantity-count" aria-label="有效数量（已扣除退票）">{quantityParts(summariseQuantities(tickets)).map(part => <span className="ticket-count" key={part}>{part}</span>)}</div>
    </div>
    <div className="metrics-grid">
      <div className={`metric-card ${summary.profitThb < 0 ? 'loss' : 'profit'}`}>
        <span>利润</span><strong>{formatThb(summary.profitThb)}</strong>
      </div>
    </div>
    {note && <p className="stats-note">{note}</p>}
  </section>
}
