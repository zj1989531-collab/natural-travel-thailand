import type { ReactNode } from 'react'

export type MonthlyTicketChannel = 'show69' | 'show79' | 'boxing'

const channels: { id: MonthlyTicketChannel; name: string; description: string }[] = [
  { id: 'show69', name: '69秀', description: '日期、所有人姓名、人数' },
  { id: 'show79', name: '79秀', description: '订单、人数与月度分账' },
  { id: 'boxing', name: '泰拳', description: '日期、所有人姓名、人数' }
]

export function MonthlyTicketsView({ selected, onSelect, onBack, children }: {
  selected?: MonthlyTicketChannel
  onSelect: (channel: MonthlyTicketChannel) => void
  onBack: () => void
  children?: ReactNode
}) {
  return <section className="monthly-tickets-view" aria-labelledby="monthly-tickets-title">
    <button className="text-action monthly-ticket-back" type="button" onClick={onBack}>‹ 返回首页</button>
    <div className="records-heading"><div><p className="eyebrow">独立记录</p><h1 id="monthly-tickets-title">月结票</h1></div></div>
    <p className="sheet-copy">选择项目后填写或查看记录，不计入每日统计。</p>
    <div className="monthly-ticket-channels" role="group" aria-label="月结票表单通道">
      {channels.map(channel => <button key={channel.id} type="button" className={selected === channel.id ? 'selected' : ''} aria-pressed={selected === channel.id} aria-controls={selected === channel.id ? 'monthly-ticket-form' : undefined} onClick={() => onSelect(channel.id)}>
        <strong>{channel.name}</strong><span>{channel.description}</span>
      </button>)}
    </div>
    {selected ? <div id="monthly-ticket-form">{children}</div> : <div className="empty-card">请选择上方的69秀、79秀或泰拳通道。</div>}
  </section>
}
