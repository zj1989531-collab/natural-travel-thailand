import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MonthlyStandardTicketView } from './MonthlyStandardTicketView'

describe('主账本月结入口', () => {
  it('describes the main-ledger monthly flow and exposes entry actions', () => {
    const html = renderToStaticMarkup(<MonthlyStandardTicketView title="格兰岛一日游" description="按人自动带价" packageCount={8} onAdd={() => {}} onManageProjects={() => {}} />)
    for (const text of ['格兰岛一日游', '主账本 · 月结', '＋ 新增', '8 个可用套餐', '管理价格表', '不计入每日概览']) expect(html).toContain(text)
  })
})
