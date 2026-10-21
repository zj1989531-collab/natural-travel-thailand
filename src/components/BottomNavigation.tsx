type View = 'dashboard' | 'records' | 'reports' | 'show79'

export function BottomNavigation({ view, onViewChange, onAdd, onRefund }: { view: View; onViewChange: (view: View) => void; onAdd: () => void; onRefund: () => void }) {
  return <nav className="bottom-nav" aria-label="主导航">
    <button className={view === 'dashboard' ? 'active' : ''} onClick={() => onViewChange('dashboard')} type="button"><span>▦</span>概览</button>
    <button className={view === 'records' ? 'active' : ''} onClick={() => onViewChange('records')} type="button"><span>▤</span>记录</button>
    <button className="nav-action nav-add" onClick={onAdd} type="button" aria-label="新增出票记录" title="新增出票记录">＋</button>
    <button className="nav-action nav-refund" onClick={onRefund} type="button" aria-label="退票" title="退票">−</button>
    <button className={view === 'show79' ? 'active' : ''} onClick={() => onViewChange('show79')} type="button"><span>79</span>79秀</button>
    <button className={view === 'reports' ? 'active' : ''} onClick={() => onViewChange('reports')} type="button"><span>▥</span>报表</button>
  </nav>
}
