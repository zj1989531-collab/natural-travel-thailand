import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PersonCountField } from './PersonCountField'

const render = (value: number | null, allowUnknown = false) => renderToStaticMarkup(<PersonCountField value={value} allowUnknown={allowUnknown} onChange={() => {}} />)

describe('person count dropdown', () => {
  it('offers 1 to 50 people and a custom option, with 1 selected for new records', () => {
    const html = render(1)
    expect(html).toContain('<select')
    expect(html).toContain('<option value="1" selected="">1 人</option>')
    expect(html).toContain('<option value="50">50 人</option>')
    expect(html).toContain('其他人数（手动填写）')
    expect(html).not.toContain('<input')
    expect(html.match(/\d+ 人<\/option>/g)).toHaveLength(50)
  })

  it('preserves a saved common selection', () => {
    expect(render(8)).toContain('<option value="8" selected="">8 人</option>')
  })

  it('preserves larger saved groups without capping them to the menu range', () => {
    const html = render(120)
    expect(html).toContain('<option value="custom" selected="">')
    expect(html).toContain('value="120"')
    expect(html).toContain('自定义人数')
  })

  it('keeps unknown historical headcount blank and optional', () => {
    const html = render(null, true)
    expect(html).toContain('<option value="" selected="">未记录（可补填）</option>')
    expect(html).not.toContain('required')
  })
})
