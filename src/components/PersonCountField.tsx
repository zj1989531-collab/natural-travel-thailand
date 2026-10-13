import { useState } from 'react'
import { MAX_PERSON_COUNT } from '../lib/format'

const COMMON_COUNTS = Array.from({ length: 50 }, (_, index) => index + 1)

export function PersonCountField({ value, allowUnknown = false, multiplyAmounts = true, onChange }: {
  value: number | null | undefined
  allowUnknown?: boolean
  multiplyAmounts?: boolean
  onChange: (value: number | null) => void
}) {
  const [custom, setCustom] = useState(() => value != null && !COMMON_COUNTS.includes(value))

  return <div className="person-count-field">
    <label htmlFor="person-count">人数</label>
    <select id="person-count" aria-describedby="person-count-help" value={custom ? 'custom' : value ?? ''} required={!allowUnknown} onChange={(event) => {
      const selected = event.target.value
      setCustom(selected === 'custom')
      onChange(selected === 'custom' || selected === '' ? null : Number(selected))
    }}>
      <option value="" disabled={!allowUnknown}>{allowUnknown ? '未记录（可补填）' : '请选择人数'}</option>
      {COMMON_COUNTS.map((count) => <option key={count} value={count}>{count} 人</option>)}
      <option value="custom">其他人数（手动填写）</option>
    </select>
    {custom && <label>
      自定义人数
      <input inputMode="numeric" type="number" min="1" max={MAX_PERSON_COUNT} step="1" value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} required />
    </label>}
    <span className="muted" id="person-count-help">{multiplyAmounts ? '单人金额 × 人数，自动计算总售价、总成本和总利润。' : '整单总额模式：人数仅作记录，不再乘入金额。'}</span>
  </div>
}
