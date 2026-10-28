import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MonthlyTicketsView } from './MonthlyTicketsView'

describe('月结票二级表单通道', () => {
  it('shows every monthly channel and a clear return to the homepage', () => {
    const html = renderToStaticMarkup(<MonthlyTicketsView onSelect={() => {}} onBack={() => {}} />)
    for (const label of ['返回首页', '月结票', '69秀', '79秀', '泰拳', '格兰岛一日游', '东方嘉年华', '独立账本', '不计入主账本日报、月报、年报及排行']) expect(html).toContain(label)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(5)
    expect(html).not.toContain('id="monthly-ticket-form"')
  })

  it.each(['show69', 'show79', 'boxing', 'kohlarn', 'carnival'] as const)('keeps one selected channel and displays its form for %s', selected => {
    const html = renderToStaticMarkup(<MonthlyTicketsView selected={selected} onSelect={() => {}} onBack={() => {}}><form aria-label={`${selected}现有表单`} /></MonthlyTicketsView>)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toContain('id="monthly-ticket-form"')
    expect(html).toContain(`${selected}现有表单`)
    expect(html).not.toContain('请选择上方')
  })
})
