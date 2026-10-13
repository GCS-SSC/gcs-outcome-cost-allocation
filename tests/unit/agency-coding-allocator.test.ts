import { describe, expect, it } from 'vitest'
import type { GcsCodingAllocatorContext } from '@gcs-ssc/extensions/server'
import allocator from '../../server/allocator'

const context = (overrides: Partial<GcsCodingAllocatorContext> = {}): GcsCodingAllocatorContext => ({
  db: {} as GcsCodingAllocatorContext['db'], agreementId: '1', agencyId: '1', streamId: '1', currency: 'cad', amount: '0.03',
  output: { kind: 'receivable', fiscalYearId: '2026' },
  codingLines: ['10', '20'].map(id => ({ codingLineId: id, agencyChartOfAccountId: id, agencyFiscalYearId: '2026', accountingDimensions: [] })),
  commitmentCodingLines: [], existingLines: [], codingPaidFloors: [], codingAvailableAmounts: [], config: {},
  agencyConfig: { version: 1, receivableSets: [{ fiscalYearId: '2026', currency: 'cad', lines: [{ codingLineId: '10', percentage: '50' }, { codingLineId: '20', percentage: '50' }] }], creditMemoRules: [] },
  ...overrides
})

describe('automatic agency coding through the allocator contract', () => {
  it('splits an original AR with exact cents and retains authored percentages', async () => {
    expect(await allocator(context())).toMatchObject({ lines: [{ codingLineId: '10', amount: '0.02' }, { codingLineId: '20', amount: '0.01' }], policy: { lines: [{ codingLineId: '10', percentage: '50' }, { codingLineId: '20', percentage: '50' }] } })
  })

  it('rejects invalid AR percentage totals', async () => {
    const invalid = context()
    invalid.agencyConfig = { receivableSets: [{ fiscalYearId: '2026', currency: 'cad', lines: [{ codingLineId: '10', percentage: '99' }] }] }
    await expect(allocator(invalid)).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })
  it('blocks missing configuration and missing or wrong-year catalogue accounts', async () => {
    for (const input of [context({ agencyConfig: {} }), context({ codingLines: [] }), context({ codingLines: [{ codingLineId: '10', agencyChartOfAccountId: '10', agencyFiscalYearId: '2027', accountingDimensions: [] }] })]) {
      await expect(allocator(input)).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    }
  })
  it('retains percentages after configuration changes rather than deriving them from rounded cents', async () => {
    expect(await allocator(context({ amount: '0.05', agencyConfig: {}, retainedPolicy: { version: 1, kind: 'receivable', currency: 'cad', fiscalYearId: '2026', lines: [{ codingLineId: '10', percentage: '50' }, { codingLineId: '20', percentage: '50' }] } }))).toMatchObject({ lines: [{ codingLineId: '10', amount: '0.03' }, { codingLineId: '20', amount: '0.02' }] })
  })
  it('rejects retained coding with a different date, kind or currency', async () => {
    for (const policy of [
      { version: 1, kind: 'credit-memo', currency: 'cad', effectiveDate: '2026-06-29' },
      { version: 1, kind: 'receivable', currency: 'cad', fiscalYearId: '2026' },
      { version: 1, kind: 'credit-memo', currency: 'usd', effectiveDate: '2026-06-30' }
    ]) await expect(allocator(context({ output: { kind: 'credit-memo', effectiveDate: '2026-06-30' }, retainedPolicy: JSON.parse(JSON.stringify({ ...policy, lines: [{ codingLineId: '10', percentage: '100' }] })) }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })
  it('balances large amounts and preserves rounded-zero percentage lines', async () => {
    expect(await allocator(context({ amount: '900719925474099.91' }))).toMatchObject({ lines: [{ codingLineId: '10', amount: '450359962737049.96' }, { codingLineId: '20', amount: '450359962737049.95' }] })
    expect(await allocator(context({ amount: '0.01' }))).toMatchObject({ lines: [{ codingLineId: '10', amount: '0.01' }, { codingLineId: '20', amount: '0.00' }] })
  })

  it('returns Stream IDs while retaining Agency IDs even when the two namespaces collide', async () => {
    const codingLines = context().codingLines.map(account => ({ ...account, codingLineId: account.agencyChartOfAccountId === '10' ? '20' : '10' }))
    const fresh = await allocator(context({ codingLines }))
    expect(fresh).toEqual({ lines: [{ codingLineId: '20', amount: '0.02' }, { codingLineId: '10', amount: '0.01' }], policy: { version: 1, kind: 'receivable', currency: 'cad', fiscalYearId: '2026', lines: [{ codingLineId: '10', percentage: '50' }, { codingLineId: '20', percentage: '50' }] } })
    const retainedPolicy = (fresh as { policy: GcsCodingAllocatorContext['retainedPolicy'] }).policy
    expect(await allocator(context({ codingLines, retainedPolicy, agencyConfig: {}, amount: '0.05' })))
      .toMatchObject({ lines: [{ codingLineId: '20', amount: '0.03' }, { codingLineId: '10', amount: '0.02' }], policy: retainedPolicy })
  })

  it('rejects an Agency account absent from the Stream, without matching a colliding Stream ID', async () => {
    const codingLines = [{ ...context().codingLines[0]!, codingLineId: '10', agencyChartOfAccountId: '999' }, context().codingLines[1]!]
    for (const retainedPolicy of [undefined, { version: 1, kind: 'receivable', currency: 'cad', fiscalYearId: '2026', lines: [{ codingLineId: '10', percentage: '50' }, { codingLineId: '20', percentage: '50' }] }]) {
      await expect(allocator(context({ codingLines, retainedPolicy }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    }
  })

  it('rejects ambiguous Stream selections for a configured Agency account', async () => {
    const codingLines = [...context().codingLines, { ...context().codingLines[0]!, codingLineId: '100' }]
    await expect(allocator(context({ codingLines }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

})
