import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')
const migrationFiles = async () => (await readdir(new URL('supabase/migrations/', root)))
  .filter((file) => file.endsWith('.sql')).sort()
const hardeningMigrationFile = async () => {
  const file = (await migrationFiles()).find((name) => /_harden_ledger_integrity\.sql$/.test(name))
  assert.ok(file, 'the post-baseline integrity hardening migration must be present')
  return file
}

test('the documented fresh Supabase setup contains every cloud-synchronized table and guard', async () => {
  const hardeningFile = await hardeningMigrationFile()
  const [schema, refunds, projectRules, show79, show79Settlements, manualProjectCost, hardeningMigration] = await Promise.all([
    read('supabase/schema.sql'),
    read('supabase/refunds.sql'),
    read('supabase/project-rules.sql'),
    read('supabase/show79.sql'),
    read('supabase/show79-settlements.sql'),
    read('supabase/manual-project-cost.sql'),
    read(`supabase/migrations/${hardeningFile}`)
  ])

  for (const table of ['suppliers', 'projects', 'tickets']) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}\\b`))
  }
  assert.match(schema, /Also execute refunds\.sql, project-rules\.sql, show79\.sql, show79-settlements\.sql, manual-project-cost\.sql\./)
  assert.match(refunds, /create table public\.ticket_refunds/)
  assert.match(refunds, /alter table public\.ticket_refunds enable row level security/)
  assert.match(refunds, /create trigger ledger_validate_refund/)
  assert.match(refunds, /create trigger ledger_protect_refunded_ticket/)
  assert.match(refunds, /alter publication supabase_realtime add table public\.ticket_refunds/)
  assert.match(projectRules, /add column if not exists settlement_mode/)
  assert.match(show79, /add column if not exists guest_name/)
  assert.match(show79Settlements, /create table if not exists public\.show79_settlements/)
  assert.match(show79Settlements, /alter table public\.show79_settlements enable row level security/)
  assert.match(show79Settlements, /Users read only their 79 settlements/)
  assert.match(show79Settlements, /Users insert only their 79 settlements/)
  assert.match(show79Settlements, /create trigger ledger_validate_show79_settlement/)
  assert.match(show79Settlements, /create or replace function public\.record_show79_settlement\(/)
  assert.match(show79Settlements, /grant execute on function public\.record_show79_settlement\(uuid, text, date, numeric, numeric, text, numeric, numeric, numeric\)/)
  assert.match(manualProjectCost, /add column if not exists manual_cost_price/)

  for (const constraint of [
    'tickets_agent_price_thb_valid',
    'tickets_cost_thb_valid',
    'tickets_manual_profit_thb_valid',
    'projects_default_cost_thb_valid',
    'projects_default_agent_price_thb_valid'
  ]) {
    assert.match(schema, new RegExp(`constraint ${constraint} check`))
  }
  assert.match(schema, /not in \('NaN', 'Infinity', '-Infinity'\)/)
  assert.match(schema, /<= 999999999999\.99/)
  assert.match(refunds, /constraint ticket_refunds_refund_revenue_thb_valid check/)
  assert.match(refunds, /constraint ticket_refunds_returned_cost_thb_valid check/)
  assert.match(refunds, /not in \('NaN', 'Infinity', '-Infinity'\)/)
  assert.match(refunds, /<= 999999999999\.99/)

  assert.match(schema, /constraint suppliers_id_user_id_key unique \(id, user_id\)/)
  assert.match(schema, /constraint tickets_supplier_owner_fkey foreign key \(supplier_id, user_id\) references public\.suppliers\(id, user_id\)/)
  assert.match(schema, /constraint projects_supplier_owner_fkey foreign key \(supplier_id, user_id\) references public\.suppliers\(id, user_id\)/)
  assert.match(schema, /create index if not exists tickets_supplier_owner_idx on public\.tickets \(supplier_id, user_id\)/)
  assert.match(schema, /create index if not exists projects_supplier_owner_idx on public\.projects \(supplier_id, user_id\)/)
  assert.match(schema, /revoke all privileges on table public\.suppliers, public\.projects, public\.tickets from public, anon, authenticated/)
  assert.match(refunds, /revoke all privileges on public\.ticket_refunds from public, anon, authenticated/)

  assert.match(hardeningMigration, /存在归属错误的项目供货商引用/)
  assert.match(hardeningMigration, /tickets_supplier_owner_fkey/)
  assert.match(hardeningMigration, /projects_supplier_owner_idx/)
  assert.match(hardeningMigration, /revoke all privileges on table public\.suppliers, public\.projects, public\.tickets from public, anon, authenticated/)
})

const productionHistory = [
  '20261013093949_initialize_ticket_ledger.sql',
  '20261013094443_restrict_internal_rls_trigger.sql',
  '20261013133848_profit_only_entries_and_bangkok_issue_time.sql',
  '20261013152221_ticket_person_count.sql',
  '20261013161030_ticket_amount_basis.sql',
  '20261013182931_ticket_refunds_original_period.sql',
  '20261013183619_idempotent_refund_cancellation.sql',
  '20261014104440_project_manual_prices_and_item_quantities.sql',
  '20261015070422_project_default_rules_and_ticket_settlement_snapshots.sql',
  '20261015071407_verify_rule_compatibility_on_temporary_tables.sql',
  '20261016051624_show79_monthly_settlement_journal.sql',
  '20261016074210_fix_actual_refund_date_and_settlement_account_guard.sql',
  '20261017142845_add_manual_project_prices_and_supplier_choice.sql',
  '20261023123233_canonical_supplier_brand.sql'
]

test('timestamped migrations provide a deterministic fresh baseline without rewriting production history', async () => {
  const files = await migrationFiles()

  assert.deepEqual(files.slice(0, productionHistory.length), productionHistory)
  for (const file of files) {
    assert.match(file, /^\d{14}_[a-z0-9_]+\.sql$/)
  }
  const hardeningFile = await hardeningMigrationFile()
  assert.ok(hardeningFile > productionHistory.at(-1), 'hardening must follow every historical production marker')
  assert.ok(!files.some((file) => /^(002|003|004|005)_/.test(file)))

  const baseline = await read('supabase/migrations/20261013093949_initialize_ticket_ledger.sql')
  for (const table of ['suppliers', 'projects', 'tickets', 'ticket_refunds', 'show79_settlements']) {
    assert.match(baseline, new RegExp(`create table if not exists public\\.${table}\\b`))
    assert.match(baseline, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  for (const functionName of [
    'ledger_keep_latest_version', 'ledger_validate_refund', 'ledger_protect_refunded_ticket',
    'ledger_preserve_rules', 'ledger_preserve_guest_name', 'ledger_preserve_manual_cost',
    'ledger_canonical_supplier_brand', 'ledger_validate_show79_settlement', 'record_show79_settlement'
  ]) {
    assert.match(baseline, new RegExp(`create or replace function public\\.${functionName}\\(`))
  }
  assert.match(baseline, /grant execute on function public\.record_show79_settlement\(uuid,text,date,numeric,numeric,text,numeric,numeric,numeric,uuid\)/)
  assert.match(baseline, /alter publication supabase_realtime add table public\.show79_settlements/)
  assert.match(baseline, /ledger_00a_canonical_supplier_brand/)

  for (const file of productionHistory.slice(1)) {
    const marker = await read(`supabase/migrations/${file}`)
    assert.match(marker, /Historical production migration marker/)
    assert.match(marker, /do \$\$ begin null; end \$\$;/)
  }

  const hardening = await read(`supabase/migrations/${hardeningFile}`)
  assert.match(hardening, /projects_supplier_owner_fkey/)
  assert.match(hardening, /tickets_supplier_owner_fkey/)
  assert.match(hardening, /tickets_agent_price_thb_valid/)
  assert.match(hardening, /revoke all privileges on table public\.suppliers, public\.projects, public\.tickets/)
})
