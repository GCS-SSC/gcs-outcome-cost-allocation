import { describe, expect, it } from 'vitest'
import type { GcsExtensionConfigurationGuardContext } from '@gcs-ssc/extensions/server'
import { guardAgencyCodingConfiguration } from '../../server/agency-coding-configuration'

const context = (config: GcsExtensionConfigurationGuardContext['config']): GcsExtensionConfigurationGuardContext => ({
  extensionKey: 'gcs-outcome-cost-allocation', targetExtensionKey: 'gcs-outcome-cost-allocation', event: {}, db: {} as GcsExtensionConfigurationGuardContext['db'], scope: 'agency', agencyId: '1', enabled: true, codingAccounts: { list: async () => [{ codingLineId: '10', agencyChartOfAccountId: '10', agencyFiscalYearId: '1', accountingDimensions: [] }] }, config
})
const set = { fiscalYearId: '1', currency: 'cad', lines: [{ codingLineId: '10', percentage: '100' }] }
const rule = { commitmentCodingLineId: '10', currency: 'cad', startDate: '2026-01-01', endDate: '2026-12-31', lines: set.lines }
describe('Agency configuration guard', () => {
  it('permits future years, adjacent inclusive ranges and unused gaps', async () => {
    await expect(guardAgencyCodingConfiguration(context({ version: 1, receivableSets: [set], creditMemoRules: [rule, { ...rule, startDate: '2027-01-01', endDate: '2027-12-31' }, { ...rule, startDate: '2029-01-01', endDate: '2029-12-31' }] }))).resolves.toBeUndefined()
    await expect(guardAgencyCodingConfiguration(context({}))).resolves.toBeUndefined()
  })
  it.each([
    { receivableSets: [set, set] },
    { receivableSets: [{ ...set, fiscalYearId: '9223372036854775808' }] },
    { receivableSets: [{ ...set, lines: [{ codingLineId: '10', percentage: '60' }, { codingLineId: '10', percentage: '40' }] }] },
    { receivableSets: [{ ...set, lines: [{ codingLineId: '10', percentage: '100.0001' }] }] },
    { receivableSets: [{ ...set, lines: [] }] },
    { receivableSets: [{ ...set, lines: [{ codingLineId: '10', percentage: '0' }] }] },
    { creditMemoRules: [rule, { ...rule, startDate: '2026-12-31', endDate: '2027-01-01' }] },
    { creditMemoRules: [{ ...rule, startDate: '2027-01-01' }] },
    { creditMemoRules: [{ ...rule, endDate: '2026-02-30' }] },
    { creditMemoRules: [{ ...rule, commitmentCodingLineId: undefined }] }
  ])('rejects invalid authored policy %#', async config => {
    await expect(guardAgencyCodingConfiguration(context(JSON.parse(JSON.stringify(config))))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })
  it('validates active Agency catalogue eligibility at save and fails closed when the scoped service is missing', async () => {
    await expect(guardAgencyCodingConfiguration({ ...context({ receivableSets: [set] }), codingAccounts: { list: async () => [] } })).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    await expect(guardAgencyCodingConfiguration({ ...context({ creditMemoRules: [rule] }), codingAccounts: undefined })).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    await expect(guardAgencyCodingConfiguration({ ...context({ receivableSets: [set] }), codingAccounts: undefined })).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    await expect(guardAgencyCodingConfiguration({ ...context({ creditMemoRules: [rule] }), codingAccounts: { list: async () => [] } })).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

  it('requires an eligible source Commitment account even when all destinations are eligible', async () => {
    await expect(guardAgencyCodingConfiguration({ ...context({ creditMemoRules: [rule] }), codingAccounts: {
      list: async input => input.kind === 'commitment' ? [] : [{ codingLineId: '10', agencyChartOfAccountId: '10', agencyFiscalYearId: '1', accountingDimensions: [] }]
    } })).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

  it('requires 100% of each remapped source and permits overlapping dates for different sources', async () => {
    await expect(guardAgencyCodingConfiguration(context({ creditMemoRules: [{ ...rule, lines: [{ codingLineId: '10', percentage: '30' }] }] }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    await expect(guardAgencyCodingConfiguration({ ...context({ creditMemoRules: [rule, { ...rule, commitmentCodingLineId: '20' }] }), codingAccounts: {
      list: async () => ['10', '20'].map(codingLineId => ({ codingLineId, agencyChartOfAccountId: codingLineId, agencyFiscalYearId: '1', accountingDimensions: [] }))
    } })).resolves.toBeUndefined()
  })

  it('does not interfere with other extension/stream configuration or disabling', async () => {
    for (const overrides of [{ targetExtensionKey: 'other' }, { scope: 'stream' as const }, { enabled: false }]) {
      await expect(guardAgencyCodingConfiguration({ ...context({ version: 2 }), ...overrides })).resolves.toBeUndefined()
    }
  })
})
