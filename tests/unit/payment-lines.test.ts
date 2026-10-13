import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, sql, type Transaction } from 'kysely'
import { KyselyPGlite } from 'kysely-pglite'
import type { GcsCodingAllocatorContext } from '@gcs-ssc/extensions/server'
import allocator from '../../server/allocator'
import type { OutcomeCostAllocationHostDatabase } from '../../server/db'

let db: Kysely<OutcomeCostAllocationHostDatabase>
const setWeights = async (weights: Array<{ codingLineId: string; amount: string }>, fiscalYearId = '6') => {
  await sql`DELETE FROM extensions.gcs_outcome_cost_allocation_allocations`.execute(db)
  for (const line of weights) {
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_allocations
      (allocation_version_id, agreement_id, commitment_type, agreement_budget_fiscal_year_id, stream_commitment_id, resolved_amount)
      VALUES (1, 1, 5, ${fiscalYearId}::bigint, ${line.codingLineId}::bigint, ${line.amount}::numeric)`.execute(db)
  }
}

const context = (amount: string, capacities: Array<{ codingLineId: string; amount: string }>): GcsCodingAllocatorContext => ({
  db: db as unknown as Transaction<unknown>,
  agreementId: '1', agencyId: '2', streamId: '3', amount, currency: 'usd',
  output: { kind: 'payment', commitmentId: '4', commitmentTypeId: '5', fiscalYearId: '6' },
  codingLines: capacities.map(line => ({ codingLineId: line.codingLineId, agencyChartOfAccountId: line.codingLineId, agencyFiscalYearId: '7', accountingDimensions: [] })),
  commitmentCodingLines: [], existingLines: [], codingPaidFloors: [], codingAvailableAmounts: capacities,
  config: { enabledCommitmentTypes: ['5'], mappings: [] }, agencyConfig: {}
})

describe('host-managed outcome payment allocation', () => {
  beforeAll(async () => {
    const pg = await KyselyPGlite.create('memory://', { parsers: { 20: String } })
    db = new Kysely({ dialect: pg.dialect })
    await sql`CREATE SCHEMA extensions`.execute(db)
    await sql`CREATE TABLE extensions.kv_entry (id bigserial PRIMARY KEY, extension_key text, owner_type text,
      owner_id text, config_key text, value jsonb, _deleted boolean DEFAULT false)`.execute(db)
    await sql`CREATE TABLE extensions.gcs_outcome_cost_allocation_versions
      (id bigint PRIMARY KEY, agreement_id bigint, status text, _deleted boolean DEFAULT false)`.execute(db)
    await sql`CREATE TABLE extensions.gcs_outcome_cost_allocation_allocations (id bigserial PRIMARY KEY,
      allocation_version_id bigint, agreement_id bigint, commitment_type bigint, agreement_budget_fiscal_year_id bigint,
      stream_commitment_id bigint, resolved_amount numeric(19,2), _deleted boolean DEFAULT false)`.execute(db)
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_versions VALUES (1, 1, 'active', false)`.execute(db)
    await sql`INSERT INTO extensions.kv_entry (extension_key, owner_type, owner_id, config_key, value)
      VALUES ('gcs-outcome-cost-allocation', 'fundingcaseagreementcommitment', '4', 'allocation-version', '{"versionId":"1"}')`.execute(db)
  })
  beforeEach(async () => { await setWeights([{ codingLineId: '11', amount: '75.00' }, { codingLineId: '12', amount: '25.00' }]) })
  afterAll(async () => { await db.destroy() })

  it('uses pinned matrix weights and caps an unevenly depleted code at its host capacity', async () => {
    const input = context('50.00', [{ codingLineId: '11', amount: '15.00' }, { codingLineId: '12', amount: '85.00' }])
    input.existingLines = [
      { id: '21', codingLineId: '11', amount: '75.00', paidAmount: '60.00' },
      { id: '22', codingLineId: '12', amount: '100.00', paidAmount: '15.00' }
    ]
    expect(await allocator(input)).toEqual([{ codingLineId: '11', amount: '15.00' }, { codingLineId: '12', amount: '35.00' }])
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
    await sql`UPDATE extensions.gcs_outcome_cost_allocation_allocations
      SET agreement_budget_fiscal_year_id = 8 WHERE stream_commitment_id = 12`.execute(db)
    const input = context('10.00', [{ codingLineId: '11', amount: '20.00' }])
    input.codingAvailableAmounts.push({ codingLineId: '12', amount: '100.00' })
    expect(await allocator(input)).toEqual([{ codingLineId: '11', amount: '10.00' }])
  })
  it('balances a residual cent and rejects a payment exceeding remaining capacity', async () => {
    await setWeights([{ codingLineId: '11', amount: '50.00' }, { codingLineId: '12', amount: '50.00' }])
    expect(await allocator(context('0.01', [{ codingLineId: '11', amount: '50.00' }, { codingLineId: '12', amount: '50.00' }]))).toEqual([{ codingLineId: '12', amount: '0.01' }])
    await setWeights([{ codingLineId: '11', amount: '100.00' }])
    await expect(allocator(context('100.01', [{ codingLineId: '11', amount: '100.00' }]))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING' })
  })
  it('spreads residual cents instead of concentrating rounding drift on the last code', async () => {
    const capacities = Array.from({ length: 101 }, (_, index) => ({ codingLineId: String(index + 1), amount: '1.00' }))
    await setWeights(capacities)
    const split = await allocator(context('50.00', capacities))
    expect(split).toHaveLength(101)
    if (!Array.isArray(split)) throw new Error('Expected payment allocation lines.')
    expect(split.filter(line => line.amount === '0.50')).toHaveLength(51)
    expect(split.filter(line => line.amount === '0.49')).toHaveLength(50)
    expect(await allocator(context('50.00', [...capacities].reverse()))).toEqual(split)
  })
})
