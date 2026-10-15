import { useEffect, useRef } from 'react'

export function SaveWarning({ messages, onBack, onContinue, saving }: { messages: string[]; onBack: () => void; onContinue: () => void; saving: boolean }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }); ref.current?.focus({ preventScroll: true }) }, [messages])
  return <section ref={ref} tabIndex={-1} className="save-warning" role="alertdialog" aria-label="保存前请核对" aria-describedby="save-warning-copy">
    <h3>保存前请核对</h3>
    <div id="save-warning-copy">{messages.map(message => <p key={message}>{message}</p>)}</div>
    <div className="sheet-actions"><button type="button" className="secondary-button" disabled={saving} onClick={onBack}>返回核对</button><button type="button" className="primary-button" disabled={saving} onClick={onContinue}>{saving ? '保存中…' : '确认仍要保存'}</button></div>
  </section>
}
