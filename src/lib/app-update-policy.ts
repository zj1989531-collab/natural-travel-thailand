export interface AppUpdateSafety {
  syncing: boolean
}

// Saved offline records are durable in IndexedDB and continue their normal
// automatic cloud replay after reload. Draft-only form state is intentionally
// disposable, but an in-flight cloud sync must finish before reloading.
export const canAutoApplyAppUpdate = ({ syncing }: AppUpdateSafety) => !syncing
