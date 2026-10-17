import type { AppSettings, TicketRecord } from '../types'

export type LedgerSettings = AppSettings & { activeCloudUserId?: string | null }

export interface LedgerOwnerContext {
  userId: string
  cloud: boolean
  isCurrent: () => boolean
}

export class AccountChangedError extends Error {
  readonly code = 'ACCOUNT_CHANGED'
  constructor() { super('账号已切换或退出，请重新打开当前账号的账本。'); this.name = 'AccountChangedError' }
}

export function assertLedgerOwner(settings: LedgerSettings | undefined, owner: LedgerOwnerContext, recordUserId = owner.userId) {
  const active = owner.cloud ? settings?.activeCloudUserId : settings?.localUserId
  if (!owner.isCurrent() || active !== owner.userId || recordUserId !== owner.userId) throw new AccountChangedError()
}

export interface TicketCreateOperation {
  id: string
  userId: string
  fingerprint: string
  ticketId: string
  acceptedRecord: TicketRecord
}

export const ticketOperationKey = (userId: string, operationId: string) => JSON.stringify([userId, operationId])
