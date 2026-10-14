import { useState } from 'react'
import { MAX_PERSON_COUNT } from '../lib/format'
import type { QuantityUnit } from '../types'
import { quantityLabels } from '../lib/quantity'

const COMMON_COUNTS = Array.from({ length: 50 }, (_, index) => index + 1)

export function PersonCountField({ value, allowUnknown = false, multiplyAmounts = true, quantityUnit = 'person', onChange }: {
  quantityUnit?: QuantityUnit
  value: number | null | undefined
  allowUnknown?: boolean
  multiplyAmounts?: boolean
  onChange: (value: number | null) => void
}) {
  const [custom, setCustom] = useState(() => value != null && !COMMON_COUNTS.includes(value))
  const { label, unit, single } = quantityLabels({ quantityUnit })

  return <div className="person-count-field">
    <label htmlFor="person-count">{label}</label>
    <select id="person-count" aria-describedby="person-count-help" value={custom ? 'custom' : value ?? ''} required={!allowUnknown} onChange={(event) => {
      const selected = event.target.value
      setCustom(selected === 'custom')
      onChange(selected === 'custom' || selected === '' ? null : Number(selected))
    }}>
      <option value="" disabled={!allowUnknown}>{allowUnknown ? '未记录（可补填）' : `请选择${label}`}</option>
      {COMMON_COUNTS.map((count) => <option key={count} value={count}>{count} {unit}</option>)}
      <option value="custom">其他{label}（手动填写）</option>
    </select>
    {custom && <label>
      自定义{label}
      <input inputMode="numeric" type="number" min="1" max={MAX_PERSON_COUNT} step="1" value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} required />
    </label>}
    <span className="muted" id="person-count-help">{multiplyAmounts ? `${single}金额 × ${label}，自动计算总售价、总成本和总利润。` : `整单总额模式：${label}仅作记录，不再乘入金额。`}</span>
  </div>
}
