export type SyncStatus = 'synced' | 'pending' | 'error'
export type EntryMode = 'standard' | 'profit_only'
export type AmountBasis = 'total' | 'per_person'
export type QuantityUnit = 'person' | 'item'
export type SettlementMode = 'daily' | 'monthly'

export interface Supplier {
  /** Local-only recoverable duplicate; never uploaded or offered in selectors. */
  mergedIntoId?: string
  id: string
  userId: string
  name: string
  normalizedName: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface Project {
  /** Unbound templates use empty supplierId/name locally and NULL supplier_id in PostgreSQL. */
  defaultAmountBasis?: AmountBasis | null
  settlementMode?: SettlementMode | null
  mergedIntoId?: string
  manualAgentPrice?: boolean
  manualCostPrice?: boolean | null
  manualSupplier?: boolean | null
  quantityUnit?: QuantityUnit
  entryMode?: EntryMode
  id: string
  userId: string
  supplierId: string
  supplierName: string
  name: string
  normalizedName: string
  subItemName: string
  normalizedSubItemName: string
  defaultCostThb: number
  defaultAgentPriceThb: number
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface TicketRecord {
  guestName?: string
  settlementMode?: SettlementMode | null
  quantityUnit?: QuantityUnit
  refunds?: RefundRecord[]
  amountBasis?: AmountBasis
  personCount?: number | null
  entryMode?: EntryMode
  manualProfitThb?: number | null
  issueTime?: string | null
  id: string
  userId: string
  issueDate: string
  supplierId: string
  supplierName: string
  projectId: string | null
  projectName: string
  subItemName: string
  agentPriceThb: number
  costThb: number
  note: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  syncStatus: SyncStatus
}

export interface TicketInput {
  guestName?: string
  settlementMode?: SettlementMode | null
  quantityUnit?: QuantityUnit
  amountBasis?: AmountBasis
  personCount?: number | null
  entryMode?: EntryMode
  manualProfitThb?: number | null
  issueTime?: string | null
  issueDate: string
  supplierName: string
  projectId: string
  projectName: string
  subItemName: string
  agentPriceThb: number
  costThb: number
  note: string
}

export interface RefundRecord {
  id: string
  userId: string
  ticketId: string
  personCount: number | null
  isFull: boolean
  refundRevenueThb: number
  returnedCostThb: number
  refundDate: string
  refundTime: string
  note: string
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface RefundInput {
  operationId: string
  ticketId: string
  personCount: number | null
  isFull: boolean
  refundRevenueThb: number
  returnedCostThb: number
  refundDate: string
  refundTime: string
  note: string
}

export interface Summary {
  count: number
  agentPriceThb: number
  costThb: number
  profitThb: number
}

export interface SupplierSummary extends Summary {
  supplierId: string
  supplierName: string
}

export interface AppSettings {
  localUserId: string
  lastCloudUserId: string | null
}

export interface ProjectInput {
  manualSupplier?: boolean | null
  manualCostPrice?: boolean | null
  defaultAmountBasis?: AmountBasis | null
  settlementMode?: SettlementMode | null
  supplierId: string
  name: string
  subItemName: string
  defaultCostThb: number
  defaultAgentPriceThb: number
  entryMode?: EntryMode
  manualAgentPrice?: boolean
  quantityUnit?: QuantityUnit
}

export interface ProjectPricesInput {
  manualCostPrice?: boolean | null
  defaultAmountBasis?: AmountBasis | null
  settlementMode?: SettlementMode | null
  quantityUnit?: QuantityUnit
  defaultCostThb: number
  defaultAgentPriceThb: number
  manualAgentPrice?: boolean
}
