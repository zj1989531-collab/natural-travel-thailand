import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const script = resolve('scripts/validate-client-config.mjs')
const { VITE_SUPABASE_URL: _url, VITE_SUPABASE_ANON_KEY: _key, ...baseEnv } = process.env

async function runValidation(args = [], variables = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'ticket-ledger-config-'))
  try {
    return spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...baseEnv, ...variables }
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('local builds may intentionally omit Supabase configuration', async () => {
  const result = await runValidation()
  assert.equal(result.status, 0, result.stderr)
})

test('production builds reject missing cloud configuration', async () => {
  const result = await runValidation(['--require-supabase'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /生产发布必须配置/)
})

test('production builds reject a partial cloud configuration', async () => {
  const result = await runValidation(['--require-supabase'], {
    VITE_SUPABASE_URL: 'https://example.supabase.co'
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /请同时配置/)
})

test('production builds accept a complete public configuration', async () => {
  const result = await runValidation(['--require-supabase'], {
    VITE_SUPABASE_URL: 'https://example.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'sb_publishable_test'
  })
  assert.equal(result.status, 0, result.stderr)
})
