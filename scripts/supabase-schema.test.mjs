import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

test('the documented fresh Supabase setup contains every cloud-synchronized table and guard', async () => {
  const [schema, refunds, projectRules, show79, manualProjectCost] = await Promise.all([
    read('supabase/schema.sql'),
    read('supabase/refunds.sql'),
    read('supabase/project-rules.sql'),
    read('supabase/show79.sql'),
    read('supabase/manual-project-cost.sql')
  ])

  for (const table of ['suppliers', 'projects', 'tickets']) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}\\b`))
  }
  assert.match(schema, /Also execute refunds\.sql, project-rules\.sql, show79\.sql, manual-project-cost\.sql\./)
  assert.match(refunds, /create table public\.ticket_refunds/)
  assert.match(refunds, /alter table public\.ticket_refunds enable row level security/)
  assert.match(refunds, /create trigger ledger_validate_refund/)
  assert.match(refunds, /create trigger ledger_protect_refunded_ticket/)
  assert.match(refunds, /alter publication supabase_realtime add table public\.ticket_refunds/)
  assert.match(projectRules, /add column if not exists settlement_mode/)
  assert.match(show79, /add column if not exists guest_name/)
  assert.match(manualProjectCost, /add column if not exists manual_cost_price/)
})
