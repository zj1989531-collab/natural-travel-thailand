import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BottomNavigation } from './BottomNavigation'

describe('bottom add and refund actions', () => {
  it('keeps monthly channels out of the bottom navigation', () => {
    const html = renderToStaticMarkup(<BottomNavigation view="dashboard" onViewChange={() => {}} onAdd={() => {}} onRefund={() => {}} />)
    expect(html.match(/<button/g)).toHaveLength(5)
    expect(html).toContain('aria-label="新增出票记录"')
    expect(html).toContain('aria-label="退票"')
    expect(html).toContain('title="退票">−</button>')
    expect(html).toContain('title="新增出票记录">＋</button>')
    for (const text of ['概览', '记录', '报表']) expect(html).toContain(text)
    for (const text of ['69秀', '79秀', '泰拳', '月结票']) expect(html).not.toContain(text)
  })
  it.each(['dashboard', 'records', 'reports'] as const)('retains one selected tab in %s view', (view) => {
    const html = renderToStaticMarkup(<BottomNavigation view={view} onViewChange={() => {}} onAdd={() => {}} onRefund={() => {}} />)
    expect(html.match(/class="active"/g)).toHaveLength(1)
  })
  it('places add and refund together between the records and reports tabs', () => {
    const html = renderToStaticMarkup(<BottomNavigation view="dashboard" onViewChange={() => {}} onAdd={() => {}} onRefund={() => {}} />)
    expect(html.indexOf('>概览</button>')).toBeLessThan(html.indexOf('>记录</button>'))
    expect(html.indexOf('>记录</button>')).toBeLessThan(html.indexOf('aria-label="新增出票记录"'))
    expect(html.indexOf('aria-label="新增出票记录"')).toBeLessThan(html.indexOf('aria-label="退票"'))
    expect(html.indexOf('aria-label="退票"')).toBeLessThan(html.indexOf('>报表</button>'))
  })
})
