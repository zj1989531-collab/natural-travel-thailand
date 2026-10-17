import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { matchesTicketSearch } from './ticket-search'

const ticket = { issueDate: '2026-10-16', supplierId: 'supplier-a', guestName: 'Jimmy Tan', projectName: '测试项目', subItemName: 'VIP 儿童票', supplierName: '自然旅游', note: '酒店接送' } satisfies Pick<TicketRecord, 'issueDate' | 'supplierId' | 'guestName' | 'projectName' | 'subItemName' | 'supplierName' | 'note'>
const all = { query: '', supplierId: '', date: '', range: 'all' as const, today: '2026-10-16' }

describe('record lookup filters', () => {
  it.each(['jimmy', 'ＪＩＭＭＹ', '儿童票', 'vip', '测试项目', '自然旅游', '酒店接送'])('finds customer, package, project, supplier or note: %s', query => {
    expect(matchesTicketSearch(ticket, { ...all, query })).toBe(true)
  })
  it('combines exact date, customer name and supplier without ignoring any filter', () => {
    const filter = { ...all, date: ticket.issueDate, query: 'Jimmy', supplierId: ticket.supplierId }
    expect(matchesTicketSearch(ticket, filter)).toBe(true)
    expect(matchesTicketSearch(ticket, { ...filter, date: '2026-10-15' })).toBe(false)
    expect(matchesTicketSearch(ticket, { ...filter, supplierId: 'supplier-b' })).toBe(false)
    expect(matchesTicketSearch(ticket, { ...filter, query: 'Aditya' })).toBe(false)
  })
  it('uses the supplied Bangkok date for today and refreshes when that date changes', () => {
    expect(matchesTicketSearch(ticket, { ...all, range: 'today' })).toBe(true)
    expect(matchesTicketSearch(ticket, { ...all, range: 'today', today: '2026-10-17' })).toBe(false)
  })
  it('includes all dates in the Bangkok natural month and follows year boundaries', () => {
    const filter = { ...all, range: 'month' as const, today: '2027-01-01' }
    for (const issueDate of ['2027-01-01', '2027-01-31']) expect(matchesTicketSearch({ ...ticket, issueDate }, filter)).toBe(true)
    for (const issueDate of ['2026-12-31', '2027-02-01']) expect(matchesTicketSearch({ ...ticket, issueDate }, filter)).toBe(false)
    expect(matchesTicketSearch(ticket, { ...all, range: 'month' })).toBe(true)
    expect(matchesTicketSearch(ticket, { ...all, range: 'month', today: '2026-11-01' })).toBe(false)
  })
  it('keeps old unnamed records searchable and allows all dates after clearing filters', () => {
    expect(matchesTicketSearch({ ...ticket, guestName: undefined, subItemName: '', issueDate: '2025-01-01' }, all)).toBe(true)
    expect(matchesTicketSearch(ticket, { ...all, query: '不存在' })).toBe(false)
  })
})
