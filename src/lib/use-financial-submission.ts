import { useEffect, useState } from 'react'
import { clearFinancialSubmission, readFinancialSubmission, stageFinancialSubmission, type FinancialInputs, type FinancialKind } from './financial-submission'

// Retain only an actually submitted financial request, never an editable draft.
// Account-specific storage keeps its exact ID and payload across navigation and reload.
export function useFinancialSubmission<K extends FinancialKind>(owner: string, kind: K) {
  const scope = JSON.stringify([owner, kind])
  const read = () => {
    try { return { pending: typeof window === 'undefined' ? null : readFinancialSubmission(window.localStorage, owner, kind), error: '' } }
    catch { return { pending: null, error: '无法读取待核对的登记，请先检查浏览器储存权限并重新打开，暂不创建新登记。' } }
  }
  const [stored, setStored] = useState(() => ({ scope, ...read() }))
  const current = stored.scope === scope ? stored : { scope, ...read() }
  useEffect(() => { if (stored.scope !== scope) setStored({ scope, ...read() }) }, [scope, stored.scope])
  useEffect(() => {
    if (!current.pending) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [current.pending])
  return {
    ...current,
    stage(input: FinancialInputs[K]) {
      if (current.error) throw new Error(current.error)
      const accepted = stageFinancialSubmission(window.localStorage, owner, kind, input)
      setStored({ scope, pending: accepted, error: '' })
      return accepted
    },
    clear(operationId: string) {
      clearFinancialSubmission(window.localStorage, owner, kind, operationId)
      setStored({ scope, pending: null, error: '' })
    }
  }
}
