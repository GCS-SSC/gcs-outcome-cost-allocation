import { describe, expect, it } from 'vitest'
import type { GcsCodingAllocatorContext } from '@gcs-ssc/extensions/server'
import allocator from '../../server/allocator'

const context = (amount: string, capacities: Array<{ codingLineId: string; amount: string }>): GcsCodingAllocatorContext => ({
  db: { selectFrom: () => { throw new Error('Payment allocation must use the host capacity snapshot.') } } as never,
  agreementId: '1', agencyId: '2', streamId: '3', amount, currency: 'usd',
  output: { kind: 'payment', commitmentId: '4', commitmentTypeId: '5', fiscalYearId: '6' },
  codingLines: capacities.map(line => ({ codingLineId: line.codingLineId, agencyChartOfAccountId: line.codingLineId, agencyFiscalYearId: '7', accountingDimensions: [] })),
  commitmentCodingLines: [], existingLines: [], codingPaidFloors: [], codingAvailableAmounts: capacities,
  config: { enabledCommitmentTypes: ['5'], mappings: [] }, agencyConfig: {}
})

describe('host-managed outcome payment allocation', () => {
  it('uses remaining unpaid amounts after uneven payments, irrespective of historic allocation weights', async () => {
    const input = context('50.00', [{ codingLineId: '11', amount: '15.00' }, { codingLineId: '12', amount: '85.00' }])
    input.existingLines = [
      { id: '21', codingLineId: '11', amount: '75.00', paidAmount: '60.00' },
      { id: '22', codingLineId: '12', amount: '100.00', paidAmount: '15.00' }
    ]
    expect(await allocator(input)).toEqual([{ codingLineId: '11', amount: '7.50' }, { codingLineId: '12', amount: '42.50' }])
  })
  it('consumes host shared-code capacities once instead of summing duplicate exact rows', async () => {
    const input = context('25.00', [{ codingLineId: '11', amount: '25.00' }, { codingLineId: '12', amount: '0.00' }])
    input.existingLines = [
      { id: '21', codingLineId: '11', amount: '50.00', paidAmount: '0.00' },
      { id: '22', codingLineId: '11', amount: '50.00', paidAmount: '0.00' }
    ]
    input.codingPaidFloors = [{ codingLineId: '11', paidAmount: '75.00' }]
    expect(await allocator(input)).toEqual([{ codingLineId: '11', amount: '25.00' }])
  })
  it('ignores capacities outside the selected fiscal-year output catalog', async () => {
    const input = context('10.00', [{ codingLineId: '11', amount: '20.00' }])
    input.codingAvailableAmounts.push({ codingLineId: '12', amount: '100.00' })
    expect(await allocator(input)).toEqual([{ codingLineId: '11', amount: '10.00' }])
  })
  it('balances a residual cent and rejects a payment exceeding remaining capacity', async () => {
    expect(await allocator(context('0.01', [{ codingLineId: '11', amount: '50.00' }, { codingLineId: '12', amount: '50.00' }]))).toEqual([{ codingLineId: '12', amount: '0.01' }])
    await expect(allocator(context('100.01', [{ codingLineId: '11', amount: '100.00' }]))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING' })
  })
  it('spreads residual cents instead of concentrating rounding drift on the last code', async () => {
    const capacities = Array.from({ length: 101 }, (_, index) => ({ codingLineId: String(index + 1), amount: '1.00' }))
    const split = await allocator(context('50.00', capacities))
    expect(split).toHaveLength(101)
    expect(split!.filter(line => line.amount === '0.50')).toHaveLength(51)
    expect(split!.filter(line => line.amount === '0.49')).toHaveLength(50)
    expect(await allocator(context('50.00', [...capacities].reverse()))).toEqual([...split!].reverse())
  })
})
