import type { ReactNode } from 'react'

export type MonthlyTicketChannel = 'show69' | 'show79' | 'boxing' | 'kohlarn' | 'carnival'

const channels: { id: MonthlyTicketChannel; name: string; description: string }[] = [
  { id: 'show69', name: '69秀', description: '自动带价 · 按人数计算' },
  { id: 'show79', name: '79秀', description: '订单、人数与月度分账' },
  { id: 'boxing', name: '泰拳', description: '亚洲人 / 欧美人 · 自动带价' },
  { id: 'kohlarn', name: '格兰岛一日游', description: '独立账本 · 月结套餐' },
  { id: 'carnival', name: '东方嘉年华', description: '独立账本 · 月结票种' }
]

export function MonthlyTicketsView({ selected, onSelect, onBack, children }: {
  selected?: MonthlyTicketChannel
  onSelect: (channel: MonthlyTicketChannel) => void
  onBack: () => void
  children?: ReactNode
}) {
  return <section className="monthly-tickets-view" aria-labelledby="monthly-tickets-title">
    <button className="text-action monthly-ticket-back" type="button" onClick={onBack}>‹ 返回首页</button>
    <div className="records-heading"><div><p className="eyebrow">月度结算</p><h1 id="monthly-tickets-title">月结票</h1></div></div>
    <p className="sheet-copy">选择项目后填写或查看独立记录；不计入主账本日报、月报、年报及排行。</p>
    <div className="monthly-ticket-channels" role="group" aria-label="月结票表单通道">
      {channels.map(channel => <button key={channel.id} type="button" className={selected === channel.id ? 'selected' : ''} aria-pressed={selected === channel.id} aria-controls={selected === channel.id ? 'monthly-ticket-form' : undefined} onClick={() => onSelect(channel.id)}>
        <strong>{channel.name}</strong><span>{channel.description}</span>
      </button>)}
    </div>
    {selected ? <div id="monthly-ticket-form">{children}</div> : <div className="empty-card">请选择上方的69秀、79秀、泰拳、格兰岛一日游或东方嘉年华。</div>}
  </section>
}
