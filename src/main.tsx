import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const updateReadyEvent = 'ticket-profit-ledger:update-ready'
    const applyUpdateEvent = 'ticket-profit-ledger:apply-update'
    let registration: ServiceWorkerRegistration | undefined
    let refreshForUpdate = false
    let hadController = Boolean(navigator.serviceWorker.controller)
    const announceUpdate = () => {
      // Keep a small document-level marker as well as the event. React may not
      // have attached its listener yet when an already-waiting worker is found.
      document.documentElement.dataset.ticketProfitLedgerUpdateReady = 'true'
      window.dispatchEvent(new Event(updateReadyEvent))
    }
    const watchForUpdate = (nextRegistration: ServiceWorkerRegistration) => {
      registration = nextRegistration
      if (registration.waiting && navigator.serviceWorker.controller) announceUpdate()
      registration.addEventListener('updatefound', () => {
        const installing = registration?.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) announceUpdate()
        })
      })
    }
    window.addEventListener(applyUpdateEvent, () => {
      if (registration?.waiting) {
        refreshForUpdate = true
        registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      } else {
        // Another tab may have activated the worker already. Its retained
        // cache keeps this page safe long enough for the user to save, and
        // this action then reloads into the active version.
        window.location.reload()
      }
    })
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshForUpdate) window.location.reload()
      else if (hadController) announceUpdate()
      hadController = true
    })
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`, { updateViaCache: 'none' })
      .then((registration) => {
        watchForUpdate(registration)
        window.addEventListener('focus', () => { void registration.update().catch(() => undefined) })
      })
      .catch(() => undefined)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
