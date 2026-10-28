import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function worker({ offline = false } = {}) {
  const handlers = {}
  const scope = 'https://example.github.io/natural-travel-thailand/'
  const stores = new Map()
  let skipWaitingCalls = 0
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)
      return {
        async addAll(urls) { urls.forEach((url) => store.set(url, new Response('offline page'))) },
        async match(request) { return store.get(typeof request === 'string' ? request : request.url)?.clone() },
        async put(request, response) { store.set(typeof request === 'string' ? request : request.url, response) }
      }
    },
    async keys() { return [...stores.keys()] },
    async delete(key) { return stores.delete(key) }
  }
  const self = {
    registration: { scope }, location: { origin: new URL(scope).origin },
    addEventListener(name, handler) { handlers[name] = handler },
    skipWaiting() { skipWaitingCalls++ }, clients: { claim() {} }
  }
  runInNewContext(readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8'), {
    self, caches, URL, Response,
    async fetch() { if (offline) throw new Error('offline'); return new Response('new page') }
  })
  async function dispatch(name, value = {}) {
    const waits = []
    let response
    const event = name === 'fetch' ? { request: value } : value
    handlers[name]({ ...event, waitUntil(promise) { waits.push(promise) }, respondWith(promise) { response = promise } })
    await Promise.all(waits)
    return response
  }
  return { scope, stores, caches, dispatch, get skipWaitingCalls() { return skipWaitingCalls } }
}

test('offline shell stays under the repository path and works without network', async () => {
  const app = worker({ offline: true })
  await app.dispatch('install')
  const cache = [...app.stores.values()][0]
  assert.equal(cache.size, 3)
  assert.ok([...cache.keys()].every((url) => url.startsWith(app.scope)))
  const response = await app.dispatch('fetch', { method: 'GET', mode: 'navigate', url: app.scope })
  assert.equal(await response.text(), 'offline page')
})

test('online navigation gets the latest page rather than permanent cached HTML', async () => {
  const app = worker()
  await app.dispatch('install')
  const response = await app.dispatch('fetch', { method: 'GET', mode: 'navigate', url: app.scope })
  assert.equal(await response.text(), 'new page')
  assert.equal(await [...app.stores.values()][0].get(`${app.scope}index.html`).clone().text(), 'new page')
})

test('activation keeps a small prior-cache window without touching other apps', async () => {
  const app = worker()
  await app.caches.open('another-app')
  await app.caches.open(`ticket-profit-ledger:${app.scope}:old`)
  await app.dispatch('install')
  await app.dispatch('activate')
  assert.ok(app.stores.has('another-app'))
  assert.ok(app.stores.has(`ticket-profit-ledger:${app.scope}:old`))
  assert.ok(app.stores.has(`ticket-profit-ledger:${app.scope}:metadata`))
})

test('an update keeps the old cache until the page explicitly requests activation', async () => {
  const app = worker()
  const oldCache = `ticket-profit-ledger:${app.scope}:old`
  await app.caches.open(oldCache)
  await app.dispatch('install')
  assert.equal(app.skipWaitingCalls, 0)
  assert.ok(app.stores.has(oldCache))

  await app.dispatch('message', { data: { type: 'SKIP_WAITING' } })
  assert.equal(app.skipWaitingCalls, 1)
  assert.ok(app.stores.has(oldCache))

  await app.dispatch('activate')
  assert.ok(app.stores.has(oldCache))
})

test('a second tab can load its old dynamic chunk after another tab activates an update', async () => {
  const app = worker()
  const oldCache = `ticket-profit-ledger:${app.scope}:old`
  const oldChunk = `${app.scope}assets/xlsx-old.js`
  const cache = await app.caches.open(oldCache)
  await cache.put(oldChunk, new Response('old dynamic chunk'))
  await app.dispatch('install')
  await app.dispatch('activate')

  const response = await app.dispatch('fetch', { method: 'GET', url: oldChunk })
  assert.equal(await response.text(), 'old dynamic chunk')
})

test('cache retention is bounded after repeated releases', async () => {
  const app = worker()
  const names = ['old-a', 'old-b', 'old-c'].map((suffix) => `ticket-profit-ledger:${app.scope}:${suffix}`)
  for (const name of names) await app.caches.open(name)
  const metadata = await app.caches.open(`ticket-profit-ledger:${app.scope}:metadata`)
  await metadata.put(`${app.scope}__cache_versions__`, new Response(names.join('\n')))
  await app.dispatch('install')
  await app.dispatch('activate')

  assert.ok(app.stores.has(names[0]))
  assert.ok(app.stores.has(names[1]))
  assert.equal(app.stores.has(names[2]), false)
})
