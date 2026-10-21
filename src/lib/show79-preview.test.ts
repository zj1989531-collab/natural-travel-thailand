import { describe, expect, it } from 'vitest'
import type { RefundRecord, TicketRecord } from '../types'
import { createShow79PreviewGuard, isShow79PreviewCurrent, savedShow79Preview, show79DraftSource, show79DraftVersion, show79PreviewTickets, show79TicketVersion } from './show79-preview'

const ticket: TicketRecord = { id: 'order-79', userId: 'owner', guestName: 'Jimmy', issueDate: '2026-10-16', issueTime: '19:35', projectId: 'project-79', projectName: '79秀', subItemName: '门票', supplierId: 'supplier-79', supplierName: '供货商', personCount: 3, amountBasis: 'per_person', quantityUnit: 'person', agentPriceThb: 500, costThb: 450, note: '内部备注不对客', deletedAt: null, createdAt: '2026-10-16T12:35:00Z', updatedAt: '2026-10-16T12:35:00Z', syncStatus: 'synced' }
const refund: RefundRecord = { id: 'refund-1', userId: ticket.userId, ticketId: ticket.id, personCount: 1, isFull: false, refundRevenueThb: 500, returnedCostThb: 450, refundDate: '2026-10-17', refundTime: '10:00', note: '退1人', cancelledAt: null, createdAt: '2026-10-17T03:00:00Z', updatedAt: '2026-10-17T03:00:00Z', syncStatus: 'synced' }

describe('79 voucher source validity', () => {
  it('bridges a confirmed save only before refresh and never shadows a newer refund or deletion', () => {
    const before: TicketRecord[] = []
    const confirmed = { ticket, baseline: before }
    expect(show79PreviewTickets(before, confirmed)).toEqual([ticket])
    const refreshed = [{ ...ticket, refunds: [refund] }]
    expect(show79PreviewTickets(refreshed, confirmed)).toBe(refreshed)
    expect(savedShow79Preview(show79PreviewTickets(refreshed, confirmed)[0]).input.people).toBe(2)
    const deleted: TicketRecord[] = []
    expect(show79PreviewTickets(deleted, confirmed)).toEqual([])
  })
  it('builds customer-only input from the saved order and remaining people after a partial refund', () => {
    const row = { ...ticket, refunds: [refund] }
    const result = savedShow79Preview(row)
    expect(result.input).toEqual({ guestName: 'Jimmy', date: '2026-10-16', people: 2 })
    expect(Object.keys(result.input).sort()).toEqual(['date', 'guestName', 'people'])
    expect(result.source).toMatchObject({ kind: 'saved', ticketId: ticket.id, userId: ticket.userId })
    expect(isShow79PreviewCurrent(result.source, result.input, [row])).toBe(true)
  })

  it.each([
    { guestName: 'Updated' }, { issueDate: '2026-10-17' }, { personCount: 2 },
    { agentPriceThb: 600 }, { costThb: 400 }, { note: '备注更新' },
    { updatedAt: '2026-10-16T12:36:00Z' }, { deletedAt: '2026-10-17T03:00:00Z' }
  ] as Partial<TicketRecord>[])('retires an order preview after a saved snapshot changes: %j', changes => {
    const result = savedShow79Preview(ticket)
    expect(isShow79PreviewCurrent(result.source, result.input, [{ ...ticket, ...changes }])).toBe(false)
  })

  it('retires a preview when the order disappears, changes owner, or gains a refund', () => {
    const result = savedShow79Preview(ticket)
    expect(isShow79PreviewCurrent(result.source, result.input, [])).toBe(false)
    expect(isShow79PreviewCurrent(result.source, result.input, [{ ...ticket, userId: 'other' }])).toBe(false)
    expect(isShow79PreviewCurrent(result.source, result.input, [{ ...ticket, refunds: [refund] }])).toBe(false)
  })

  it('retires the partial-refund picture on refund cancellation or a remote refund update', () => {
    const row = { ...ticket, refunds: [refund] }
    const result = savedShow79Preview(row)
    const cancelled = { ...row, refunds: [{ ...refund, cancelledAt: '2026-10-17T03:05:00Z', updatedAt: '2026-10-17T03:05:00Z' }] }
    expect(isShow79PreviewCurrent(result.source, result.input, [cancelled])).toBe(false)
    expect(savedShow79Preview(cancelled).input.people).toBe(3)
    expect(isShow79PreviewCurrent(result.source, result.input, [{ ...row, refunds: [{ ...refund, returnedCostThb: 400 }] }])).toBe(false)
  })

  it('does not retire a picture solely because acknowledgements or property order changed', () => {
    const row = { ...ticket, syncStatus: 'pending' as const, refunds: [{ ...refund, syncStatus: 'pending' as const }] }
    const result = savedShow79Preview(row)
    const reordered = Object.fromEntries(Object.entries({ ...ticket, refunds: [refund] }).reverse()) as unknown as TicketRecord
    expect(show79TicketVersion(row)).toBe(show79TicketVersion(reordered))
    expect(isShow79PreviewCurrent(result.source, result.input, [reordered])).toBe(true)
  })

  it('treats equal timestamp spellings alike while preserving microsecond revisions', () => {
    const result = savedShow79Preview({ ...ticket, refunds: [refund] })
    const synced = { ...ticket, createdAt: '2026-10-16T12:35:00.000000+00:00', updatedAt: '2026-10-16T19:35:00+07:00', refunds: [{ ...refund, createdAt: '2026-10-17T03:00:00.000000+00:00', updatedAt: '2026-10-17T03:00:00+00:00' }] }
    expect(isShow79PreviewCurrent(result.source, result.input, [synced])).toBe(true)
    expect(isShow79PreviewCurrent(result.source, result.input, [{ ...synced, updatedAt: '2026-10-16T12:35:00.000001+00:00' }])).toBe(false)
  })

  it('ignores refunds of other owners and refuses deleted, fully refunded or manual-profit vouchers', () => {
    expect(savedShow79Preview({ ...ticket, refunds: [{ ...refund, userId: 'other' }] }).input.people).toBe(3)
    for (const row of [{ ...ticket, deletedAt: ticket.updatedAt }, { ...ticket, refunds: [{ ...refund, isFull: true, personCount: 3 }] }, { ...ticket, entryMode: 'profit_only' as const }]) expect(() => savedShow79Preview(row)).toThrow()
  })

  it('keeps draft and saved sources distinct and retires a draft after its guest fields change', () => {
    const input = { guestName: 'Jimmy', date: ticket.issueDate, people: 3 }
    const source = { kind: 'draft' as const, version: show79DraftVersion(input) }
    expect(isShow79PreviewCurrent(source, input, [])).toBe(true)
    expect(isShow79PreviewCurrent(source, { ...input, people: 2 }, [])).toBe(false)
    expect(isShow79PreviewCurrent(source, { ...input, guestName: 'Aditya' }, [])).toBe(false)
  })

  it('also binds an unsaved edit preview to the original saved order and refund version', () => {
    const input = { guestName: '未保存的新姓名', date: ticket.issueDate, people: 3 }
    const source = show79DraftSource(input, ticket)
    expect(source.kind).toBe('draft')
    expect(isShow79PreviewCurrent(source, input, [ticket])).toBe(true)
    expect(isShow79PreviewCurrent(source, input, [{ ...ticket, refunds: [refund] }])).toBe(false)
    expect(isShow79PreviewCurrent(source, input, [])).toBe(false)
  })
})

describe('asynchronous voucher generation', () => {
  it('drops a completed render when its source was updated during rendering', async () => {
    const guard = createShow79PreviewGuard()
    let resolve!: (value: string) => void
    let rows = [ticket]
    const preview = savedShow79Preview(ticket)
    const task = guard.render(guard.begin(), () => new Promise<string>(done => { resolve = done }), () => isShow79PreviewCurrent(preview.source, preview.input, rows))
    rows = [{ ...ticket, refunds: [refund] }]
    resolve('old-image')
    expect(await task).toBeUndefined()
  })

  it('drops an earlier render after a new render or explicit refund action invalidates it', async () => {
    const guard = createShow79PreviewGuard()
    let resolve!: (value: string) => void
    const old = guard.render(guard.begin(), () => new Promise<string>(done => { resolve = done }), () => true)
    const next = guard.begin()
    expect(await guard.render(next, async () => 'new-image', () => true)).toBe('new-image')
    resolve('old-image'); expect(await old).toBeUndefined()
    let finish!: (value: string) => void
    const cancelled = guard.render(guard.begin(), () => new Promise<string>(done => { finish = done }), () => true)
    guard.invalidate(); finish('cancelled-image')
    expect(await cancelled).toBeUndefined()
  })
})
