const BUILD_VERSION = '__BUILD_VERSION__'
const BUILD_ASSETS = /* BUILD_ASSETS */ []
const CACHE_PREFIX = `ticket-profit-ledger:${self.registration.scope}:`
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`
const APP_SHELL = ['index.html', 'manifest.webmanifest', 'icon.svg', ...BUILD_ASSETS]
  .map((path) => new URL(path, self.registration.scope).href)
const INDEX_URL = new URL('index.html', self.registration.scope).href

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      try {
        const response = await fetch(event.request)
        if (response.ok) await cache.put(INDEX_URL, response.clone())
        return response
      } catch {
        const cached = await cache.match(INDEX_URL)
        return cached || new Response('暂时无法连接，请联网后再打开。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    })())
    return
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(event.request).then((cached) =>
      cached || fetch(event.request).then((response) => {
        if (response.ok) event.waitUntil(cache.put(event.request, response.clone()))
        return response
      })
    ))
  )
})
