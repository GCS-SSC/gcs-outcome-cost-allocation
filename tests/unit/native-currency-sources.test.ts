import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, sql } from 'kysely'
import { moneyFromMinorUnits } from '@gcs-ssc/extensions/money'
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
      { id: '10', program_funding: moneyFromMinorUnits('12555', 'CAD'), currency: 'cad', stream_budget_id: '301' }
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
      { id: '10', program_funding: moneyFromMinorUnits('12555', 'USD'), currency: 'usd', stream_budget_id: '302' }
    ])
  })

  it('explicitly rejects a mixed native allocation funding basis instead of combining CAD and USD', async () => {
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (102,10,8446,'usd',false)`.execute(db)
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
      { id: '10', program_funding: moneyFromMinorUnits('0', 'USD'), currency: 'usd', stream_budget_id: '302' }
    ])
  })

  it('fails closed for an absent owning Agreement', async () => {
    await sql`DELETE FROM "Funding_Case_Agreement_Profile"`.execute(db)
    await expect(getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2'))
      .rejects.toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH' })
  })

  it('ignores deleted foreign-currency source rows', async () => {
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (102,10,8446,'usd',true)`.execute(db)
    expect(await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')).toMatchObject([{ program_funding: moneyFromMinorUnits('12555', 'CAD'), currency: 'cad' }])
  })

  it('keeps an empty fiscal year mapped in the supported Agreement native currency', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency='usd'`.execute(db)
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item" SET egcs_fc_currency='usd'`.execute(db)
    await sql`INSERT INTO "Agency_Fiscal_Year" VALUES (2,2027,'2027–2028',false)`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" VALUES (11,NULL,1,1,2,false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" VALUES (203,1,2,'cad',false),(204,1,2,'usd',false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Stream_Budget" VALUES (303,203,2,false),(304,204,2,false)`.execute(db)
    expect(await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')).toMatchObject([
      { id: '10', program_funding: moneyFromMinorUnits('12555', 'USD'), currency: 'usd', stream_budget_id: '302' },
      { id: '11', program_funding: moneyFromMinorUnits('0', 'USD'), currency: 'usd', stream_budget_id: '304' }
    ])
  })

  it.each(['jpy', 'kwd', 'clf', 'mga'])('retains exact %s minor units above the safe number range', async currency => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency=${currency}`.execute(db)
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item"
      SET egcs_fc_currency=${currency}, egcs_fc_programfunding=9007199254740993`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item"
      VALUES (102,10,1,${currency},false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Fiscal_Year_Budget"
      VALUES (205,1,1,${currency},false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Stream_Budget" VALUES (305,205,2,false)`.execute(db)
    const years = await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')
    expect(years).toMatchObject([{ id: '10', currency, stream_budget_id: '305',
      program_funding: moneyFromMinorUnits('9007199254740994', currency) }])
  })

  it('rejects fractional and noncanonical minor units at the source database boundary', async () => {
    for (const invalid of ['0.1', '1.0', '1.001']) {
      await expect(sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item"
        SET egcs_fc_programfunding=CAST(${invalid} AS numeric)`.execute(db)).rejects.toMatchObject({ code: '23514' })
    }
  })

})
