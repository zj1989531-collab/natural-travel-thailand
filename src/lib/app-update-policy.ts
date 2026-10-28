export interface AppUpdateSafety {
  syncing: boolean
  hasOpenEditor: boolean
  isIndependentLedger: boolean
}

// A downloaded PWA version can reload automatically only when no visible
// editor can contain unsaved React state. Saved offline records are durable in
// IndexedDB and continue their normal automatic cloud replay after reload.
export const canAutoApplyAppUpdate = ({ syncing, hasOpenEditor, isIndependentLedger }: AppUpdateSafety) =>
  !syncing && !hasOpenEditor && !isIndependentLedger
