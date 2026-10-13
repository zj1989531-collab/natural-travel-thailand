export type SyncStatus = 'synced' | 'pending' | 'error'
export type EntryMode = 'standard' | 'profit_only'

export interface Supplier {
  id: string
  userId: string
  name: string
  normalizedName: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface Project {
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
