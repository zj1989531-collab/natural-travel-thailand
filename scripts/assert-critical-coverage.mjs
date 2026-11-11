import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const summary = JSON.parse(await readFile(new URL('../coverage/coverage-summary.json', import.meta.url), 'utf8'))
const criticalModules = [
  'src/lib/repository.ts',
  'src/lib/sync.ts',
  'src/lib/ticket-command.ts',
  'src/lib/ticket-amounts.ts',
  'src/lib/refunds.ts',
  'src/lib/reports.ts'
]

for (const module of criticalModules) {
  const entry = Object.entries(summary).find(([path]) => path.endsWith(module))?.[1]
  assert.ok(entry, `缺少关键模块覆盖率：${module}`)
  assert.ok(entry.lines.pct >= 80, `${module} 行覆盖率 ${entry.lines.pct}% 低于 80%`)
  assert.ok(entry.branches.pct >= 75, `${module} 分支覆盖率 ${entry.branches.pct}% 低于 75%`)
}
