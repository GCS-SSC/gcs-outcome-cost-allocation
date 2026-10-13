import { describe, expect, it, vi } from 'vitest'
import { seedManagedAgencyCoding } from '../../demo/agency-coding-seed'
const response = (body: unknown) => ({ json: async () => body, ok: () => true, status: () => 200, text: async () => '' })
const commitment = (id: string, fiscalYear: string, currency = 'cad') => ({ id, egcs_ay_fiscalyear: fiscalYear, egcs_ay_currency: currency })
const memo = (id: string, link: string | null, fiscalYear = '1', currency = 'cad') => ({ ...commitment(id, fiscalYear, currency), egcs_ay_commitmentchartofaccount: link })
const streams = [{ programId: '3', streamId: '4' }]
const fixture = (creditMemoAccounts: ReturnType<typeof memo>[] = [], selections: string[] = [], budgetYears = ['1', '2']) => {
  let nextId = 10
  const post = vi.fn(async (_url: string, _options?: { data?: unknown }) => response({ id: String(nextId++) }))
  const patch = vi.fn(async () => response({}))
  const get = vi.fn(async (url: string) => {
    const items = url.includes('/streams/') ? (url.includes('/budgets') ? budgetYears.map(egcs_tp_fiscalyear => ({ egcs_tp_fiscalyear, egcs_tp_currency: 'cad' })) : selections.map(egcs_tp_agencychartofaccount => ({ egcs_tp_agencychartofaccount })))
      : url.includes('fiscal-years') ? [{ id: '1' }, { id: '2' }]
      : url.includes('kind=credit_memo') ? creditMemoAccounts
        : [commitment('5', '1'), commitment('6', '1'), commitment('7', '2'), commitment('8', '2', 'usd')]
    return response({ items, total: items.length })
  })
  return { get, post, put: vi.fn(), patch }
}

describe('Managed Agency coding seed', () => {
  it('keeps yearly AR sets and prepares linked accounts for every CAD Commitment without authoring remap exceptions', async () => {
    const request = fixture()
    const result = await seedManagedAgencyCoding(request, '2', streams)
    expect(result.receivableSets).toEqual([
      { fiscalYearId: '1', currency: 'cad', lines: [{ codingLineId: '10', percentage: '100' }] },
      { fiscalYearId: '2', currency: 'cad', lines: [{ codingLineId: '11', percentage: '100' }] }
    ])
    expect(result.creditMemoRules).toEqual([])
    expect(request.post.mock.calls.filter(([url]) => url === '/api/agency/2/chart-of-accounts').slice(2)).toEqual([
      ['/api/agency/2/chart-of-accounts', expect.objectContaining({ data: expect.objectContaining({ egcs_ay_kind: 'credit_memo', egcs_ay_fiscalyear: '1', egcs_ay_commitmentchartofaccount: '5' }) })],
      ['/api/agency/2/chart-of-accounts', expect.objectContaining({ data: expect.objectContaining({ egcs_ay_kind: 'credit_memo', egcs_ay_fiscalyear: '1', egcs_ay_commitmentchartofaccount: '6' }) })],
      ['/api/agency/2/chart-of-accounts', expect.objectContaining({ data: expect.objectContaining({ egcs_ay_kind: 'credit_memo', egcs_ay_fiscalyear: '2', egcs_ay_commitmentchartofaccount: '7' }) })]
    ])
    expect(request.post.mock.calls.filter(([url]) => url.includes('/streams/'))).toEqual(['10', '11', '12', '13', '14'].map(id => ['/api/transfer-payments/3/streams/4/chart-of-accounts', { data: { egcs_tp_agencychartofaccount: id } }]))
    expect(request.patch).toHaveBeenCalledWith('/api/extensions/agency/2', { data: { extensionKey: 'gcs-outcome-cost-allocation', enabled: true, config: result } })
  })

  it('reuses unique linked Credit Memo accounts and leaves unrelated catch-all accounts alone', async () => {
    const request = fixture([memo('40', '5'), memo('41', '6'), memo('42', '7', '2'), memo('43', null)])
    await seedManagedAgencyCoding(request, '2', streams)
    expect(request.post.mock.calls.filter(([url]) => url === '/api/agency/2/chart-of-accounts')).toHaveLength(2)
    expect(request.post.mock.calls.filter(([url]) => url.includes('/streams/'))).toHaveLength(5)
    expect(request.get.mock.calls.some(([url]) => url.includes('kind=credit_memo'))).toBe(true)
  })

  it('reuses selected coding and selects only accounts with a matching Stream budget year and currency', async () => {
    const request = fixture([memo('40', '5'), memo('41', '6'), memo('42', '7', '2')], ['40'], ['1'])
    await seedManagedAgencyCoding(request, '2', streams)
    expect(request.post.mock.calls.filter(([url]) => url.includes('/streams/'))).toEqual([
      ['/api/transfer-payments/3/streams/4/chart-of-accounts', { data: { egcs_tp_agencychartofaccount: '10' } }],
      ['/api/transfer-payments/3/streams/4/chart-of-accounts', { data: { egcs_tp_agencychartofaccount: '41' } }]
    ])
  })

  it('rejects ambiguous links before creating any accounts or changing configuration', async () => {
    const request = fixture([memo('40', '5'), memo('41', '5')])
    await expect(seedManagedAgencyCoding(request, '2', streams)).rejects.toThrow('Ambiguous Credit Memo coding for Commitment account 5')
    expect(request.post).not.toHaveBeenCalled()
    expect(request.patch).not.toHaveBeenCalled()
  })

  it('rejects an existing linked account with inconsistent fiscal year or currency', async () => {
    const request = fixture([memo('40', '5', '2')])
    await expect(seedManagedAgencyCoding(request, '2', streams)).rejects.toThrow('Invalid Credit Memo coding link for Commitment account 5')
    expect(request.post).not.toHaveBeenCalled()
  })
})
