import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const workspace = await realpath(process.cwd())
const toolsDirectory = resolve(workspace, '.tools')
const localBinary = resolve(toolsDirectory, 'gh')
const installOnly = process.argv.includes('--install-only')
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ticket-profit-ledger-setup' }

function execute(binary, args, { interactive = false } = {}) {
  return spawnSync(binary, args, {
    cwd: workspace,
    encoding: 'utf8',
    stdio: interactive ? 'inherit' : 'pipe',
    maxBuffer: 1024 * 1024
  })
}

async function request(url, { download = false, limit = 80 * 1024 * 1024 } = {}) {
  let target = new URL(url)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const allowed = ['github.com', 'api.github.com', ...(download && redirects > 0 ? ['release-assets.githubusercontent.com'] : [])]
    if (target.protocol !== 'https:' || !allowed.includes(target.hostname) || target.username || target.password || target.port) {
      throw new Error('下载地址不属于 GitHub 官方 HTTPS 服务，已停止安装。')
    }
    const response = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(120000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('GitHub 下载跳转缺少地址，请稍后重试。')
      await response.body?.cancel()
      target = new URL(location, target)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`GitHub 官方下载失败（HTTP ${response.status}），请检查网络后重试。`)
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw new Error('GitHub 下载文件超过预期大小，已停止安装。')
    }
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) {
        await response.body.cancel().catch(() => undefined)
        throw new Error('GitHub 下载文件超过预期大小，已停止安装。')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('GitHub 下载跳转次数异常，已停止安装。')
}

function assetUrl(release, asset) {
  const expected = `https://github.com/cli/cli/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`
  if (asset.browser_download_url !== expected) throw new Error('官方发布文件地址与选定版本不一致，已停止安装。')
  return expected
}

async function install() {
  const platform = { darwin: 'macOS', linux: 'linux' }[process.platform]
  const architecture = { arm64: 'arm64', x64: 'amd64' }[process.arch]
  if (!platform || !architecture) throw new Error('此安装助手支持 macOS/Linux 的 Apple Silicon、ARM64 和 x64 电脑。')
  console.log('正在查询 GitHub CLI 官方最新版本…')
  const release = JSON.parse((await request('https://api.github.com/repos/cli/cli/releases/latest', { limit: 2 * 1024 * 1024 })).toString('utf8'))
  const extension = platform === 'macOS' ? 'zip' : 'tar.gz'
  const suffix = `_${platform}_${architecture}.${extension}`
  const asset = release.assets?.find((entry) => entry.name.startsWith('gh_') && entry.name.endsWith(suffix))
  if (!asset || !/^gh_[A-Za-z0-9.+_-]+\.(?:zip|tar\.gz)$/.test(asset.name)) throw new Error('官方最新版本没有适用于这台电脑的 GitHub CLI 文件。')
  let checksum
  if (/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) checksum = asset.digest.slice(7).toLowerCase()
  else {
    const checksumsName = `${asset.name.slice(0, -suffix.length)}_checksums.txt`
    const checksums = release.assets.find((entry) => entry.name === checksumsName)
    if (checksums) {
      const contents = (await request(assetUrl(release, checksums), { download: true, limit: 1024 * 1024 })).toString('utf8')
      const entry = contents.split(/\r?\n/).map((line) => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i)).find((match) => match?.[2] === asset.name)
      checksum = entry?.[1].toLowerCase()
    }
  }
  if (!checksum) throw new Error('官方发布未提供可核对的 SHA-256 校验值，已停止安装。')
  console.log(`正在下载并校验 ${asset.name}…`)
  const archive = await request(assetUrl(release, asset), { download: true })
  if (createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('GitHub CLI 文件校验失败，已停止安装。')
  const existing = await lstat(toolsDirectory).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('项目 .tools 不是普通目录，请先检查该路径。')
  await mkdir(toolsDirectory, { recursive: true })
  const temporary = await mkdtemp(resolve(toolsDirectory, '.gh-install-'))
  try {
    const archivePath = resolve(temporary, asset.name)
    await writeFile(archivePath, archive, { flag: 'wx' })
    const utility = extension === 'zip' ? 'unzip' : 'tar'
    const listing = execute(utility, extension === 'zip' ? ['-Z', '-1', archivePath] : ['-tzf', archivePath])
    if (listing.error || listing.status !== 0) throw new Error(`无法读取官方安装包，请检查系统是否提供 ${utility}。`)
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
    if (entries.some((entry) => entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..'))) {
      throw new Error('安装包包含不安全路径，已停止安装。')
    }
    const member = `${asset.name.slice(0, -(extension.length + 1))}/bin/gh`
    if (entries.filter((entry) => entry === member).length !== 1) throw new Error('安装包中没有唯一且符合预期的 gh 程序。')
    // Extract only the exact binary to stdout; archive paths never write to disk.
    const extracted = spawnSync(utility, extension === 'zip' ? ['-p', archivePath, member] : ['-xOzf', archivePath, member], {
      cwd: temporary, maxBuffer: 80 * 1024 * 1024
    })
    if (extracted.error || extracted.status !== 0 || !extracted.stdout?.length) throw new Error('提取 GitHub CLI 程序失败。')
    const candidate = resolve(temporary, 'gh')
    await writeFile(candidate, extracted.stdout, { flag: 'wx' })
    await chmod(candidate, 0o755)
    if (execute(candidate, ['--version']).status !== 0) throw new Error('下载的 GitHub CLI 无法在这台电脑上运行。')
    await rename(candidate, localBinary)
    console.log('GitHub CLI 已安装到项目 .tools/gh。')
    return localBinary
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function main() {
  const binary = execute('gh', ['--version']).status === 0 ? 'gh'
    : execute(localBinary, ['--version']).status === 0 ? localBinary : await install()
  if (installOnly) {
    console.log('GitHub CLI 已就绪；此次只安装，没有进行账号登录。')
    return
  }
  if (execute(binary, ['auth', 'status', '--hostname', 'github.com']).status !== 0) {
    console.log('请按 GitHub 提示，在浏览器中完成账号登录。')
    if (execute(binary, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { interactive: true }).status !== 0) {
      throw new Error('GitHub 登录尚未完成，请重新运行此助手。')
    }
  } else console.log('已检测到有效的 GitHub 登录，将使用现有账号。')
  if (execute(binary, ['auth', 'setup-git', '--hostname', 'github.com'], { interactive: true }).status !== 0) {
    throw new Error('Git 登录配置失败，请检查 Git 是否可用后重试。')
  }
  const user = execute(binary, ['api', 'user', '--jq', '.login'])
  const login = user.stdout?.trim()
  if (user.error || user.status !== 0 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login || '')) throw new Error('无法验证 GitHub 登录账号，请检查网络和登录状态。')
  console.log(`GitHub 登录已验证：${login}。可以继续创建仓库和上传代码。`)
}

try {
  await main()
} catch (error) {
  // Do not print download redirect URLs or command output, which may be sensitive.
  const known = error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
  console.error(known ? error.message : 'GitHub 配置失败，请检查网络、目录权限后重试。')
  process.exitCode = 1
}
