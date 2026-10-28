import { loadEnv } from 'vite'

const env = loadEnv('production', process.cwd(), 'VITE_')
const url = env.VITE_SUPABASE_URL?.trim()
const key = env.VITE_SUPABASE_ANON_KEY?.trim()
const requireSupabase = process.argv.includes('--require-supabase')

if (Boolean(url) !== Boolean(key)) {
  throw new Error('请同时配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY；或同时留空以使用本机账本。')
}
if (requireSupabase && !url) {
  throw new Error('生产发布必须配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY，不能发布为仅本机账本。')
}
if (url && key) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Supabase URL 必须是无用户名和密码的 HTTPS 地址。')
  }
  let role
  try {
    role = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role
  } catch { /* Publishable keys do not use JWT encoding. */ }
  if (key.startsWith('sb_secret_') || role === 'service_role') {
    throw new Error('客户端不能使用 Supabase secret/service_role 密钥。请改用 publishable 或 anon 公钥。')
  }
  if (!key.startsWith('sb_publishable_') && role !== 'anon') {
    throw new Error('请使用 Supabase 的 publishable 或 anon 公钥。')
  }
}
