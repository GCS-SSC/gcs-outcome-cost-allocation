import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, sql } from 'kysely'
import { KyselyPGlite } from 'kysely-pglite'
import { getActiveStreamCommitmentBudgetIds, getAgreementBudgetYears, getStreamCommitmentLines } from '../../server/allocation-data'
import { asOutcomeCostAllocationDb } from '../../server/db'
import { createNativeFundingSourceFixture } from '../fixtures/native-funding'

describe('Outcome allocation native source contracts', () => {
  let db: Kysely<Record<string, Record<string, unknown>>>
  beforeEach(async () => {
    const pg = await KyselyPGlite.create('memory://', { parsers: { 20: String } })
    db = new Kysely({ dialect: pg.dialect })
    await createNativeFundingSourceFixture(db)
  })
  afterEach(async () => { await db.destroy() })

  it('does not multiply CAD funding by the two Program currencies in the same fiscal year', async () => {
    expect(await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')).toMatchObject([
      { id: '10', program_funding: '125.55', currency: 'cad', stream_budget_id: '301' }
    ])
    expect(await getActiveStreamCommitmentBudgetIds(asOutcomeCostAllocationDb(db), '2')).toEqual(new Map([['501', '301'], ['502', '302']]))
    expect(await getStreamCommitmentLines(asOutcomeCostAllocationDb(db), '2')).toMatchObject([
      { id: '501', currency: 'cad', stream_budget_id: '301' }, { id: '502', currency: 'usd', stream_budget_id: '302' }
    ])
  })

  it('retains exact USD funding and selects only the matching native fiscal budget', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency='usd'`.execute(db)
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item" SET egcs_fc_currency='usd'`.execute(db)
    expect(await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')).toMatchObject([
      { id: '10', program_funding: '125.55', currency: 'usd', stream_budget_id: '302' }
    ])
  })

  it('explicitly rejects a mixed native allocation funding basis instead of combining CAD and USD', async () => {
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (102,10,84.46,'usd',false)`.execute(db)
    await expect(getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2'))
      .rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_MIXED_CURRENCY_UNSUPPORTED' })
  })

  it('rejects a foreign-only funding line even when its currency is internally consistent', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item" SET egcs_fc_currency='usd'`.execute(db)
    await expect(getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2'))
      .rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH' })
  })

  it('uses the stored USD Agreement denomination when every funding line is absent', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency='usd'`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item"`.execute(db)
    expect(await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')).toMatchObject([
      { id: '10', program_funding: '0.00', currency: 'usd', stream_budget_id: '302' }
    ])
  })

  it('fails closed for an absent owning Agreement', async () => {
    await sql`DELETE FROM "Funding_Case_Agreement_Profile"`.execute(db)
    await expect(getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2'))
      .rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH' })
  })

  it('ignores deleted foreign-currency source rows', async () => {
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (102,10,84.46,'usd',true)`.execute(db)
    expect(await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')).toMatchObject([{ program_funding: '125.55', currency: 'cad' }])
  })

  it('keeps an empty fiscal year mapped in the supported Agreement native currency', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency='usd'`.execute(db)
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item" SET egcs_fc_currency='usd'`.execute(db)
    await sql`INSERT INTO "Agency_Fiscal_Year" VALUES (2,2027,'2027–2028',false)`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" VALUES (11,NULL,1,1,2,false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" VALUES (203,1,2,'cad',false),(204,1,2,'usd',false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Stream_Budget" VALUES (303,203,2,false),(304,204,2,false)`.execute(db)
    expect(await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')).toMatchObject([
      { id: '10', program_funding: '125.55', currency: 'usd', stream_budget_id: '302' },
      { id: '11', program_funding: '0.00', currency: 'usd', stream_budget_id: '304' }
    ])
  })
})
