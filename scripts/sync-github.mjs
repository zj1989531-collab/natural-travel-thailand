import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Only application source is uploaded, never browser data or exported backups.
const sourcePaths = [
  '.github', '.env.example', '.gitignore', 'README.md', 'DEPLOYMENT.md', 'index.html', 'package.json',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'public', 'scripts', 'src', 'supabase',
  'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts'
]
const watching = process.argv.includes('--watch')
let stopped = false
let running = false
let requested = false
let debounce
let devServer
const watchers = []

function git(args, { optional = false, silent = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !optional) {
    // Git may include a credential-bearing remote URL in its error text.
    const detail = (result.stderr || '').replace(/https:\/\/[^\s/@]+@/g, 'https://[hidden]@')
    throw new Error(silent ? 'Git 操作失败，请检查登录和网络。' : detail.trim() || 'Git 操作失败。')
  }
  return result
}

function command(args) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? accept() : reject(new Error('检查未通过，此次修改没有上传。')))
  })
}

function sourceSnapshot(paths) {
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths]).stdout.split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update(existsSync(file) ? readFileSync(file) : 'deleted')
  }
  return hash.digest('hex')
}

async function synchronise() {
  const remote = git(['remote', 'get-url', 'origin'], { optional: true }).stdout.trim()
  if (!remote) throw new Error('尚未关联 GitHub 仓库。关联 origin 并完成 Git 登录后即可自动同步。')
  if (!/^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote) && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(remote)) {
    throw new Error('origin 必须是无凭证的 github.com 仓库地址。')
  }
  const branch = git(['branch', '--show-current']).stdout.trim()
  if (branch !== 'main') throw new Error('自动同步仅处理 main 分支，请先回到 main。')
  for (const field of ['user.name', 'user.email']) {
    if (!git(['config', '--get', field], { optional: true }).stdout.trim()) {
      throw new Error('请先配置这个仓库的 Git 提交姓名和邮箱。')
    }
  }
  if (git(['diff', '--cached', '--quiet'], { optional: true }).status !== 0) {
    throw new Error('检测到手动暂存的修改，自动同步已暂停。请先提交或取消暂存。')
  }
  // Fetch never overwrites local files. Remote edits require an explicit merge.
  git(['fetch', 'origin'], { silent: true })
  const hasHead = git(['rev-parse', '--verify', 'HEAD'], { optional: true }).status === 0
  const startingHead = hasHead ? git(['rev-parse', 'HEAD']).stdout.trim() : ''
  const hasRemote = git(['rev-parse', '--verify', 'refs/remotes/origin/main'], { optional: true }).status === 0
  if (hasRemote && (!hasHead || git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { optional: true }).status !== 0)) {
    throw new Error('GitHub 有尚未合并的更新，已暂停上传。请先合并远程修改；不会强制覆盖。')
  }
  const paths = sourcePaths.filter((path) => existsSync(path) || git(['ls-files', '--', path]).stdout.trim())
  const changed = git(['status', '--porcelain', '--untracked-files=all', '--', ...paths]).stdout.trim()
  if (changed) {
    const snapshot = sourceSnapshot(paths)
    console.log('正在检查修改，检查通过后自动上传…')
    await command(['node_modules/vitest/vitest.mjs', 'run'])
    await command(['--test', 'scripts/pwa.test.mjs', 'scripts/supabase-schema.test.mjs', 'scripts/validate-client-config.test.mjs', 'scripts/xlsx-usage.test.mjs'])
    await command(['scripts/validate-client-config.mjs'])
    await command(['node_modules/typescript/bin/tsc', '-b', '--pretty', 'false'])
    await command(['node_modules/vite/bin/vite.js', 'build'])
    await command(['scripts/stamp-build.mjs'])
    if (stopped) return
    const currentHead = git(['rev-parse', '--verify', 'HEAD'], { optional: true }).stdout.trim()
    if (git(['branch', '--show-current']).stdout.trim() !== branch || currentHead !== startingHead || git(['diff', '--cached', '--quiet'], { optional: true }).status !== 0) {
      throw new Error('检查期间分支、提交或手动暂存发生变化，本次自动上传已暂停。')
    }
    if (sourceSnapshot(paths) !== snapshot) {
      requested = true
      console.log('检查期间源码再次更新，将重新检查最新修改。')
      return
    }
    git(['add', '-A', '--', ...paths])
    const staged = git(['diff', '--cached', '--name-only', '-z']).stdout.split('\0').filter(Boolean)
    for (const path of staged) {
      if (!sourcePaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) {
        throw new Error('暂存区包含范围外的文件，已暂停上传。')
      }
      if (/\.(xlsx?|csv|sqlite3?|db|pem|key|log)$/i.test(path) || /(^|\/)\.env(\.|$)/.test(path) && path !== '.env.example') {
        throw new Error('检测到备份或密钥文件，已暂停上传。')
      }
      const contents = git(['show', `:${path}`], { optional: true }).stdout
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sb_secret_[A-Za-z0-9_-]{20,})/.test(contents)) {
        throw new Error('检测到可能的密钥，已暂停上传。请从源码移除后再同步。')
      }
      for (const match of contents.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
        let role
        try { role = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString()).role } catch { continue }
        if (role === 'service_role') throw new Error('检测到 Supabase 管理密钥，已暂停上传。')
      }
    }
    if (git(['diff', '--cached', '--quiet'], { optional: true }).status !== 0) {
      git(['commit', '-m', 'Sync ticket ledger updates'])
    }
  }
  const head = git(['rev-parse', '--verify', 'HEAD'], { optional: true }).stdout.trim()
  const remoteHead = git(['rev-parse', '--verify', 'origin/main'], { optional: true }).stdout.trim()
  if (head && head !== remoteHead) {
    git(['push', '--set-upstream', 'origin', 'HEAD:main'], { silent: true })
    console.log('代码已同步到 GitHub，线上更新由 GitHub Actions 自动执行。')
  }
}

async function run() {
  requested = true
  if (running || stopped) return
  running = true
  try {
    while (requested && !stopped) {
      requested = false
      try {
        await synchronise()
      } catch (error) {
        console.error(error instanceof Error ? error.message : '同步失败。')
        if (!watching) process.exitCode = 1
      }
    }
  } finally {
    running = false
  }
}

if (process.argv.includes('--dev')) {
  devServer = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })
  devServer.on('error', (error) => { console.error(error.message); stop() })
  devServer.on('exit', () => stop())
}
let retry
function stop() {
  stopped = true
  clearTimeout(debounce)
  clearInterval(retry)
  watchers.forEach((watcher) => watcher.close())
  devServer?.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

if (watching) {
  for (const path of sourcePaths.filter(existsSync)) {
    watchers.push(watch(resolve(path), { recursive: statSync(path).isDirectory() }, (_event, file) => {
      if (file && /(^|[/\\])(?:node_modules|dist|\.git|exports)([/\\]|$)/.test(file)) return
      clearTimeout(debounce)
      debounce = setTimeout(() => void run(), 5000)
    }))
  }
  retry = setInterval(() => void run(), 30000)
  console.log('代码自动同步已启动：保存后等待 5 秒，检查通过便提交并上传。按 Ctrl+C 停止。')
}
await run()
