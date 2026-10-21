import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

test('the fresh Supabase schema includes every cloud-synchronized table', async () => {
  const schema = await read('supabase/schema.sql')
  for (const table of ['suppliers', 'projects', 'tickets', 'ticket_refunds']) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}\\b`))
  }
  assert.match(schema, /alter table public\.ticket_refunds enable row level security/)
  assert.match(schema, /array\['suppliers', 'projects', 'tickets', 'ticket_refunds'\]/)
})

test('the upgrade migration supplies the fields and protections required by the current client', async () => {
  const migration = await read('supabase/migrations/006_complete_current_schema.sql')
  for (const fragment of [
    'add column if not exists quantity_unit',
    'add column if not exists entry_mode',
    'create table if not exists public.ticket_refunds',
    'alter table public.ticket_refunds enable row level security',
    'create trigger ledger_validate_refund',
    'create trigger ledger_protect_refunded_ticket'
  ]) assert.ok(migration.includes(fragment), `Missing migration fragment: ${fragment}`)
})
