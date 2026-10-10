import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, sql, type Transaction } from 'kysely'
import { KyselyPGlite } from 'kysely-pglite'
import type { GcsCodingAllocatorContext } from '@gcs-ssc/extensions/server'
import allocator from '../../server/allocator'
import type { OutcomeCostAllocationHostDatabase } from '../../server/db'

let db: Kysely<OutcomeCostAllocationHostDatabase>
const coding = (id: string) => ({ codingLineId: id, agencyChartOfAccountId: id, agencyFiscalYearId: '2026', accountingDimensions: [] })
const context = (overrides: Partial<GcsCodingAllocatorContext> = {}): GcsCodingAllocatorContext => ({
  db: db as unknown as Transaction<unknown>, agreementId: '1', agencyId: '1', streamId: '1', currency: 'cad', amount: '100.00',
  output: { kind: 'commitment', commitmentTypeId: '1' }, codingLines: [coding('10'), coding('20')],
  commitmentCodingLines: [coding('10'), coding('20')], existingLines: [], codingPaidFloors: [], codingAvailableAmounts: [],
  config: { enabledCommitmentTypes: ['1'], mappings: [] }, agencyConfig: {}, ...overrides
})

describe('host-interface outcome allocator', () => {
  beforeAll(async () => {
    const pg = await KyselyPGlite.create('memory://', { parsers: { 20: String } })
    db = new Kysely({ dialect: pg.dialect })
    await sql`CREATE SCHEMA extensions`.execute(db)
    await sql`CREATE TABLE extensions.gcs_outcome_cost_allocation_versions (
      id bigint PRIMARY KEY, agreement_id bigint, status text, _deleted boolean DEFAULT false
    )`.execute(db)
    await sql`CREATE TABLE extensions.gcs_outcome_cost_allocation_allocations (
      id bigserial PRIMARY KEY, allocation_version_id bigint, agreement_id bigint,
      commitment_type bigint, stream_commitment_id bigint, resolved_amount numeric(19,2), _deleted boolean DEFAULT false
    )`.execute(db)
  })
  beforeEach(async () => {
    await sql`TRUNCATE extensions.gcs_outcome_cost_allocation_allocations, extensions.gcs_outcome_cost_allocation_versions`.execute(db)
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_versions (id, agreement_id, status) VALUES (1, 1, 'active'), (2, 1, 'inactive'), (3, 2, 'active')`.execute(db)
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_allocations
      (allocation_version_id, agreement_id, commitment_type, stream_commitment_id, resolved_amount)
      VALUES (1, 1, 1, 10, 75), (1, 1, 1, 20, 25), (2, 1, 1, 10, 900), (3, 2, 1, 20, 900)`.execute(db)
  })
  afterAll(async () => { await db.destroy() })

  it('reads only the active owning snapshot and splits the declared total', async () => {
    expect(await allocator(context({ amount: '40.00' }))).toEqual([
      { codingLineId: '10', amount: '30.00' }, { codingLineId: '20', amount: '10.00' }
    ])
  })

  it('adds paid floors to a new split of unpaid funds rather than targeting cumulative percentages', async () => {
    expect(await allocator(context({ existingLines: [{ id: '1', codingLineId: '20', amount: '50.00', paidAmount: '20.00' }] }))).toEqual([
      { codingLineId: '20', amount: '40.00' }, { codingLineId: '10', amount: '60.00' }
    ])
  })

  it('groups duplicate outcome codes and takes the shared paid floor once', async () => {
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_allocations
      (allocation_version_id, agreement_id, commitment_type, stream_commitment_id, resolved_amount)
      VALUES (1, 1, 1, 10, 25)`.execute(db)
    expect(await allocator(context({ amount: '125.00',
      existingLines: [{ id: '1', codingLineId: '10', amount: '40.00', paidAmount: '10.00' },
        { id: '2', codingLineId: '10', amount: '40.00', paidAmount: '15.00' }],
      codingPaidFloors: [{ codingLineId: '10', paidAmount: '50.00' }]
    }))).toEqual([{ codingLineId: '10', amount: '110.00' }, { codingLineId: '20', amount: '15.00' }])
  })

  it('retains already paid coding even when its new weight is zero', async () => {
    await sql`UPDATE extensions.gcs_outcome_cost_allocation_allocations SET resolved_amount = 0 WHERE stream_commitment_id = 20`.execute(db)
    expect(await allocator(context({ codingPaidFloors: [{ codingLineId: '20', paidAmount: '30.00' }] }))).toEqual([
      { codingLineId: '20', amount: '30.00' }, { codingLineId: '10', amount: '70.00' }
    ])
  })

  it('drops old unselected zero coding rather than returning a retired catalog identity', async () => {
    expect(await allocator(context({ existingLines: [{ id: '1', codingLineId: 'retired', amount: '0.00', paidAmount: '0.00' }] })))
      .toEqual([{ codingLineId: '10', amount: '75.00' }, { codingLineId: '20', amount: '25.00' }])
  })

  it('rejects a declared total below preserved paid amounts', async () => {
    await expect(allocator(context({ amount: '19.99', codingPaidFloors: [{ codingLineId: '20', paidAmount: '20.00' }] })))
      .rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE' })
  })

  it('keeps selected zero coding when the declared total is zero', async () => {
    expect(await allocator(context({ amount: '0.00' }))).toEqual([
      { codingLineId: '10', amount: '0.00' }, { codingLineId: '20', amount: '0.00' }
    ])
  })

  it('uses the active host transaction without writing allocation evidence', async () => {
    await expect(db.transaction().execute(async trx => {
      await sql`UPDATE extensions.gcs_outcome_cost_allocation_allocations SET resolved_amount = 25 WHERE stream_commitment_id = 10`.execute(trx)
      expect(await allocator(context({ db: trx as unknown as Transaction<unknown> }))).toEqual([
        { codingLineId: '10', amount: '50.00' }, { codingLineId: '20', amount: '50.00' }
      ])
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await allocator(context())).toEqual([{ codingLineId: '10', amount: '75.00' }, { codingLineId: '20', amount: '25.00' }])
  })

  it.each(['receivable', 'credit-memo'] as const)('defers %s to manual coding', async kind => {
    expect(await allocator(context({ output: { kind } }))).toBeNull()
  })
  it('defers unmanaged types without reading a snapshot', async () => {
    expect(await allocator(context({ output: { kind: 'commitment', commitmentTypeId: '2' } }))).toBeNull()
  })
  it('rejects a missing active snapshot and foreign or retired coding', async () => {
    await expect(allocator(context({ codingLines: [coding('10')] }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE' })
    await expect(allocator(context({ agreementId: '3' }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED' })
  })
  it('rejects an incomplete snapshot and missing or zero weights for unpaid money', async () => {
    await sql`UPDATE extensions.gcs_outcome_cost_allocation_allocations SET resolved_amount = NULL WHERE allocation_version_id = 1`.execute(db)
    await expect(allocator(context())).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID' })
    await sql`UPDATE extensions.gcs_outcome_cost_allocation_allocations SET resolved_amount = 0 WHERE allocation_version_id = 1`.execute(db)
    await expect(allocator(context())).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING' })
    await sql`DELETE FROM extensions.gcs_outcome_cost_allocation_allocations WHERE allocation_version_id = 1`.execute(db)
    await expect(allocator(context())).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING' })
  })

  const payment = (overrides: Partial<GcsCodingAllocatorContext> = {}) => context({
    output: { kind: 'payment', commitmentId: '1', commitmentTypeId: '1', fiscalYearId: '2026' }, ...overrides
  })
  it('weights payments by unpaid balances instead of the original 75/25 split', async () => {
    expect(await allocator(payment({ amount: '50.00', codingAvailableAmounts: [
      { codingLineId: '10', amount: '75.00' }, { codingLineId: '20', amount: '10.00' }
    ] }))).toEqual([{ codingLineId: '10', amount: '44.12' }, { codingLineId: '20', amount: '5.88' }])
  })
  it('pays exact remaining capacity, excludes other fiscal years, and rejects a cent overrun', async () => {
    const input = payment({ amount: '85.00', codingAvailableAmounts: [
      { codingLineId: '10', amount: '75.00' }, { codingLineId: '20', amount: '10.00' }, { codingLineId: '30', amount: '999.00' }
    ] })
    expect(await allocator(input)).toEqual([{ codingLineId: '10', amount: '75.00' }, { codingLineId: '20', amount: '10.00' }])
    await expect(allocator({ ...input, amount: '85.01' })).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING' })
  })
  it('balances fractional cents and large exact strings', async () => {
    expect(await allocator(payment({ amount: '0.01', codingAvailableAmounts: [
      { codingLineId: '10', amount: '1.00' }, { codingLineId: '20', amount: '1.00' }
    ] }))).toEqual([{ codingLineId: '20', amount: '0.01' }])
    expect(await allocator(payment({ amount: '900719925474099.91', codingAvailableAmounts: [
      { codingLineId: '10', amount: '900719925474099.91' }
    ] }))).toEqual([{ codingLineId: '10', amount: '900719925474099.91' }])
  })
})
