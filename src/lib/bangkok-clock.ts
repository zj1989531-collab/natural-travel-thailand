import { useEffect, useState } from 'react'
import { getBangkokDate } from './format'

// Independent of cloud/network events: offline pages also cross Bangkok midnight.
export function watchBangkokDate(onDate: (date: string) => void, now = () => new Date()) {
  const refresh = () => onDate(getBangkokDate(now()))
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  const timer = window.setInterval(refresh, 30000)
  window.addEventListener('focus', refresh)
  window.addEventListener('pageshow', refresh)
  document.addEventListener('visibilitychange', visible)
  refresh()
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('focus', refresh)
    window.removeEventListener('pageshow', refresh)
    document.removeEventListener('visibilitychange', visible)
  }
}

export function useBangkokDate() {
  const [today, setToday] = useState(() => getBangkokDate())
  useEffect(() => watchBangkokDate(setToday), [])
  return today
}
