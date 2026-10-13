import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve('dist')
const assets = (await readdir(resolve(output, 'assets'))).sort().map((name) => `assets/${name}`)
const workerPath = resolve(output, 'service-worker.js')
const template = await readFile(workerPath, 'utf8')
const hash = createHash('sha256').update(template)
for (const path of ['index.html', 'manifest.webmanifest', 'icon.svg', ...assets]) {
  hash.update(path).update(await readFile(resolve(output, path)))
}
const version = hash.digest('hex').slice(0, 16)
await writeFile(workerPath, template.replace('__BUILD_VERSION__', version).replace('/* BUILD_ASSETS */ []', JSON.stringify(assets)))
console.log(`离线版本 ${version} 已包含 ${assets.length} 个应用资源。`)
