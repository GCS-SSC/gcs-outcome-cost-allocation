import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { getActiveStreamCommitmentBudgetIds, getAgreementBudgetYears, getStreamCommitmentLines } from '../../server/allocation-data'
import { asOutcomeCostAllocationDb } from '../../server/db'
import { createNativeFundingSourceFixture } from '../fixtures/native-funding'

const postgresUrl = process.env.OUTCOME_ALLOCATION_POSTGRES_TEST_URL
const schemaName = `outcome_native_currency_${process.pid}`
const createDb = (scoped = true) => {
  if (!postgresUrl || !new URL(postgresUrl).pathname.endsWith('_test')) throw new Error('A disposable OUTCOME_ALLOCATION_POSTGRES_TEST_URL *_test database is required.')
  return new Kysely<Record<string, Record<string, unknown>>>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: postgresUrl, max: 1, ...(scoped ? { options: `-c search_path=${schemaName},public` } : {})
  }) }) })
}

describe('Outcome allocation PostgreSQL native source contracts', () => {
  let admin: ReturnType<typeof createDb>
  let db: ReturnType<typeof createDb>
  const report: Array<Record<string, string>> = []
  beforeAll(() => { admin = createDb(false); db = createDb() })
  beforeEach(async () => {
    await admin.schema.dropSchema(schemaName).ifExists().cascade().execute()
    await admin.schema.createSchema(schemaName).execute()
    await createNativeFundingSourceFixture(db)
  })
  afterAll(async () => {
    const directory = process.env.GCS_PAYMENT_AUDIT_DIR
    if (directory && report.length) {
      await mkdir(directory, { recursive: true })
      const columns = [...new Set(report.flatMap(row => Object.keys(row)))]
      const cell = (value: string) => `"${value.replaceAll('"', '""')}"`
      await writeFile(join(directory, 'outcome-native-source-scenarios.csv'), [columns.map(cell).join(','),
        ...report.map(row => columns.map(column => cell(row[column] ?? '')).join(','))].join('\n') + '\n')
    }
    await db.destroy()
    await admin.schema.dropSchema(schemaName).ifExists().cascade().execute()
    await admin.destroy()
  })
  const capture = async (scenario: string, expected: string, actual: unknown) => {
    const sources = await sql`SELECT line.id::text, line.egcs_fc_programfunding::text AS program_funding, line.egcs_fc_currency AS currency,
      year.egcs_fc_fiscalyear::text AS fiscal_year_id, line._deleted AS deleted FROM "Funding_Case_Agreement_Budget_Line_Item" line
      JOIN "Funding_Case_Agreement_Budget_Fiscal_Year" year ON year.id=line.egcs_fc_fundingagreementbudgetfiscalyear ORDER BY line.id`.execute(db)
    report.push({ scenario_id: `outcome-native-${report.length + 1}`, scenario, test_layer: 'Outcome PostgreSQL native source SQL',
      expected, actual: JSON.stringify(actual), source_budget_lines: JSON.stringify(sources.rows), status: 'passed' })
  }

  it.each(['cad', 'usd'])('keeps %s funding exact when both native Program fiscal budgets exist', async currency => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency=${currency}`.execute(db)
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item" SET egcs_fc_currency=${currency}`.execute(db)
    const result = await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ program_funding: '125.55', currency, stream_budget_id: currency === 'cad' ? '301' : '302' })
    await capture(`${currency} funding and native fiscal budget`, `${currency.toUpperCase()}125.55, one native Stream budget`, result)
  })

  it('maps CAD and USD accounting lines independently to their same-year native Program budgets', async () => {
    const mappings = await getActiveStreamCommitmentBudgetIds(asOutcomeCostAllocationDb(db), '2')
    expect(mappings).toEqual(new Map([['501', '301'], ['502', '302']]))
    const lines = await getStreamCommitmentLines(asOutcomeCostAllocationDb(db), '2')
    expect(lines).toHaveLength(2)
    expect(lines).toMatchObject([{ id: '501', currency: 'cad', stream_budget_id: '301' }, { id: '502', currency: 'usd', stream_budget_id: '302' }])
    await capture('Same FY native chart mappings', 'CAD chart501→budget301; USD chart502→budget302', { mappings: [...mappings], lines })
  })

  it('rejects unsupported mixed funding without producing a scalar allocation basis', async () => {
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (102,10,84.46,'usd',false)`.execute(db)
    const result = await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2').then(
      years => ({ years }), error => ({ code: error.code, statusCode: error.statusCode })
    )
    expect(result).toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_MIXED_CURRENCY_UNSUPPORTED' })
    await capture('Invalid imported mixed CAD125.55/USD84.46 Agreement basis', 'Explicit MIXED_CURRENCY_UNSUPPORTED; no combined scalar', result)
  })

  it('rejects a foreign-only funding basis against the owning CAD Agreement', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item" SET egcs_fc_currency='usd'`.execute(db)
    const result = await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2').then(
      years => ({ years }), error => ({ code: error.code, statusCode: error.statusCode })
    )
    expect(result).toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH' })
    await capture('Invalid imported USD funding in CAD Agreement', 'Explicit CURRENCY_MISMATCH; no foreign native sum', result)
  })

  it('derives an empty funded year from the immutable USD Agreement currency', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency='usd'`.execute(db)
    await sql`DELETE FROM "Funding_Case_Agreement_Budget_Line_Item"`.execute(db)
    const result = await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')
    expect(result).toMatchObject([{ id: '10', program_funding: '0.00', currency: 'usd', stream_budget_id: '302' }])
    await capture('USD Agreement with no funding lines', 'USD0.00 and matching Stream budget302, never default CAD', result)
  })

  it('rejects an absent Agreement before accepting any funding source', async () => {
    await sql`DELETE FROM "Funding_Case_Agreement_Profile"`.execute(db)
    const result = await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2').then(
      years => ({ years }), error => ({ code: error.code, statusCode: error.statusCode })
    )
    expect(result).toMatchObject({ code: 'GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH' })
    await capture('Missing owning Agreement', 'Explicit CURRENCY_MISMATCH; no implicit CAD', result)
  })

  it('preserves a zero-funded year and selects its USD mapping without combining native limits', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET egcs_fc_currency='usd'`.execute(db)
    await sql`UPDATE "Funding_Case_Agreement_Budget_Line_Item" SET egcs_fc_currency='usd'`.execute(db)
    await sql`INSERT INTO "Agency_Fiscal_Year" VALUES (2,2027,'2027–2028',false)`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" VALUES (11,NULL,1,1,2,false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" VALUES (203,1,2,'cad',false),(204,1,2,'usd',false)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Stream_Budget" VALUES (303,203,2,false),(304,204,2,false)`.execute(db)
    const result = await getAgreementBudgetYears(asOutcomeCostAllocationDb(db), '1', '2')
    expect(result).toMatchObject([{ id: '10', program_funding: '125.55', currency: 'usd', stream_budget_id: '302' },
      { id: '11', program_funding: '0.00', currency: 'usd', stream_budget_id: '304' }])
    await capture('USD funded year plus empty future fiscal year', 'USD125.55 + USD0.00; budgets302/304', result)
  })
})
