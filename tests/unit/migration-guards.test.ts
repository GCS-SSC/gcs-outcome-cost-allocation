import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, sql, type Transaction } from 'kysely'
import { KyselyPGlite } from 'kysely-pglite'
import migration0001 from '../../server/migrations/0001_outcome_cost_allocation'
import migration0002 from '../../server/migrations/0002_versioned_allocations'
import migration0003 from '../../server/migrations/0003_scoped_allocations'

interface GuardTestDatabase {
  Funding_Case_Agreement_Profile: {
    id: string
    _deleted: boolean
  }
}

const expectGuardConstraint = async (
  operation: Promise<unknown>,
  constraint: string
) => {
  await expect(operation).rejects.toMatchObject({
    code: '23514',
    constraint
  })
}

const managedMutation = async <T>(
  db: Kysely<GuardTestDatabase>,
  agreementId: string,
  mutate: (trx: Transaction<GuardTestDatabase>) => Promise<T>
): Promise<T> => await db.transaction().execute(async trx => {
  await sql`
    SELECT extensions.gcs_outcome_cost_allocation_lock_agreement(
      ${agreementId}::bigint
    )
  `.execute(trx)
  return await mutate(trx)
})

describe('outcome allocation generated-record database guards', () => {
  let db: Kysely<GuardTestDatabase>
  let managedGuardDefinition = ''

  beforeAll(async () => {
    const pglite = await KyselyPGlite.create(`memory://outcome-allocation-guards-${Date.now()}`)
    db = new Kysely<GuardTestDatabase>({
      dialect: pglite.dialect
    })

    await sql`CREATE SCHEMA extensions`.execute(db)
    await sql`CREATE TABLE "Common_Entity_Type" (
        egcs_cn_type text PRIMARY KEY,
        _deleted boolean NOT NULL DEFAULT false
      )`.execute(db)
    await sql`INSERT INTO "Common_Entity_Type" (egcs_cn_type)
      VALUES ('gcs-outcome-cost-allocation:allocation-version')`.execute(db)
    await sql`CREATE TABLE "Common_Entity" (
        id bigserial PRIMARY KEY,
        egcs_cn_entitytype text NOT NULL,
        UNIQUE (id, egcs_cn_entitytype)
      )`.execute(db)
    await sql`CREATE OR REPLACE FUNCTION register_entity() RETURNS trigger AS $$
      BEGIN
        IF NEW.id IS NULL THEN NEW.id := nextval(pg_get_serial_sequence(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'id')); END IF;
        INSERT INTO "Common_Entity" (id, egcs_cn_entitytype) VALUES (NEW.id, TG_ARGV[0]);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`.execute(db)
    await sql`CREATE OR REPLACE FUNCTION trg_fn_soft_delete_entity_assignments() RETURNS trigger AS $$
      BEGIN RETURN NEW; END;
      $$ LANGUAGE plpgsql`.execute(db)
    await sql`CREATE TABLE "Common_Status" (
        id bigint PRIMARY KEY,
        egcs_cn_agency bigint NOT NULL,
        egcs_cn_isdraft boolean NOT NULL DEFAULT false,
        _deleted boolean NOT NULL DEFAULT false
      )`.execute(db)
    await sql`INSERT INTO "Common_Status" (id, egcs_cn_agency, egcs_cn_isdraft)
      VALUES (1, 1, true), (4, 1, false)`.execute(db)
    await sql`CREATE TABLE "Transfer_Payment_Profile" (
        id bigint PRIMARY KEY,
        egcs_tp_agency bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Profile" (id, egcs_tp_agency) VALUES (300, 1)`.execute(db)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Profile" (
        id bigint PRIMARY KEY,
        egcs_fc_transferpaymentstream bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Transfer_Payment_Stream" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentprofile bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Agency_Fiscal_Year" (
        id bigint PRIMARY KEY,
        egcs_ay_fiscalyeardisplay text NOT NULL,
        egcs_ay_fiscalyear integer NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Transfer_Payment_Fiscal_Year_Budget" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentprofile bigint NOT NULL,
        egcs_tp_fiscalyear bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Transfer_Payment_Stream_Budget" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentstream bigint NOT NULL,
        egcs_tp_transferpaymentbudget bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Transfer_Payment_Stream_Chart_of_Account" (
        id bigint PRIMARY KEY,
        egcs_tp_streambudget bigint NOT NULL,
        egcs_tp_transferpaymentstream bigint NOT NULL,
        egcs_tp_accountingdimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`CREATE TABLE "Transfer_Payment_Stream_Commitment_Type" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentstream bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )`.execute(db)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Budget_Version" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreement bigint NOT NULL,
        egcs_fc_iscurrent boolean NOT NULL DEFAULT false,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id uuid PRIMARY KEY,
        egcs_fc_fundingagreement bigint NOT NULL,
        egcs_fc_budgetversion bigint NOT NULL,
        egcs_fc_originalbudgetfiscalyear uuid,
        egcs_fc_fiscalyear bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Transfer_Payment_Outcome" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentprofile bigint NOT NULL,
        egcs_tp_name_en text NOT NULL,
        egcs_tp_name_fr text NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Commitment" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreement bigint NOT NULL,
        egcs_fc_type bigint NOT NULL,
        egcs_fc_status bigint NOT NULL,
        egcs_fc_financialsystemnumber bigint,
        egcs_fc_active boolean NOT NULL DEFAULT false,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Commitment_Line" (
        id bigserial PRIMARY KEY,
        egcs_fc_commitment bigint NOT NULL,
        egcs_fc_commitmentlinenumber smallint NOT NULL,
        egcs_fc_transferpaymentstreamchartofaccount bigint NOT NULL,
        egcs_fc_amount numeric(19, 2) NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Payment" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreementcommitment bigint NOT NULL,
        egcs_fc_fiscalyear uuid NOT NULL,
        egcs_fc_paymenttype text NOT NULL,
        egcs_fc_periodstart smallint NOT NULL,
        egcs_fc_periodend smallint NOT NULL,
        egcs_fc_paymentamount numeric(19, 2) NOT NULL,
        egcs_fc_comment text,
        egcs_fc_status bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Payment_Line" (
        id bigserial PRIMARY KEY,
        egcs_fc_fundingagreementpayment bigint NOT NULL,
        egcs_fc_fundingagreementcommitmentline bigint NOT NULL,
        egcs_fc_amount numeric(19, 2) NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(db)

    await migration0001.up(db)
    await migration0002.up(db)
    await migration0003.up(db)
    const guardFunction = await sql<{ definition: string }>`
      SELECT pg_get_functiondef(
        'extensions.gcs_outcome_cost_allocation_assert_managed_mutation(bigint)'::regprocedure
      ) AS definition
    `.execute(db)
    managedGuardDefinition = guardFunction.rows[0]?.definition ?? ''
    await sql`INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream) VALUES (1, 200)`.execute(db)
    await sql`INSERT INTO "Funding_Case_Agreement_Budget_Version" (id, egcs_fc_fundingagreement, egcs_fc_iscurrent) VALUES (2, 1, true)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Stream" (id, egcs_tp_transferpaymentprofile) VALUES (200, 300)`.execute(db)
    await sql`INSERT INTO "Transfer_Payment_Stream_Commitment_Type" (id, egcs_tp_transferpaymentstream) VALUES (1, 200)`.execute(db)
    await sql`
      INSERT INTO "Agency_Fiscal_Year" (
        id,
        egcs_ay_fiscalyeardisplay,
        egcs_ay_fiscalyear
      ) VALUES (400, '2026-2027', 2026)
    `.execute(db)
    await sql`
      INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_fiscalyear
      ) VALUES (500, 300, 400)
    `.execute(db)
    await sql`
      INSERT INTO "Transfer_Payment_Stream_Budget" (
        id,
        egcs_tp_transferpaymentstream,
        egcs_tp_transferpaymentbudget
      ) VALUES (100, 200, 500)
    `.execute(db)
    await sql`
      INSERT INTO "Transfer_Payment_Stream_Chart_of_Account" (
        id,
        egcs_tp_streambudget,
        egcs_tp_transferpaymentstream,
        egcs_tp_accountingdimensions
      ) VALUES (10, 100, 200, '[{"label_en":"G/L","label_fr":"G/L","value":"5000"}]'::jsonb)
    `.execute(db)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_budgetversion,
        egcs_fc_fiscalyear
      ) VALUES ('00000000-0000-4000-8000-000000000020', 1, 2, 400)
    `.execute(db)
    await sql`
      INSERT INTO "Transfer_Payment_Outcome" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_name_en,
        egcs_tp_name_fr
      ) VALUES (30, 300, 'Outcome', 'Resultat')
    `.execute(db)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Commitment" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_type,
        egcs_fc_status
      ) VALUES
        (40, 1, 1, 4),
        (41, 1, 1, 4),
        (42, 1, 1, 4),
        (43, 1, 1, 4)
    `.execute(db)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Commitment_Line" (
        id,
        egcs_fc_commitment,
        egcs_fc_commitmentlinenumber,
        egcs_fc_transferpaymentstreamchartofaccount,
        egcs_fc_amount
      ) VALUES
        (50, 40, 1, 10, 100),
        (51, 41, 1, 10, 100),
        (52, 42, 1, 10, 100),
        (53, 43, 1, 10, 99)
    `.execute(db)
    await managedMutation(db, '1', async trx => {
      await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
          id,
          agreement_id,
          version_number,
          status
        ) VALUES (60, 1, 1, 'draft')
      `.execute(trx)
      await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_allocations (
          allocation_version_id,
          agreement_id,
          commitment_type,
          stream_commitment_id,
          agreement_budget_fiscal_year_id,
          outcome_id,
          allocation_method,
          allocation_value,
          resolved_amount,
          funding_basis_amount,
          outcome_label_en,
          outcome_label_fr,
          commitment_label_en,
          commitment_label_fr,
          fiscal_year_display
        ) VALUES (
          60,
          1,
          '1',
          10,
          '00000000-0000-4000-8000-000000000020',
          30,
          'amount',
          100,
          100,
          100,
          'Outcome',
          'Resultat',
          'GL 5000 - Program',
          'GL 5000 - Program',
          '2026-2027'
        )
      `.execute(trx)
      await sql`
        UPDATE extensions.gcs_outcome_cost_allocation_versions
        SET status = 'active',
          completed_at = now(),
          funding_basis_amount = 100
        WHERE id = 60
      `.execute(trx)
      await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_commitment_lines (
          id,
          allocation_version_id,
          generated_commitment_id,
          commitment_line_id,
          agreement_id,
          agreement_budget_fiscal_year_id,
          outcome_id,
          stream_commitment_id,
          generated_amount,
          _deleted
        ) VALUES
          (90, 60, 40, 50, 1, '00000000-0000-4000-8000-000000000020', 30, 10, 100, false)
      `.execute(trx)
    })

    await sql`
      INSERT INTO "Funding_Case_Agreement_Payment" (
        id,
        egcs_fc_fundingagreementcommitment,
        egcs_fc_fiscalyear,
        egcs_fc_paymenttype,
        egcs_fc_periodstart,
        egcs_fc_periodend,
        egcs_fc_paymentamount,
        egcs_fc_status
      ) VALUES (71, 41, '00000000-0000-4000-8000-000000000020', 'advance', 0, 0, 25, 4)
    `.execute(db)
  })

  afterAll(async () => {
    await db.destroy()
  })

  it('applies the full migration chain with one stable coordinate index and advisory lock guard', async () => {
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'extensions'
        AND indexname IN (
          'gcs_outcome_cost_allocation_version_allocation',
          'gcs_outcome_cost_allocation_scoped_allocation'
        )
    `.execute(db)
    expect(indexes.rows).toEqual([{
      indexname: 'gcs_outcome_cost_allocation_version_allocation'
    }])
    expect(managedGuardDefinition).toContain('pg_locks')
    expect(managedGuardDefinition).toContain('compiled by emcc')
    expect(managedGuardDefinition).toContain('current_setting')
  })

  it('rejects negative allocations and percentages above one hundred at the database boundary', async () => {
    const insertInvalidAllocation = async (
      versionId: number,
      method: 'amount' | 'percentage',
      value: number
    ) => await managedMutation(db, '1', async trx => {
      await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
          id, agreement_id, version_number, status
        ) VALUES (${versionId}, 1, ${versionId}, 'draft')
      `.execute(trx)
      await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_allocations (
          allocation_version_id,
          agreement_id,
          commitment_type,
          stream_commitment_id,
          agreement_budget_fiscal_year_id,
          outcome_id,
          allocation_method,
          allocation_value
        ) VALUES (
          ${versionId},
          1,
          '1',
          10,
          '00000000-0000-4000-8000-000000000020',
          30,
          ${method},
          ${value}
        )
      `.execute(trx)
    })

    await expectGuardConstraint(
      insertInvalidAllocation(98, 'amount', -0.0001),
      'gcs_outcome_cost_allocation_value_range'
    )
    await expectGuardConstraint(
      insertInvalidAllocation(97, 'percentage', 100.0001),
      'gcs_outcome_cost_allocation_value_range'
    )
  })

  it('requires the managed agreement lock for valid PGlite mutations', async () => {
    await expectGuardConstraint(
      sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
          id,
          agreement_id,
          version_number,
          status
        ) VALUES (99, 1, 99, 'draft')
      `.execute(db),
      'gcs_outcome_cost_allocation_managed_mutation_guard'
    )

    await managedMutation(db, '1', async trx => await sql`
      INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
        id,
        agreement_id,
        version_number,
        status
      ) VALUES (99, 1, 99, 'draft')
    `.execute(trx))

    await managedMutation(db, '1', async trx => await sql`
      UPDATE extensions.gcs_outcome_cost_allocation_versions
      SET _deleted = true
      WHERE id = 99
    `.execute(trx))
  })

  it('blocks later generated commitment line writes and sensitive parent changes', async () => {
    await expectGuardConstraint(
      sql`
        INSERT INTO "Funding_Case_Agreement_Commitment_Line" (
          egcs_fc_commitment,
          egcs_fc_commitmentlinenumber,
          egcs_fc_transferpaymentstreamchartofaccount,
          egcs_fc_amount
        ) VALUES (40, 2, 10, 1)
      `.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Commitment_Line" SET egcs_fc_amount = 101 WHERE id = 50`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Commitment_Line" SET _deleted = true WHERE id = 50`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_line_guard'
    )
    await expectGuardConstraint(
      sql`DELETE FROM "Funding_Case_Agreement_Commitment_Line" WHERE id = 50`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Commitment" SET egcs_fc_type = '2' WHERE id = 40`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Commitment" SET _deleted = true WHERE id = 40`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_guard'
    )
    await expectGuardConstraint(
      sql`DELETE FROM "Funding_Case_Agreement_Commitment" WHERE id = 40`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_guard'
    )

    await expect(sql`
      UPDATE "Funding_Case_Agreement_Commitment"
      SET egcs_fc_status = 4,
        egcs_fc_active = true,
        egcs_fc_financialsystemnumber = 123
      WHERE id = 40
    `.execute(db)).resolves.toBeDefined()
  })

  it('allows initial draft payment lines and blocks every later generated-payment allocation change', async () => {
    await managedMutation(db, '1', async trx => {
      await sql`
        INSERT INTO "Funding_Case_Agreement_Payment" (
          id,
          egcs_fc_fundingagreementcommitment,
          egcs_fc_fiscalyear,
          egcs_fc_paymenttype,
          egcs_fc_periodstart,
          egcs_fc_periodend,
          egcs_fc_paymentamount,
          egcs_fc_status
        ) VALUES (70, 40, '00000000-0000-4000-8000-000000000020', 'advance', 0, 0, 25, 1)
      `.execute(trx)
      await sql`
        INSERT INTO "Funding_Case_Agreement_Payment_Line" (
          id,
          egcs_fc_fundingagreementpayment,
          egcs_fc_fundingagreementcommitmentline,
          egcs_fc_amount
        ) VALUES (80, 70, 50, 25)
      `.execute(trx)
      await sql`
        UPDATE "Funding_Case_Agreement_Payment"
        SET egcs_fc_status = 4,
          egcs_fc_comment = 'Generated'
        WHERE id = 70
      `.execute(trx)
    })

    await expectGuardConstraint(
      sql`
        INSERT INTO "Funding_Case_Agreement_Payment_Line" (
          egcs_fc_fundingagreementpayment,
          egcs_fc_fundingagreementcommitmentline,
          egcs_fc_amount
        ) VALUES (70, 50, 1)
      `.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment_Line" SET egcs_fc_amount = 20 WHERE id = 80`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_line_guard'
    )
    await expectGuardConstraint(
      sql`
        UPDATE "Funding_Case_Agreement_Payment_Line"
        SET egcs_fc_fundingagreementpayment = 71,
          egcs_fc_fundingagreementcommitmentline = 51,
          egcs_fc_amount = 20,
          _deleted = true
        WHERE id = 80
      `.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment_Line" SET _deleted = true WHERE id = 80`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_line_guard'
    )
    await expectGuardConstraint(
      sql`DELETE FROM "Funding_Case_Agreement_Payment_Line" WHERE id = 80`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment" SET egcs_fc_paymentamount = 20 WHERE id = 70`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment" SET _deleted = true WHERE id = 70`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_guard'
    )
    await expectGuardConstraint(
      sql`DELETE FROM "Funding_Case_Agreement_Payment" WHERE id = 70`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_guard'
    )

    await expect(sql`
      UPDATE "Funding_Case_Agreement_Payment"
      SET egcs_fc_status = 4,
        egcs_fc_comment = 'Workflow fields remain editable'
      WHERE id = 70
    `.execute(db)).resolves.toBeDefined()
  })

  it('requires generated payment lines to match provenance and exactly total the parent payment', async () => {
    await managedMutation(db, '1', async trx => await sql`
        INSERT INTO "Funding_Case_Agreement_Payment" (
          id,
          egcs_fc_fundingagreementcommitment,
          egcs_fc_fiscalyear,
          egcs_fc_paymenttype,
          egcs_fc_periodstart,
          egcs_fc_periodend,
          egcs_fc_paymentamount,
          egcs_fc_status
        ) VALUES
          (72, 40, '00000000-0000-4000-8000-000000000020', 'advance', 0, 0, 1, 1),
          (73, 40, '00000000-0000-4000-8000-000000000020', 'advance', 0, 0, 1, 1)
      `.execute(trx))

    await expectGuardConstraint(
      managedMutation(db, '1', async trx => await sql`
          INSERT INTO "Funding_Case_Agreement_Payment_Line" (
            egcs_fc_fundingagreementpayment,
            egcs_fc_fundingagreementcommitmentline,
            egcs_fc_amount
          ) VALUES (72, 51, 1)
        `.execute(trx)),
      'gcs_outcome_cost_allocation_generated_payment_line_coordinate_guard'
    )
    await managedMutation(db, '1', async trx => await sql`
        INSERT INTO "Funding_Case_Agreement_Payment_Line" (
          egcs_fc_fundingagreementpayment,
          egcs_fc_fundingagreementcommitmentline,
          egcs_fc_amount
        ) VALUES (72, 50, 0.99)
      `.execute(trx))

    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment" SET egcs_fc_status = 4 WHERE id = 72`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_total_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment" SET egcs_fc_status = 4 WHERE id = 73`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_total_guard'
    )
  })

  it('enforces transitions, snapshots, and one live draft', async () => {
    await expectGuardConstraint(
      sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
          agreement_id,
          version_number,
          status
        ) VALUES (1, 2, 'active')
      `.execute(db),
      'gcs_outcome_cost_allocation_version_transition_guard'
    )

    await managedMutation(db, '1', async trx => await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
          id,
          agreement_id,
          version_number,
          status
        ) VALUES (61, 1, 2, 'draft')
      `.execute(trx))
    await expect(managedMutation(db, '1', async trx => await sql`
          INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
            agreement_id,
            version_number,
            status
          ) VALUES (1, 3, 'draft')
        `.execute(trx))).rejects.toMatchObject({
      code: '23505',
      constraint: 'gcs_outcome_cost_allocation_one_draft_version'
    })
    await managedMutation(db, '1', async trx => await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_allocations (
          allocation_version_id,
          agreement_id,
          commitment_type,
          stream_commitment_id,
          agreement_budget_fiscal_year_id,
          outcome_id,
          allocation_method,
          allocation_value
        ) VALUES (61, 1, '1', 10, '00000000-0000-4000-8000-000000000020', 30, 'amount', 1)
      `.execute(trx))
    await expectGuardConstraint(
      managedMutation(db, '1', async trx => await sql`
          UPDATE extensions.gcs_outcome_cost_allocation_versions
          SET status = 'active',
            completed_at = now(),
            funding_basis_amount = 1
          WHERE id = 61
        `.execute(trx)),
      'gcs_outcome_cost_allocation_snapshot_guard'
    )
    await expectGuardConstraint(
      managedMutation(db, '1', async trx => await sql`
          UPDATE extensions.gcs_outcome_cost_allocation_versions
          SET _deleted = true
          WHERE id = 61
        `.execute(trx)),
      'gcs_outcome_cost_allocation_version_children_guard'
    )
    await expectGuardConstraint(
      sql`DELETE FROM extensions.gcs_outcome_cost_allocation_allocations WHERE allocation_version_id = 61`.execute(db),
      'gcs_outcome_cost_allocation_allocation_soft_delete_guard'
    )
    await managedMutation(db, '1', async trx => {
      await sql`
        UPDATE extensions.gcs_outcome_cost_allocation_allocations
        SET _deleted = true
        WHERE allocation_version_id = 61
      `.execute(trx)
      await sql`
        UPDATE extensions.gcs_outcome_cost_allocation_versions
        SET _deleted = true
        WHERE id = 61
      `.execute(trx)
    })
  })

  it('keeps active provenance immutable', async () => {
    await expect(managedMutation(db, '1', async trx => await sql`
      UPDATE extensions.gcs_outcome_cost_allocation_versions
      SET lifecycle_status_id = 4
      WHERE id = 60
    `.execute(trx))).resolves.toBeDefined()

    await expectGuardConstraint(
      sql`
        UPDATE extensions.gcs_outcome_cost_allocation_commitment_lines
        SET generated_commitment_id = 41,
          commitment_line_id = 51,
          agreement_id = 1,
          _deleted = true
        WHERE id = 90
      `.execute(db),
      'gcs_outcome_cost_allocation_commitment_line_provenance_guard'
    )
    await expectGuardConstraint(
      sql`
        DELETE FROM extensions.gcs_outcome_cost_allocation_commitment_lines
        WHERE id = 90
      `.execute(db),
      'gcs_outcome_cost_allocation_commitment_line_provenance_guard'
    )
  })

  it('rejects provenance amounts that differ from the active allocation snapshot', async () => {
    await expectGuardConstraint(
      managedMutation(db, '1', async trx => await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_commitment_lines (
          allocation_version_id,
          generated_commitment_id,
          commitment_line_id,
          agreement_id,
          agreement_budget_fiscal_year_id,
          outcome_id,
          stream_commitment_id,
          generated_amount
        ) VALUES (60, 43, 53, 1, '00000000-0000-4000-8000-000000000020', 30, 10, 99)
      `.execute(trx)),
      'gcs_outcome_cost_allocation_commitment_line_provenance_coordinate_guard'
    )
  })

  it('blocks deletion and reassignment of stream commitments used by active allocations', async () => {
    await expectGuardConstraint(
      sql`UPDATE "Transfer_Payment_Stream_Chart_of_Account" SET _deleted = true WHERE id = 10`.execute(db),
      'gcs_outcome_cost_allocation_active_stream_commitment_guard'
    )
    await expectGuardConstraint(
      sql`DELETE FROM "Transfer_Payment_Stream_Chart_of_Account" WHERE id = 10`.execute(db),
      'gcs_outcome_cost_allocation_active_stream_commitment_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Transfer_Payment_Stream_Chart_of_Account" SET egcs_tp_streambudget = 101 WHERE id = 10`.execute(db),
      'gcs_outcome_cost_allocation_active_stream_commitment_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Transfer_Payment_Stream_Chart_of_Account" SET egcs_tp_transferpaymentstream = 201 WHERE id = 10`.execute(db),
      'gcs_outcome_cost_allocation_active_stream_commitment_guard'
    )

    await expect(sql`
      UPDATE "Transfer_Payment_Stream_Chart_of_Account"
      SET egcs_tp_accountingdimensions = '[{"label_en":"G/L","label_fr":"G/L","value":"5001"}]'::jsonb
      WHERE id = 10
    `.execute(db)).resolves.toBeDefined()
  })

  it('blocks deletion and reassignment of budget mapping rows used by active allocations', async () => {
    const constraint = 'gcs_outcome_cost_allocation_active_budget_mapping_guard'
    await expectGuardConstraint(
      sql`UPDATE "Agency_Fiscal_Year" SET _deleted = true WHERE id = 400`.execute(db),
      constraint
    )
    await expectGuardConstraint(
      sql`UPDATE "Transfer_Payment_Stream" SET egcs_tp_transferpaymentprofile = 301 WHERE id = 200`.execute(db),
      constraint
    )
    await expectGuardConstraint(
      sql`UPDATE "Transfer_Payment_Fiscal_Year_Budget" SET egcs_tp_fiscalyear = 401 WHERE id = 500`.execute(db),
      constraint
    )
    await expectGuardConstraint(
      sql`UPDATE "Transfer_Payment_Stream_Budget" SET egcs_tp_transferpaymentbudget = 501 WHERE id = 100`.execute(db),
      constraint
    )
    await expectGuardConstraint(
      sql`DELETE FROM "Transfer_Payment_Stream_Budget" WHERE id = 100`.execute(db),
      constraint
    )

    await expect(sql`
      UPDATE "Agency_Fiscal_Year"
      SET egcs_ay_fiscalyeardisplay = 'FY 2026-2027'
      WHERE id = 400
    `.execute(db)).resolves.toBeDefined()
  })

  it('rejects immutable generated-row mutations before requesting the agreement lock', async () => {
    await sql`UPDATE "Funding_Case_Agreement_Profile" SET _deleted = true WHERE id = 1`.execute(db)

    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Commitment_Line" SET egcs_fc_amount = 99 WHERE id = 50`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment_Line" SET egcs_fc_amount = 24 WHERE id = 80`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_line_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Commitment" SET _deleted = true WHERE id = 40`.execute(db),
      'gcs_outcome_cost_allocation_generated_commitment_guard'
    )
    await expectGuardConstraint(
      sql`UPDATE "Funding_Case_Agreement_Payment" SET _deleted = true WHERE id = 70`.execute(db),
      'gcs_outcome_cost_allocation_generated_payment_guard'
    )

    await sql`UPDATE "Funding_Case_Agreement_Profile" SET _deleted = false WHERE id = 1`.execute(db)
  })
})
