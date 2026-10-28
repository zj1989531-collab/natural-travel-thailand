type View = 'dashboard' | 'records' | 'monthly' | 'reports'

export function BottomNavigation({ view, onViewChange, onAdd, onRefund }: { view: View; onViewChange: (view: View) => void; onAdd: () => void; onRefund: () => void }) {
  return <nav className="bottom-nav" aria-label="主导航">
    <button className={view === 'dashboard' ? 'active' : ''} aria-current={view === 'dashboard' ? 'page' : undefined} onClick={() => onViewChange('dashboard')} type="button"><span aria-hidden="true">▦</span>概览</button>
    <button className={view === 'records' ? 'active' : ''} aria-current={view === 'records' ? 'page' : undefined} onClick={() => onViewChange('records')} type="button"><span aria-hidden="true">▤</span>记录</button>
    <button className="nav-action nav-add" onClick={onAdd} type="button" aria-label="新增出票记录" title="新增出票记录">＋</button>
    <button className="nav-action nav-refund" onClick={onRefund} type="button" aria-label="退票" title="退票">−</button>
    <button className={view === 'monthly' ? 'active' : ''} aria-current={view === 'monthly' ? 'page' : undefined} onClick={() => onViewChange('monthly')} type="button"><span aria-hidden="true">票</span>月结票</button>
    <button className={view === 'reports' ? 'active' : ''} aria-current={view === 'reports' ? 'page' : undefined} onClick={() => onViewChange('reports')} type="button"><span aria-hidden="true">▥</span>报表</button>
  </nav>
}
