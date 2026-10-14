import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DashboardLogo } from './DashboardLogo'

describe('dashboard company logo', () => {
  it('replaces the old slogan with the supplied image and an accessible company name', () => {
    const html = renderToStaticMarkup(<DashboardLogo />)
    expect(html).toContain('<h1 class="welcome-logo">')
    expect(html).toContain('<img')
    expect(html).toContain('natural-travel-thailand-logo.jpg')
    expect(html).toContain('alt="NATURAL TRAVEL THAILAND · 泰国自然旅游公司"')
    expect(html).not.toContain('今天的盈利')
    expect(html).not.toContain('一眼掌握')
  })
})
