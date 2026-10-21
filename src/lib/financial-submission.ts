import type { RefundInput } from '../types'
import type { Show79SettlementInput } from './show79-settlement'

export interface FinancialInputs { refund: RefundInput; settlement: Show79SettlementInput }
export type FinancialKind = keyof FinancialInputs
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (owner: string, kind: FinancialKind) => `ticket-ledger:pending-financial:${JSON.stringify([owner, kind])}`

export function readFinancialSubmission<K extends FinancialKind>(storage: StorageAccess, owner: string, kind: K): FinancialInputs[K] | null {
  if (!owner) return null
  const raw = storage.getItem(storageKey(owner, kind))
  if (!raw) return null
  const entry = JSON.parse(raw)
  if (entry.owner !== owner || entry.kind !== kind || !entry.input || typeof entry.input.operationId !== 'string') throw new Error('本次提交资料无法读取，请先核对账本，避免重复登记。')
  return entry.input
}

export function stageFinancialSubmission<K extends FinancialKind>(storage: StorageAccess, owner: string, kind: K, input: FinancialInputs[K]): FinancialInputs[K] {
  if (!owner) throw new Error('请先登录并打开当前账号账本。')
  const pending = readFinancialSubmission(storage, owner, kind)
  if (pending) {
    if (JSON.stringify(pending) !== JSON.stringify(input)) throw new Error('还有一笔登记结果待核对，请先核对原笔。')
    return pending
  }
  storage.setItem(storageKey(owner, kind), JSON.stringify({ owner, kind, input }))
  return structuredClone(input)
}

export function clearFinancialSubmission(storage: StorageAccess, owner: string, kind: FinancialKind, operationId: string) {
  if (readFinancialSubmission(storage, owner, kind)?.operationId === operationId) storage.removeItem(storageKey(owner, kind))
}
