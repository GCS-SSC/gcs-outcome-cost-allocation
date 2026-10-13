import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, sql, type Transaction } from 'kysely'
import { KyselyPGlite } from 'kysely-pglite'
import type { GcsCodingAllocatorContext } from '@gcs-ssc/extensions/server'
import allocator from '../../server/allocator'
import type { OutcomeCostAllocationHostDatabase } from '../../server/db'

let db: Kysely<OutcomeCostAllocationHostDatabase>
const account = (codingLineId: string, agencyChartOfAccountId = codingLineId, commitmentChartOfAccountId: string | null = null) => ({
  codingLineId, agencyChartOfAccountId, agencyFiscalYearId: '41', accountingDimensions: [], commitmentChartOfAccountId
})
const context = (overrides: Partial<GcsCodingAllocatorContext> = {}): GcsCodingAllocatorContext => ({
  db: db as unknown as Transaction<unknown>, agreementId: '1', agencyId: '1', streamId: '1', currency: 'cad', amount: '100.00',
  output: { kind: 'credit-memo', effectiveDate: '2026-07-01', activeCommitments: [
    { commitmentId: '300', commitmentTypeId: '99' }, { commitmentId: '200', commitmentTypeId: '1' }, { commitmentId: '100', commitmentTypeId: '1' }
  ] },
  codingLines: [account('11', '11', '85'), account('22', '22', '86'), account('98'), account('99')],
  commitmentCodingLines: [account('10', '85'), account('20', '86')], existingLines: [], codingPaidFloors: [], codingAvailableAmounts: [],
  config: { enabledCommitmentTypes: ['1'], mappings: [] }, agencyConfig: {}, ...overrides
})
const overrides = (lines = [{ codingLineId: '98', percentage: '30' }, { codingLineId: '99', percentage: '70' }]) => ({
  creditMemoRules: [{ commitmentCodingLineId: '85', currency: 'cad', startDate: '2026-07-01', endDate: '2026-12-31', lines }]
})
const policy = { version: 2, kind: 'credit-memo', currency: 'cad', effectiveDate: '2026-07-01', commitmentId: '200', allocationVersionId: '2',
  lines: [{ codingLineId: '11', weight: '7500000000' }, { codingLineId: '22', weight: '2500000000' }] }

describe('credit memo allocation from the latest committed matrix', () => {
  beforeAll(async () => {
    const pg = await KyselyPGlite.create('memory://', { parsers: { 20: String } })
    db = new Kysely({ dialect: pg.dialect })
    await sql`CREATE SCHEMA extensions`.execute(db)
    await sql`CREATE TABLE extensions.kv_entry (id bigserial primary key, extension_key text, owner_type text, owner_id text, config_key text, value jsonb, _deleted boolean DEFAULT false)`.execute(db)
    await sql`CREATE TABLE extensions.gcs_outcome_cost_allocation_versions (id bigint PRIMARY KEY, agreement_id bigint, status text, _deleted boolean DEFAULT false)`.execute(db)
    await sql`CREATE TABLE extensions.gcs_outcome_cost_allocation_allocations (id bigserial PRIMARY KEY, allocation_version_id bigint,
      agreement_id bigint, commitment_type bigint, stream_commitment_id bigint, resolved_amount numeric(19,2), _deleted boolean DEFAULT false)`.execute(db)
  })
  beforeEach(async () => {
    await sql`TRUNCATE extensions.kv_entry, extensions.gcs_outcome_cost_allocation_allocations, extensions.gcs_outcome_cost_allocation_versions`.execute(db)
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_versions (id,agreement_id,status) VALUES (1,1,'active'),(2,1,'inactive'),(3,2,'active'),(4,1,'draft')`.execute(db)
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_allocations (allocation_version_id,agreement_id,commitment_type,stream_commitment_id,resolved_amount)
      VALUES (1,1,1,10,10),(1,1,1,20,90),(2,1,1,10,75),(2,1,1,20,25),(2,1,99,10,500),(3,2,1,10,500)`.execute(db)
    await sql`INSERT INTO extensions.kv_entry (extension_key,owner_type,owner_id,config_key,value)
      VALUES ('gcs-outcome-cost-allocation','fundingcaseagreementcommitment','200','allocation-version','{"versionId":"2"}'),
        ('gcs-outcome-cost-allocation','fundingcaseagreementcommitment','100','allocation-version','{"versionId":"1"}')`.execute(db)
  })
  afterAll(async () => db.destroy())

  it('uses the newest managed committed pin even when its matrix is inactive and another matrix is active', async () => {
    expect(await allocator(context())).toEqual({ lines: [{ codingLineId: '11', amount: '75.00' }, { codingLineId: '22', amount: '25.00' }], policy })
    await sql`UPDATE extensions.gcs_outcome_cost_allocation_versions SET status='inactive' WHERE id=1`.execute(db)
    expect(await allocator(context())).toMatchObject({ policy: { commitmentId: '200', allocationVersionId: '2' } })
  })

  it('uses resolved whole-dollar amounts and groups duplicate outcome rows before deriving proportions', async () => {
    await sql`INSERT INTO extensions.gcs_outcome_cost_allocation_allocations (allocation_version_id,agreement_id,commitment_type,stream_commitment_id,resolved_amount)
      VALUES (2,1,1,10,25),(2,1,1,20,0)`.execute(db)
    expect(await allocator(context({ amount: '1.25' }))).toMatchObject({ lines: [{ codingLineId: '11', amount: '1.00' }, { codingLineId: '22', amount: '0.25' }] })
  })

  it('applies 30/70 overrides to only the source account’s share without a target link or matching coding year', async () => {
    const input = context({ agencyConfig: overrides() })
    input.codingLines = input.codingLines.map(line => line.codingLineId === '98' ? { ...line, agencyFiscalYearId: '99' } : line)
    expect(await allocator(input)).toMatchObject({ lines: [{ codingLineId: '22', amount: '25.00' }, { codingLineId: '98', amount: '22.50' }, { codingLineId: '99', amount: '52.50' }] })
  })

  it.each(['2026-07-01', '2026-12-31'])('includes both override date boundaries: %s', async effectiveDate => {
    expect(await allocator(context({ output: { kind: 'credit-memo', effectiveDate, activeCommitments: [{ commitmentId: '200', commitmentTypeId: '1' }] }, agencyConfig: overrides() })))
      .toMatchObject({ lines: [{ codingLineId: '22', amount: '25.00' }, { codingLineId: '98', amount: '22.50' }, { codingLineId: '99', amount: '52.50' }] })
  })

  it('falls back to linked accounts outside an override range, including gaps', async () => {
    expect(await allocator(context({ output: { kind: 'credit-memo', effectiveDate: '2027-01-01', activeCommitments: [{ commitmentId: '200', commitmentTypeId: '1' }] }, agencyConfig: overrides() })))
      .toMatchObject({ lines: [{ codingLineId: '11', amount: '75.00' }, { codingLineId: '22', amount: '25.00' }] })
  })

  it('aggregates targets shared by default and override coding', async () => {
    expect(await allocator(context({ agencyConfig: overrides([{ codingLineId: '22', percentage: '100' }]) })))
      .toMatchObject({ lines: [{ codingLineId: '22', amount: '100.00' }] })
  })

  it('balances the complete weighted vector once, avoiding nested rounding', async () => {
    await sql`UPDATE extensions.gcs_outcome_cost_allocation_allocations SET resolved_amount=50 WHERE allocation_version_id=2 AND commitment_type=1`.execute(db)
    expect(await allocator(context({ amount: '0.01', agencyConfig: overrides([{ codingLineId: '98', percentage: '50' }, { codingLineId: '99', percentage: '50' }]) })))
      .toMatchObject({ lines: [{ codingLineId: '22', amount: '0.01' }, { codingLineId: '98', amount: '0.00' }, { codingLineId: '99', amount: '0.00' }] })
    expect(await allocator(context({ amount: '0.00' }))).toMatchObject({ lines: [{ codingLineId: '11', amount: '0.00' }, { codingLineId: '22', amount: '0.00' }] })
  })

  it('keeps maximum supported monetary amounts exact', async () => {
    expect(await allocator(context({ amount: '99999999999999999.99' })))
      .toMatchObject({ lines: [{ codingLineId: '11', amount: '74999999999999999.99' }, { codingLineId: '22', amount: '25000000000000000.00' }] })
  })

  it('retains captured proportions after matrix/configuration changes without querying live matrix storage', async () => {
    expect(await allocator(context({ db: {} as never, agencyConfig: { invalid: true }, retainedPolicy: policy, amount: '0.03' })))
      .toEqual({ lines: [{ codingLineId: '11', amount: '0.02' }, { codingLineId: '22', amount: '0.01' }], policy })
  })

  it('preserves legacy captured CM percentage policy for amount-only edits', async () => {
    const legacy = { version: 1, kind: 'credit-memo', currency: 'cad', effectiveDate: '2026-07-01', lines: [{ codingLineId: '11', percentage: '50' }, { codingLineId: '22', percentage: '50' }] }
    expect(await allocator(context({ db: {} as never, retainedPolicy: legacy, amount: '0.03' })))
      .toEqual({ lines: [{ codingLineId: '11', amount: '0.02' }, { codingLineId: '22', amount: '0.01' }], policy: legacy })
  })

  it.each([
    { ...policy, effectiveDate: '2026-06-30' }, { ...policy, currency: 'usd' }, { ...policy, kind: 'receivable' },
    { ...policy, lines: [{ codingLineId: '11', weight: '0' }] }, { ...policy, lines: [{ codingLineId: '123', weight: '1' }] },
    { ...policy, lines: [policy.lines[0], policy.lines[0]] }
  ])('rejects invalid, mismatched or unavailable captured policy: %j', async retainedPolicy => {
    await expect(allocator(context({ retainedPolicy }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

  it('errors when no committed managed Commitment exists instead of using an active uncommitted matrix', async () => {
    await expect(allocator(context({ output: { kind: 'credit-memo', effectiveDate: '2026-07-01', activeCommitments: [] } })))
      .rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

  it('does not fall back to another Commitment or active matrix when the newest eligible Commitment has no pin', async () => {
    await sql`DELETE FROM extensions.kv_entry WHERE owner_id='200'`.execute(db)
    await expect(allocator(context())).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

  it.each([null, { versionId: 2 }, { versionId: '3' }, { versionId: '4' }, { versionId: '999' },
    { versionId: '9223372036854775808' }, { versionId: '9999999999999999999' }])('rejects corrupt, foreign, draft, missing or overflowing pins: %j', async value => {
    await sql`UPDATE extensions.kv_entry SET value=${JSON.stringify(value)}::jsonb WHERE owner_id='200'`.execute(db)
    await expect(allocator(context())).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

  it('errors for missing and ambiguous default links but a dated override can resolve either', async () => {
    const missing = context({ codingLines: context().codingLines.filter(line => line.codingLineId !== '11') })
    await expect(allocator(missing)).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    expect(await allocator({ ...missing, agencyConfig: overrides() })).toMatchObject({ policy: { version: 2 } })
    const ambiguous = context({ codingLines: [...context().codingLines, account('12', '12', '85')] })
    await expect(allocator(ambiguous)).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    expect(await allocator({ ...ambiguous, agencyConfig: overrides() })).toMatchObject({ policy: { version: 2 } })
  })

  it('rejects an unavailable override target or invalid/overlapping percentages', async () => {
    for (const agencyConfig of [overrides([{ codingLineId: '123', percentage: '100' }]), overrides([{ codingLineId: '98', percentage: '99' }]),
      { creditMemoRules: [...overrides().creditMemoRules, ...overrides().creditMemoRules] }]) {
      await expect(allocator(context({ agencyConfig }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    }
  })

  it('rejects unavailable Commitment coding and unresolved, negative or zero-only matrix weights', async () => {
    await expect(allocator(context({ commitmentCodingLines: [] }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    for (const amount of [null, '-1', '0']) {
      await sql`UPDATE extensions.gcs_outcome_cost_allocation_allocations SET resolved_amount=${amount}::numeric WHERE allocation_version_id=2`.execute(db)
      await expect(allocator(context())).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    }
  })

  it('maps default and remap targets to Stream IDs while retaining exact Agency-keyed weights', async () => {
    const streamIds: Record<string, string> = { '11': '22', '22': '11', '98': '99', '99': '98' }
    const codingLines = context().codingLines.map(account => ({ ...account, codingLineId: streamIds[account.agencyChartOfAccountId]! }))
    expect(await allocator(context({ codingLines }))).toEqual({ lines: [{ codingLineId: '22', amount: '75.00' }, { codingLineId: '11', amount: '25.00' }], policy })
    expect(await allocator(context({ codingLines, agencyConfig: overrides() })))
      .toMatchObject({ lines: [{ codingLineId: '11', amount: '25.00' }, { codingLineId: '99', amount: '22.50' }, { codingLineId: '98', amount: '52.50' }], policy: { lines: [{ codingLineId: '22', weight: '2500000000' }, { codingLineId: '98', weight: '2250000000' }, { codingLineId: '99', weight: '5250000000' }] } })
    expect(await allocator(context({ db: {} as never, codingLines, retainedPolicy: policy, amount: '0.03' })))
      .toEqual({ lines: [{ codingLineId: '22', amount: '0.02' }, { codingLineId: '11', amount: '0.01' }], policy })
    const legacy = { version: 1, kind: 'credit-memo', currency: 'cad', effectiveDate: '2026-07-01', lines: [{ codingLineId: '11', percentage: '50' }, { codingLineId: '22', percentage: '50' }] }
    expect(await allocator(context({ db: {} as never, codingLines, retainedPolicy: legacy, amount: '0.03' })))
      .toEqual({ lines: [{ codingLineId: '22', amount: '0.02' }, { codingLineId: '11', amount: '0.01' }], policy: legacy })
  })

  it('rejects unavailable fresh and retained Agency targets even if their IDs match unrelated Stream selections', async () => {
    const codingLines = context().codingLines.map(account => account.agencyChartOfAccountId === '98' ? { ...account, agencyChartOfAccountId: '999' } : account)
    await expect(allocator(context({ codingLines, agencyConfig: overrides() }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    for (const retainedPolicy of [
      { ...policy, lines: [{ codingLineId: '98', weight: '1' }] },
      { version: 1, kind: 'credit-memo', currency: 'cad', effectiveDate: '2026-07-01', lines: [{ codingLineId: '98', percentage: '100' }] }
    ]) await expect(allocator(context({ db: {} as never, codingLines, retainedPolicy }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

  it('rejects ambiguous Stream selections for an override or retained target', async () => {
    const codingLines = [...context().codingLines, account('1000', '98')]
    await expect(allocator(context({ codingLines, agencyConfig: overrides() }))).rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
    await expect(allocator(context({ codingLines, retainedPolicy: { ...policy, lines: [{ codingLineId: '98', weight: '1' }] } })))
      .rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' })
  })

})
