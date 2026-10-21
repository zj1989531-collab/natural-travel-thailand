import { useEffect, useRef } from 'react'

type DialogEntry = { element: HTMLElement; close: () => void; previous: HTMLElement | null }
const stack: DialogEntry[] = []
const hidden = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>()
let unlock: (() => void) | undefined
const focusable = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter(node => node.getClientRects().length && !node.closest('[inert]'))
const focusInside = (entry: DialogEntry) => (focusable(entry.element)[0] ?? entry.element).focus({ preventScroll: true })

function isolateTopDialog() {
  for (const [element, previous] of hidden) {
    element.inert = previous.inert
    if (previous.ariaHidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', previous.ariaHidden)
  }
  hidden.clear()
  const top = stack.at(-1)
  if (top) focusInside(top)
  let current: HTMLElement | null = stack.at(-1)?.element ?? null
  while (current?.parentElement) {
    for (const sibling of current.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === current || sibling.tagName === 'SCRIPT') continue
      hidden.set(sibling, { inert: sibling.inert, ariaHidden: sibling.getAttribute('aria-hidden') })
      sibling.inert = true; sibling.setAttribute('aria-hidden', 'true')
    }
    current = current.parentElement
    if (current === document.body) break
  }
}

export function useDialog(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const entry: DialogEntry = { element, close: () => close.current(), previous: document.activeElement instanceof HTMLElement ? document.activeElement : null }
    if (!stack.length) {
      const x = window.scrollX, y = window.scrollY
      const previous = { position: document.body.style.position, top: document.body.style.top, left: document.body.style.left, width: document.body.style.width, overflow: document.body.style.overflow }
      Object.assign(document.body.style, { position: 'fixed', top: `${-y}px`, left: `${-x}px`, width: '100%', overflow: 'hidden' })
      unlock = () => { Object.assign(document.body.style, previous); window.scrollTo(x, y) }
    }
    stack.push(entry)
    isolateTopDialog()
    const keydown = (event: KeyboardEvent) => {
      if (stack.at(-1) !== entry) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); entry.close(); return }
      if (event.key !== 'Tab') return
      const items = focusable(element), first = items[0], last = items.at(-1)
      if (!first || !last) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    const focusin = (event: FocusEvent) => { if (stack.at(-1) === entry && !element.contains(event.target as Node)) focusInside(entry) }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      stack.splice(stack.indexOf(entry), 1)
      isolateTopDialog()
      if (!stack.length) { unlock?.(); unlock = undefined }
      const top = stack.at(-1)
      if (top) focusInside(top)
      else if (entry.previous?.isConnected) entry.previous.focus({ preventScroll: true })
    }
  }, [])
  return ref
}
