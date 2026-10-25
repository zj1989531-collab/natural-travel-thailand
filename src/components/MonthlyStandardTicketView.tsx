export function MonthlyStandardTicketView({ title, description, packageCount, onAdd, onManageProjects }: {
  title: string
  description: string
  packageCount: number
  onAdd: () => void
  onManageProjects: () => void
}) {
  return <section className="monthly-standard-channel" aria-label={`${title}月结记录`}>
    <div className="records-heading"><div><p className="eyebrow">主账本 · 月结</p><h2>{title}</h2></div><button type="button" className="primary-button small" onClick={onAdd}>＋ 新增</button></div>
    <p className="sheet-copy">{description}。从这里录入会保存到主账本，计入月报和年报，不计入每日概览。</p>
    <div className="monthly-standard-summary"><strong>{packageCount} 个可用套餐</strong><button type="button" className="text-action" onClick={onManageProjects}>管理价格表</button></div>
    {packageCount === 0 && <div className="empty-card">还没有可用套餐。<button type="button" onClick={onManageProjects}>去维护价格表</button></div>}
  </section>
}
