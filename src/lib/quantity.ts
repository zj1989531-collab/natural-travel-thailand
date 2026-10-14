import type { QuantityUnit } from '../types'

export const quantityLabels = (record: { quantityUnit?: QuantityUnit }) => record.quantityUnit === 'item'
  ? { label: '数量', unit: '件', single: '单件' }
  : { label: '人数', unit: '人', single: '单人' }

export const isItemQuantity = (record: { quantityUnit?: QuantityUnit }) => record.quantityUnit === 'item'
