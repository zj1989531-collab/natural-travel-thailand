const BANGKOK_TIME_ZONE = 'Asia/Bangkok'

export const formatThb = (value: number): string =>
  new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)

export const formatNumber = (value: number): string =>
  new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 }).format(value)

export const formatDate = (date: string): string => {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: BANGKOK_TIME_ZONE
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

export const getBangkokDate = (date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BANGKOK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const lookup = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

export const getBangkokMonth = (date = new Date()): string => getBangkokDate(date).slice(0, 7)

export const getBangkokTime = (date = new Date()): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: BANGKOK_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)

export const isValidIssueTime = (time: string): boolean => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)

export const MAX_PERSON_COUNT = 2147483647
export const isValidPersonCount = (count: number): boolean => Number.isInteger(count) && count >= 1 && count <= MAX_PERSON_COUNT

export const toNumber = (value: string): number => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export const normalizeSupplier = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

export const createId = (): string => crypto.randomUUID()
