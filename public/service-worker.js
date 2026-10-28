const BUILD_VERSION = '__BUILD_VERSION__'
const BUILD_ASSETS = /* BUILD_ASSETS */ []
const CACHE_PREFIX = `ticket-profit-ledger:${self.registration.scope}:`
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`
const CACHE_METADATA_NAME = `${CACHE_PREFIX}metadata`
const CACHE_METADATA_URL = new URL('__cache_versions__', self.registration.scope).href
const MAX_VERSION_CACHES = 3
const APP_SHELL = ['index.html', 'manifest.webmanifest', 'icon.svg', ...BUILD_ASSETS]
  .map((path) => new URL(path, self.registration.scope).href)
const INDEX_URL = new URL('index.html', self.registration.scope).href

const isVersionCache = (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_METADATA_NAME

async function retainedCacheNames() {
  const metadata = await caches.open(CACHE_METADATA_NAME)
  const stored = await metadata.match(CACHE_METADATA_URL)
  const known = stored ? (await stored.text()).split('\n').filter(isVersionCache) : []
  const available = (await caches.keys()).filter(isVersionCache)
  return [...new Set([CACHE_NAME, ...known, ...available])].slice(0, MAX_VERSION_CACHES)
}

async function matchRetainedCache(request) {
  const current = await (await caches.open(CACHE_NAME)).match(request)
  if (current) return current
  for (const name of await retainedCacheNames()) {
    if (name === CACHE_NAME) continue
    const match = await (await caches.open(name)).match(request)
    if (match) return match
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // A user can approve an update in one tab while another tab is still
    // running the old bundle. Retain a small cache window and serve its hashed
    // chunks as a fallback until that tab has saved and refreshed.
    const retained = await retainedCacheNames()
    const metadata = await caches.open(CACHE_METADATA_NAME)
    await metadata.put(CACHE_METADATA_URL, new Response(retained.join('\n')))
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => isVersionCache(key) && !retained.includes(key)).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

// Do not replace the active worker automatically. An already-open page may
// still need a code-split asset from its own build. The page asks us to take
// over only after the user explicitly chooses to refresh for the update.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
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
        const cached = await cache.match(INDEX_URL) || await matchRetainedCache(INDEX_URL)
        return cached || new Response('暂时无法连接，请联网后再打开。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cached = await matchRetainedCache(event.request)
    if (cached) return cached
    const response = await fetch(event.request)
    if (response.ok) event.waitUntil((await caches.open(CACHE_NAME)).put(event.request, response.clone()))
    return response
  })())
})
