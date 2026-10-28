import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const sourceRoot = new URL('../src/', import.meta.url)

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  }))
  return files.flat()
}

test('XLSX integration stays export-only', async () => {
  const files = await sourceFiles(sourceRoot.pathname)
  const sources = await Promise.all(files.map(async (path) => ({ path, source: await readFile(path, 'utf8') })))
  const xlsxUsers = sources.filter(({ source }) => /(?:from\s+['"]xlsx['"]|import\(\s*['"]xlsx['"]\s*\)|require\(\s*['"]xlsx['"]\s*\))/.test(source))

  assert.deepEqual(xlsxUsers.map(({ path }) => path.replace(sourceRoot.pathname, '')).sort(), ['lib/export.ts'])

  const [{ source }] = xlsxUsers
  assert.match(source, /XLSX\.utils\.book_new\(/)
  assert.match(source, /XLSX\.utils\.json_to_sheet\(/)
  assert.match(source, /XLSX\.utils\.book_append_sheet\(/)
  assert.match(source, /XLSX\.writeFile\(/)
  assert.doesNotMatch(source, /\bXLSX\s*\.\s*(?:read|readFile|readFileSync|stream)\b/i)
  assert.doesNotMatch(source, /\bXLSX\s*\.\s*utils\s*\.\s*(?:sheet_to_json|table_to_sheet|html_to_sheet|csv_to_sheet)\b/i)
})
