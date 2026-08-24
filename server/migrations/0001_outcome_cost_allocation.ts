import { sql } from 'kysely'
import { attachGcsLifecycleEntityIdentity, defineGcsExtensionMigration } from '@gcs-ssc/extensions/server'

export default defineGcsExtensionMigration({
  up: async (db) => {
    await db.schema
      .createTable('extensions.gcs_outcome_cost_allocation_versions')
      .addColumn('id', 'bigserial', col => col.primaryKey())
      .addColumn('agreement_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Profile.id').onDelete('restrict'))
      .addColumn('version_number', 'integer', col => col.notNull())
      .addColumn('status', 'varchar(20)', col => col.notNull())
      .addColumn('lifecycle_status_id', 'bigint', col => col.notNull().references('Common_Status.id').onDelete('restrict'))
      .addColumn('created_at', 'timestamp', col => col.defaultTo(sql`now()`).notNull())
      .addColumn('completed_at', 'timestamp')
      .addColumn('funding_basis_amount', 'numeric(19, 2)')
      .addColumn('_deleted', 'boolean', col => col.defaultTo(false).notNull())
      .addCheckConstraint(
        'gcs_outcome_cost_allocation_version_status',
        sql`status IN ('draft', 'active', 'inactive')`
      )
      .addCheckConstraint(
        'gcs_outcome_cost_allocation_version_funding_nonnegative',
        sql`funding_basis_amount IS NULL OR funding_basis_amount >= 0`
      )
      .execute()

    await attachGcsLifecycleEntityIdentity(db, {
      extensionKey: 'gcs-outcome-cost-allocation',
      localType: 'allocation-version',
      table: 'gcs_outcome_cost_allocation_versions'
    })

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_resolve_draft_status()
      RETURNS trigger AS $$
      BEGIN
        SELECT status.id INTO NEW.lifecycle_status_id
        FROM "Funding_Case_Agreement_Profile" agreement
        JOIN "Transfer_Payment_Stream" stream
          ON stream.id = agreement.egcs_fc_transferpaymentstream
        JOIN "Transfer_Payment_Profile" profile
          ON profile.id = stream.egcs_tp_transferpaymentprofile
        JOIN "Common_Status" status
          ON status.egcs_cn_agency = profile.egcs_tp_agency
         AND status.egcs_cn_isdraft = true
         AND status._deleted = false
        WHERE agreement.id = NEW.agreement_id
          AND agreement._deleted = false
        ORDER BY status.id ASC
        LIMIT 1;
        IF NEW.lifecycle_status_id IS NULL THEN
          RAISE EXCEPTION 'Outcome cost allocation requires an Agency draft status.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_resolve_draft_status
      BEFORE INSERT ON extensions.gcs_outcome_cost_allocation_versions
      FOR EACH ROW EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_resolve_draft_status()
    `.execute(db)

    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_soft_delete_identity
      AFTER UPDATE OF _deleted
      ON extensions.gcs_outcome_cost_allocation_versions
      FOR EACH ROW EXECUTE FUNCTION trg_fn_soft_delete_entity_assignments(
        'gcs-outcome-cost-allocation:allocation-version'
      )
    `.execute(db)

    await sql`
      CREATE UNIQUE INDEX gcs_outcome_cost_allocation_unique_version
      ON extensions.gcs_outcome_cost_allocation_versions (agreement_id, version_number)
      WHERE _deleted = false
    `.execute(db)

    await sql`
      CREATE UNIQUE INDEX gcs_outcome_cost_allocation_one_active_version
      ON extensions.gcs_outcome_cost_allocation_versions (agreement_id)
      WHERE _deleted = false AND status = 'active'
    `.execute(db)

    await sql`
      CREATE UNIQUE INDEX gcs_outcome_cost_allocation_one_draft_version
      ON extensions.gcs_outcome_cost_allocation_versions (agreement_id)
      WHERE _deleted = false AND status = 'draft'
    `.execute(db)

    await db.schema
      .createTable('extensions.gcs_outcome_cost_allocation_allocations')
      .addColumn('id', 'bigserial', col => col.primaryKey())
      .addColumn('allocation_version_id', 'bigint', col => col.notNull().references('extensions.gcs_outcome_cost_allocation_versions.id').onDelete('restrict'))
      .addColumn('agreement_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Profile.id').onDelete('restrict'))
      .addColumn('commitment_type', 'bigint', col => col.notNull().references('Transfer_Payment_Stream_Commitment_Type.id').onDelete('restrict'))
      .addColumn('stream_commitment_id', 'bigint', col => col.notNull().references('Transfer_Payment_Stream_Chart_of_Account.id').onDelete('restrict'))
      .addColumn('agreement_budget_fiscal_year_id', sql`uuid`, col => col.notNull().references('Funding_Case_Agreement_Budget_Fiscal_Year.id').onDelete('restrict'))
      .addColumn('outcome_id', 'bigint', col => col.notNull().references('Transfer_Payment_Outcome.id').onDelete('restrict'))
      .addColumn('allocation_method', 'varchar(20)', col => col.notNull())
      .addColumn('allocation_value', 'numeric(19, 4)', col => col.notNull())
      .addColumn('resolved_amount', 'numeric(19, 2)')
      .addColumn('funding_basis_amount', 'numeric(19, 2)')
      .addColumn('outcome_label_en', 'varchar(255)')
      .addColumn('outcome_label_fr', 'varchar(255)')
      .addColumn('commitment_label_en', 'text')
      .addColumn('commitment_label_fr', 'text')
      .addColumn('fiscal_year_display', 'varchar(50)')
      .addColumn('_deleted', 'boolean', col => col.defaultTo(false).notNull())
      .addCheckConstraint(
        'gcs_outcome_cost_allocation_method',
        sql`allocation_method IN ('amount', 'percentage')`
      )
      .addCheckConstraint(
        'gcs_outcome_cost_allocation_value_range',
        sql`allocation_value >= 0 AND (allocation_method <> 'percentage' OR allocation_value <= 100)`
      )
      .addCheckConstraint(
        'gcs_outcome_cost_allocation_economics_nonnegative',
        sql`(resolved_amount IS NULL OR resolved_amount >= 0)
          AND (funding_basis_amount IS NULL OR funding_basis_amount >= 0)`
      )
      .execute()

    await sql`
      CREATE UNIQUE INDEX gcs_outcome_cost_allocation_version_allocation
      ON extensions.gcs_outcome_cost_allocation_allocations (
        allocation_version_id,
        commitment_type,
        stream_commitment_id,
        agreement_budget_fiscal_year_id,
        outcome_id
      )
      WHERE _deleted = false
    `.execute(db)

    await db.schema
      .createTable('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .addColumn('id', 'bigserial', col => col.primaryKey())
      .addColumn('allocation_version_id', 'bigint', col => col.notNull().references('extensions.gcs_outcome_cost_allocation_versions.id').onDelete('restrict'))
      .addColumn('generated_commitment_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Commitment.id').onDelete('restrict'))
      .addColumn('commitment_line_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Commitment_Line.id').onDelete('restrict'))
      .addColumn('agreement_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Profile.id').onDelete('restrict'))
      .addColumn('agreement_budget_fiscal_year_id', sql`uuid`, col => col.notNull().references('Funding_Case_Agreement_Budget_Fiscal_Year.id').onDelete('restrict'))
      .addColumn('outcome_id', 'bigint', col => col.notNull().references('Transfer_Payment_Outcome.id').onDelete('restrict'))
      .addColumn('stream_commitment_id', 'bigint', col => col.notNull().references('Transfer_Payment_Stream_Chart_of_Account.id').onDelete('restrict'))
      .addColumn('generated_amount', 'numeric(19, 2)', col => col.notNull())
      .addColumn('_deleted', 'boolean', col => col.defaultTo(false).notNull())
      .addCheckConstraint(
        'gcs_outcome_cost_allocation_generated_amount_nonnegative',
        sql`generated_amount >= 0`
      )
      .execute()

    await sql`
      CREATE UNIQUE INDEX gcs_outcome_cost_allocation_active_commitment_line
      ON extensions.gcs_outcome_cost_allocation_commitment_lines (commitment_line_id)
      WHERE _deleted = false
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_lock_agreement(
        target_agreement_id bigint
      ) RETURNS void AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(
          hashtextextended(
            'gcs_outcome_cost_allocation.agreement',
            target_agreement_id
          )
        );

        PERFORM 1
        FROM "Funding_Case_Agreement_Profile"
        WHERE id = target_agreement_id
          AND _deleted = false
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Outcome cost allocation agreement is unavailable.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_agreement_guard';
        END IF;

        PERFORM set_config(
          'gcs_outcome_cost_allocation.managed_agreement_id',
          target_agreement_id::text,
          true
        );
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_assert_managed_mutation(
        target_agreement_id bigint
      ) RETURNS void AS $$
      DECLARE
        agreement_lock_key bigint;
      BEGIN
        IF version() LIKE '%compiled by emcc%' THEN
          IF current_setting(
            'gcs_outcome_cost_allocation.managed_agreement_id',
            true
          ) IS DISTINCT FROM target_agreement_id::text THEN
            RAISE EXCEPTION 'Outcome cost allocation changes require the agreement lifecycle lock.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'gcs_outcome_cost_allocation_managed_mutation_guard';
          END IF;

          RETURN;
        END IF;

        agreement_lock_key := hashtextextended(
          'gcs_outcome_cost_allocation.agreement',
          target_agreement_id
        );

        IF NOT EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = pg_backend_pid()
            AND granted = true
            AND classid::bigint = (
              (agreement_lock_key >> 32) & 4294967295
            )
            AND objid::bigint = (
              agreement_lock_key & 4294967295
            )
            AND objsubid = 1
        ) THEN
          RAISE EXCEPTION 'Outcome cost allocation changes require the agreement lifecycle lock.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_managed_mutation_guard';
        END IF;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_version()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'draft'
            OR NEW._deleted = true
            OR NEW.completed_at IS NOT NULL
            OR NEW.funding_basis_amount IS NOT NULL
          THEN
            RAISE EXCEPTION 'Outcome cost allocation versions must begin as drafts.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'gcs_outcome_cost_allocation_version_transition_guard';
          END IF;

          PERFORM extensions.gcs_outcome_cost_allocation_assert_managed_mutation(NEW.agreement_id);
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Outcome cost allocation versions use draft-only soft deletion.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_version_transition_guard';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
          OR NEW.version_number IS DISTINCT FROM OLD.version_number
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR (
            OLD.status <> 'draft'
            AND NEW.funding_basis_amount IS DISTINCT FROM OLD.funding_basis_amount
          )
          OR OLD._deleted = true
        THEN
          RAISE EXCEPTION 'Outcome cost allocation version identity is immutable.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_version_identity_guard';
        END IF;

        PERFORM extensions.gcs_outcome_cost_allocation_assert_managed_mutation(OLD.agreement_id);

        IF NEW IS NOT DISTINCT FROM OLD THEN
          RETURN NEW;
        END IF;

        -- The host lifecycle engine owns this status FK and advances it when a
        -- Completion materializes Workflow evidence. Domain allocation data
        -- remains frozen while orchestration is in progress.
        IF OLD.status = 'draft'
          AND OLD._deleted = false
          AND NEW.status = 'draft'
          AND NEW._deleted = false
          AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
          AND NEW.funding_basis_amount IS NOT DISTINCT FROM OLD.funding_basis_amount
          AND NEW.lifecycle_status_id IS DISTINCT FROM OLD.lifecycle_status_id
        THEN
          RETURN NEW;
        END IF;

        IF OLD.status = 'draft'
          AND OLD._deleted = false
          AND NEW.status = 'draft'
          AND NEW._deleted = false
          AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
          AND OLD.funding_basis_amount IS NULL
          AND NEW.funding_basis_amount IS NOT NULL
          AND NEW.lifecycle_status_id IS NOT DISTINCT FROM OLD.lifecycle_status_id
        THEN
          RETURN NEW;
        END IF;

        IF OLD.status = 'draft'
          AND OLD._deleted = false
          AND NEW.status = 'draft'
          AND NEW._deleted = true
          AND NEW.completed_at IS NULL
          AND NEW.funding_basis_amount IS NULL
        THEN
          IF EXISTS (
            SELECT 1
            FROM extensions.gcs_outcome_cost_allocation_allocations allocation
            WHERE allocation.allocation_version_id = OLD.id
              AND allocation._deleted = false
          ) THEN
            RAISE EXCEPTION 'Draft allocation rows must be soft-deleted before their version.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'gcs_outcome_cost_allocation_version_children_guard';
          END IF;

          RETURN NEW;
        END IF;

        IF OLD.status = 'draft'
          AND OLD._deleted = false
          AND NEW.status = 'active'
          AND NEW._deleted = false
          AND NEW.completed_at IS NOT NULL
          AND NEW.funding_basis_amount IS NOT NULL
        THEN
          IF EXISTS (
            SELECT 1
            FROM extensions.gcs_outcome_cost_allocation_allocations allocation
            WHERE allocation.allocation_version_id = OLD.id
              AND allocation._deleted = false
              AND (
                allocation.outcome_label_en IS NULL
                OR allocation.outcome_label_fr IS NULL
                OR allocation.commitment_label_en IS NULL
                OR allocation.commitment_label_fr IS NULL
                OR allocation.fiscal_year_display IS NULL
                OR allocation.resolved_amount IS NULL
                OR allocation.funding_basis_amount IS NULL
              )
          ) THEN
            RAISE EXCEPTION 'Outcome cost allocation labels and economics must be snapshotted before activation.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'gcs_outcome_cost_allocation_snapshot_guard';
          END IF;

          RETURN NEW;
        END IF;

        IF OLD.status = 'active'
          AND OLD._deleted = false
          AND NEW.status = 'inactive'
          AND NEW._deleted = false
          AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
        THEN
          RETURN NEW;
        END IF;

        RAISE EXCEPTION 'Outcome cost allocation version transition is not allowed.'
          USING ERRCODE = '23514',
            CONSTRAINT = 'gcs_outcome_cost_allocation_version_transition_guard';
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_version ON extensions.gcs_outcome_cost_allocation_versions`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_version
      BEFORE INSERT OR UPDATE OR DELETE
      ON extensions.gcs_outcome_cost_allocation_versions
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_version();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_allocation()
      RETURNS trigger AS $$
      DECLARE
        target_version_id bigint;
        target_agreement_id bigint;
        parent_agreement_id bigint;
        parent_status text;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Outcome cost allocation rows use soft deletion.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_allocation_soft_delete_guard';
        END IF;

        target_version_id := CASE
          WHEN TG_OP = 'DELETE' THEN OLD.allocation_version_id
          ELSE NEW.allocation_version_id
        END;
        target_agreement_id := CASE
          WHEN TG_OP = 'DELETE' THEN OLD.agreement_id
          ELSE NEW.agreement_id
        END;

        PERFORM extensions.gcs_outcome_cost_allocation_assert_managed_mutation(target_agreement_id);

        SELECT version.agreement_id, version.status
        INTO parent_agreement_id, parent_status
        FROM extensions.gcs_outcome_cost_allocation_versions version
        WHERE version.id = target_version_id
          AND version._deleted = false;

        IF parent_agreement_id IS NULL THEN
          RAISE EXCEPTION 'Only draft outcome cost allocation rows can be changed.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_allocation_draft_guard';
        END IF;

        IF parent_status IS NULL OR parent_status <> 'draft' THEN
          RAISE EXCEPTION 'Only draft outcome cost allocation rows can be changed.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_allocation_draft_guard';
        END IF;

        IF TG_OP = 'UPDATE'
          AND (
            NEW.id IS DISTINCT FROM OLD.id
            OR NEW.allocation_version_id IS DISTINCT FROM OLD.allocation_version_id
            OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
          )
        THEN
          RAISE EXCEPTION 'Outcome cost allocation rows cannot be reparented.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_allocation_identity_guard';
        END IF;

        IF target_agreement_id IS DISTINCT FROM parent_agreement_id THEN
          RAISE EXCEPTION 'Outcome cost allocation agreement provenance is inconsistent.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_allocation_coordinate_guard';
        END IF;

        IF TG_OP = 'UPDATE'
          AND OLD._deleted = false
          AND NEW._deleted = true
        THEN
          RETURN NEW;
        END IF;

        IF NEW._deleted = true OR NOT EXISTS (
          SELECT 1
          FROM "Funding_Case_Agreement_Profile" agreement
          INNER JOIN "Transfer_Payment_Stream" stream
            ON stream.id = agreement.egcs_fc_transferpaymentstream
            AND stream._deleted = false
          INNER JOIN "Funding_Case_Agreement_Budget_Fiscal_Year" agreement_year
            ON COALESCE(agreement_year.egcs_fc_originalbudgetfiscalyear, agreement_year.id) = NEW.agreement_budget_fiscal_year_id
            AND agreement_year.egcs_fc_fundingagreement = agreement.id
            AND agreement_year._deleted = false
          INNER JOIN "Funding_Case_Agreement_Budget_Version" agreement_budget_version
            ON agreement_budget_version.id = agreement_year.egcs_fc_budgetversion
            AND agreement_budget_version.egcs_fc_fundingagreement = agreement.id
            AND agreement_budget_version.egcs_fc_iscurrent = true
            AND agreement_budget_version._deleted = false
          INNER JOIN "Transfer_Payment_Outcome" outcome
            ON outcome.id = NEW.outcome_id
            AND outcome.egcs_tp_transferpaymentprofile = stream.egcs_tp_transferpaymentprofile
            AND outcome._deleted = false
          INNER JOIN "Transfer_Payment_Stream_Chart_of_Account" stream_commitment
            ON stream_commitment.id = NEW.stream_commitment_id
            AND stream_commitment.egcs_tp_transferpaymentstream = stream.id
            AND stream_commitment._deleted = false
          INNER JOIN "Transfer_Payment_Stream_Commitment_Type" commitment_type
            ON commitment_type.id = NEW.commitment_type
            AND commitment_type.egcs_tp_transferpaymentstream = stream.id
            AND commitment_type._deleted = false
          INNER JOIN "Transfer_Payment_Stream_Budget" stream_budget
            ON stream_budget.id = stream_commitment.egcs_tp_streambudget
            AND stream_budget.egcs_tp_transferpaymentstream = stream.id
            AND stream_budget._deleted = false
          INNER JOIN "Transfer_Payment_Fiscal_Year_Budget" program_budget
            ON program_budget.id = stream_budget.egcs_tp_transferpaymentbudget
            AND program_budget.egcs_tp_transferpaymentprofile = stream.egcs_tp_transferpaymentprofile
            AND program_budget.egcs_tp_fiscalyear = agreement_year.egcs_fc_fiscalyear
            AND program_budget._deleted = false
          WHERE agreement.id = parent_agreement_id
            AND agreement._deleted = false
        ) THEN
          RAISE EXCEPTION 'Outcome cost allocation coordinates do not belong to the agreement.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_allocation_coordinate_guard';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_allocation ON extensions.gcs_outcome_cost_allocation_allocations`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_allocation
      BEFORE INSERT OR UPDATE OR DELETE
      ON extensions.gcs_outcome_cost_allocation_allocations
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_allocation();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_commitment_line()
      RETURNS trigger AS $$
      DECLARE
        target_commitment_id bigint;
        generated_agreement_id bigint;
      BEGIN
        target_commitment_id := CASE
          WHEN TG_OP = 'DELETE' THEN OLD.egcs_fc_commitment
          ELSE NEW.egcs_fc_commitment
        END;

        SELECT provenance.agreement_id
        INTO generated_agreement_id
        FROM extensions.gcs_outcome_cost_allocation_commitment_lines provenance
        WHERE provenance.generated_commitment_id = target_commitment_id
          OR (
            TG_OP <> 'INSERT'
            AND provenance.commitment_line_id = OLD.id
          )
        LIMIT 1;

        IF generated_agreement_id IS NOT NULL THEN
          RAISE EXCEPTION 'Allocation-generated commitment lines cannot be changed.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_generated_commitment_line_guard';
        END IF;

        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_commitment_line ON "Funding_Case_Agreement_Commitment_Line"`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_commitment_line
      BEFORE INSERT OR UPDATE OR DELETE
      ON "Funding_Case_Agreement_Commitment_Line"
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_commitment_line();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_commitment()
      RETURNS trigger AS $$
      DECLARE
        generated_agreement_id bigint;
      BEGIN
        SELECT provenance.agreement_id
        INTO generated_agreement_id
        FROM extensions.gcs_outcome_cost_allocation_commitment_lines provenance
        WHERE provenance.generated_commitment_id = OLD.id
        LIMIT 1;

        IF generated_agreement_id IS NULL THEN
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END IF;

        IF TG_OP = 'DELETE'
          OR NEW.egcs_fc_fundingagreement IS DISTINCT FROM OLD.egcs_fc_fundingagreement
          OR NEW.egcs_fc_type IS DISTINCT FROM OLD.egcs_fc_type
          OR NEW._deleted IS DISTINCT FROM OLD._deleted
        THEN
          RAISE EXCEPTION 'Allocation-generated commitments cannot be deleted or reassigned.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_generated_commitment_guard';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_commitment ON "Funding_Case_Agreement_Commitment"`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_commitment
      BEFORE UPDATE OR DELETE
      ON "Funding_Case_Agreement_Commitment"
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_commitment();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_payment()
      RETURNS trigger AS $$
      DECLARE
        old_generated_agreement_id bigint;
        new_generated_agreement_id bigint;
        active_line_count bigint;
        active_line_total numeric(19, 2);
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          SELECT provenance.agreement_id
          INTO old_generated_agreement_id
          FROM extensions.gcs_outcome_cost_allocation_commitment_lines provenance
          WHERE provenance.generated_commitment_id = OLD.egcs_fc_fundingagreementcommitment
          LIMIT 1;
        END IF;

        IF TG_OP <> 'DELETE' THEN
          SELECT provenance.agreement_id
          INTO new_generated_agreement_id
          FROM extensions.gcs_outcome_cost_allocation_commitment_lines provenance
          WHERE provenance.generated_commitment_id = NEW.egcs_fc_fundingagreementcommitment
          LIMIT 1;
        END IF;

        IF TG_OP = 'INSERT' THEN
          IF new_generated_agreement_id IS NOT NULL THEN
            PERFORM extensions.gcs_outcome_cost_allocation_assert_managed_mutation(new_generated_agreement_id);
          END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' AND old_generated_agreement_id IS NOT NULL THEN
          RAISE EXCEPTION 'Payments for allocation-generated commitments cannot be deleted or reallocated.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_generated_payment_guard';
        END IF;

        IF TG_OP = 'UPDATE'
          AND (
            old_generated_agreement_id IS NOT NULL
            OR new_generated_agreement_id IS NOT NULL
          )
          AND (
            NEW.egcs_fc_fundingagreementcommitment IS DISTINCT FROM OLD.egcs_fc_fundingagreementcommitment
            OR NEW.egcs_fc_fiscalyear IS DISTINCT FROM OLD.egcs_fc_fiscalyear
            OR NEW.egcs_fc_paymentamount IS DISTINCT FROM OLD.egcs_fc_paymentamount
            OR NEW._deleted IS DISTINCT FROM OLD._deleted
          )
        THEN
          RAISE EXCEPTION 'Payments for allocation-generated commitments cannot be deleted or reallocated.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_generated_payment_guard';
        END IF;

        IF TG_OP = 'UPDATE'
          AND old_generated_agreement_id IS NOT NULL
          AND COALESCE((SELECT status.egcs_cn_isdraft FROM "Common_Status" status WHERE status.id = OLD.egcs_fc_status), false)
          AND NOT COALESCE((SELECT status.egcs_cn_isdraft FROM "Common_Status" status WHERE status.id = NEW.egcs_fc_status), false)
        THEN
          SELECT COUNT(*), COALESCE(SUM(payment_line.egcs_fc_amount), 0)
          INTO active_line_count, active_line_total
          FROM "Funding_Case_Agreement_Payment_Line" payment_line
          WHERE payment_line.egcs_fc_fundingagreementpayment = OLD.id
            AND payment_line._deleted = false;

          IF EXISTS (
            SELECT 1
            FROM "Funding_Case_Agreement_Payment_Line" payment_line
            WHERE payment_line.egcs_fc_fundingagreementpayment = OLD.id
              AND payment_line._deleted = false
              AND NOT EXISTS (
                SELECT 1
                FROM "Funding_Case_Agreement_Commitment_Line" commitment_line
                INNER JOIN extensions.gcs_outcome_cost_allocation_commitment_lines provenance
                  ON provenance.commitment_line_id = commitment_line.id
                  AND provenance.generated_commitment_id = OLD.egcs_fc_fundingagreementcommitment
                  AND provenance.agreement_budget_fiscal_year_id = OLD.egcs_fc_fiscalyear
                  AND provenance._deleted = false
                INNER JOIN extensions.gcs_outcome_cost_allocation_versions version
                  ON version.id = provenance.allocation_version_id
                  AND version.agreement_id = provenance.agreement_id
                  AND version._deleted = false
                WHERE commitment_line.id = payment_line.egcs_fc_fundingagreementcommitmentline
                  AND commitment_line.egcs_fc_commitment = OLD.egcs_fc_fundingagreementcommitment
                  AND commitment_line._deleted = false
              )
          ) THEN
            RAISE EXCEPTION 'Payment line does not match the generated commitment coordinate.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'gcs_outcome_cost_allocation_generated_payment_line_coordinate_guard';
          END IF;

          IF active_line_count = 0
            OR active_line_total IS DISTINCT FROM NEW.egcs_fc_paymentamount
          THEN
            RAISE EXCEPTION 'Allocation-generated payments require exact active payment-line totals before leaving draft.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'gcs_outcome_cost_allocation_generated_payment_total_guard';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_payment_insert ON "Funding_Case_Agreement_Payment"`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_payment_insert
      AFTER INSERT
      ON "Funding_Case_Agreement_Payment"
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_payment();
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_payment_change ON "Funding_Case_Agreement_Payment"`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_payment_change
      BEFORE UPDATE OR DELETE
      ON "Funding_Case_Agreement_Payment"
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_payment();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_payment_line()
      RETURNS trigger AS $$
      DECLARE
        old_generated_agreement_id bigint;
        new_generated_agreement_id bigint;
        exact_generated_agreement_id bigint;
        new_payment_is_draft boolean;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          SELECT provenance.agreement_id
          INTO old_generated_agreement_id
          FROM "Funding_Case_Agreement_Payment" payment
          INNER JOIN extensions.gcs_outcome_cost_allocation_commitment_lines provenance
            ON provenance.generated_commitment_id = payment.egcs_fc_fundingagreementcommitment
          WHERE payment.id = OLD.egcs_fc_fundingagreementpayment
          LIMIT 1;
        END IF;

        IF TG_OP <> 'DELETE' THEN
          SELECT provenance.agreement_id, status.egcs_cn_isdraft
          INTO new_generated_agreement_id, new_payment_is_draft
          FROM "Funding_Case_Agreement_Payment" payment
          INNER JOIN "Common_Status" status ON status.id = payment.egcs_fc_status
          INNER JOIN extensions.gcs_outcome_cost_allocation_commitment_lines provenance
            ON provenance.generated_commitment_id = payment.egcs_fc_fundingagreementcommitment
          WHERE payment.id = NEW.egcs_fc_fundingagreementpayment
          LIMIT 1;
        END IF;

        IF TG_OP = 'INSERT'
          AND new_generated_agreement_id IS NOT NULL
          AND new_payment_is_draft = true
        THEN
          SELECT provenance.agreement_id
          INTO exact_generated_agreement_id
          FROM "Funding_Case_Agreement_Payment" payment
          INNER JOIN "Funding_Case_Agreement_Commitment" commitment
            ON commitment.id = payment.egcs_fc_fundingagreementcommitment
            AND commitment._deleted = false
          INNER JOIN "Funding_Case_Agreement_Commitment_Line" commitment_line
            ON commitment_line.id = NEW.egcs_fc_fundingagreementcommitmentline
            AND commitment_line.egcs_fc_commitment = commitment.id
            AND commitment_line._deleted = false
          INNER JOIN extensions.gcs_outcome_cost_allocation_commitment_lines provenance
            ON provenance.generated_commitment_id = commitment.id
            AND provenance.commitment_line_id = commitment_line.id
            AND provenance.agreement_id = commitment.egcs_fc_fundingagreement
            AND provenance._deleted = false
          INNER JOIN extensions.gcs_outcome_cost_allocation_versions version
            ON version.id = provenance.allocation_version_id
            AND version.agreement_id = provenance.agreement_id
            AND version._deleted = false
          WHERE payment.id = NEW.egcs_fc_fundingagreementpayment
            AND payment._deleted = false
            AND payment.egcs_fc_fiscalyear = provenance.agreement_budget_fiscal_year_id
            AND NOT EXISTS (
              SELECT 1
              FROM extensions.gcs_outcome_cost_allocation_commitment_lines sibling
              WHERE sibling.generated_commitment_id = commitment.id
                AND sibling._deleted = false
                AND (
                  sibling.agreement_id IS DISTINCT FROM provenance.agreement_id
                  OR sibling.allocation_version_id IS DISTINCT FROM provenance.allocation_version_id
                )
            )
          LIMIT 1;

          IF exact_generated_agreement_id IS NULL THEN
            RAISE EXCEPTION 'Payment line does not match the generated commitment coordinate.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'gcs_outcome_cost_allocation_generated_payment_line_coordinate_guard';
          END IF;

          PERFORM extensions.gcs_outcome_cost_allocation_assert_managed_mutation(exact_generated_agreement_id);
          RETURN NEW;
        END IF;

        IF old_generated_agreement_id IS NOT NULL
          OR new_generated_agreement_id IS NOT NULL
        THEN
          RAISE EXCEPTION 'Payment lines for allocation-generated commitments cannot be changed.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_generated_payment_line_guard';
        END IF;

        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_payment_line ON "Funding_Case_Agreement_Payment_Line"`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_payment_line
      BEFORE INSERT OR UPDATE OR DELETE
      ON "Funding_Case_Agreement_Payment_Line"
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_payment_line();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_commitment_line_provenance()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Allocation-generated commitment line provenance is immutable.'
          USING ERRCODE = '23514',
            CONSTRAINT = 'gcs_outcome_cost_allocation_commitment_line_provenance_guard';
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_validate_commitment_line_provenance()
      RETURNS trigger AS $$
      BEGIN
        PERFORM extensions.gcs_outcome_cost_allocation_assert_managed_mutation(NEW.agreement_id);

        IF NEW._deleted = true OR NOT EXISTS (
          SELECT 1
          FROM extensions.gcs_outcome_cost_allocation_versions version
          INNER JOIN extensions.gcs_outcome_cost_allocation_allocations allocation
            ON allocation.allocation_version_id = version.id
            AND allocation.agreement_id = version.agreement_id
            AND allocation.agreement_budget_fiscal_year_id = NEW.agreement_budget_fiscal_year_id
            AND allocation.outcome_id = NEW.outcome_id
            AND allocation.stream_commitment_id = NEW.stream_commitment_id
            AND allocation.resolved_amount = NEW.generated_amount
            AND allocation._deleted = false
          INNER JOIN "Funding_Case_Agreement_Commitment" commitment
            ON commitment.id = NEW.generated_commitment_id
            AND commitment.egcs_fc_fundingagreement = version.agreement_id
            AND commitment.egcs_fc_type = allocation.commitment_type
            AND commitment._deleted = false
          INNER JOIN "Funding_Case_Agreement_Commitment_Line" commitment_line
            ON commitment_line.id = NEW.commitment_line_id
            AND commitment_line.egcs_fc_commitment = commitment.id
            AND commitment_line.egcs_fc_transferpaymentstreamchartofaccount = NEW.stream_commitment_id
            AND commitment_line.egcs_fc_amount = NEW.generated_amount
            AND commitment_line._deleted = false
          WHERE version.id = NEW.allocation_version_id
            AND version.agreement_id = NEW.agreement_id
            AND version.status = 'active'
            AND version._deleted = false
        ) THEN
          RAISE EXCEPTION 'Allocation-generated commitment line provenance is inconsistent.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_commitment_line_provenance_coordinate_guard';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_validate_commitment_line_provenance ON extensions.gcs_outcome_cost_allocation_commitment_lines`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_validate_commitment_line_provenance
      BEFORE INSERT
      ON extensions.gcs_outcome_cost_allocation_commitment_lines
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_validate_commitment_line_provenance();
    `.execute(db)

    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_commitment_line_provenance ON extensions.gcs_outcome_cost_allocation_commitment_lines`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_commitment_line_provenance
      BEFORE UPDATE OR DELETE
      ON extensions.gcs_outcome_cost_allocation_commitment_lines
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_commitment_line_provenance();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_stream_commitment_delete()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW._deleted IS NOT DISTINCT FROM OLD._deleted
            AND NEW.egcs_tp_streambudget IS NOT DISTINCT FROM OLD.egcs_tp_streambudget
            AND NEW.egcs_tp_transferpaymentstream IS NOT DISTINCT FROM OLD.egcs_tp_transferpaymentstream
          THEN
            RETURN NEW;
          END IF;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM extensions.gcs_outcome_cost_allocation_allocations allocation
          INNER JOIN extensions.gcs_outcome_cost_allocation_versions version
            ON version.id = allocation.allocation_version_id
          WHERE allocation.stream_commitment_id = OLD.id
            AND allocation._deleted = false
            AND version.status = 'active'
            AND version._deleted = false
        ) THEN
          RAISE EXCEPTION 'Stream commitments referenced by active outcome allocations cannot be deleted or reassigned.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_active_stream_commitment_guard';
        END IF;

        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    for (const tableName of [
      'Agency_Fiscal_Year',
      'Transfer_Payment_Stream',
      'Transfer_Payment_Fiscal_Year_Budget',
      'Transfer_Payment_Stream_Budget'
    ]) {
      await sql.raw(`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_active_budget_mapping ON "${tableName}"`).execute(db)
    }
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_stream_commitment_delete ON "Transfer_Payment_Stream_Chart_of_Account"`.execute(db)
    await sql`
      CREATE TRIGGER gcs_outcome_cost_allocation_guard_stream_commitment_delete
      BEFORE UPDATE OR DELETE
      ON "Transfer_Payment_Stream_Chart_of_Account"
      FOR EACH ROW
      EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_stream_commitment_delete();
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION extensions.gcs_outcome_cost_allocation_guard_active_budget_mapping()
      RETURNS trigger AS $$
      DECLARE
        old_row jsonb := to_jsonb(OLD);
        new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
      BEGIN
        IF TG_OP = 'UPDATE'
          AND new_row -> '_deleted' IS NOT DISTINCT FROM old_row -> '_deleted'
          AND (
            TG_TABLE_NAME <> 'Transfer_Payment_Stream'
            OR new_row -> 'egcs_tp_transferpaymentprofile'
              IS NOT DISTINCT FROM old_row -> 'egcs_tp_transferpaymentprofile'
          )
          AND (
            TG_TABLE_NAME <> 'Transfer_Payment_Fiscal_Year_Budget'
            OR (
              new_row -> 'egcs_tp_transferpaymentprofile'
                IS NOT DISTINCT FROM old_row -> 'egcs_tp_transferpaymentprofile'
              AND new_row -> 'egcs_tp_fiscalyear'
                IS NOT DISTINCT FROM old_row -> 'egcs_tp_fiscalyear'
            )
          )
          AND (
            TG_TABLE_NAME <> 'Transfer_Payment_Stream_Budget'
            OR (
              new_row -> 'egcs_tp_transferpaymentbudget'
                IS NOT DISTINCT FROM old_row -> 'egcs_tp_transferpaymentbudget'
              AND new_row -> 'egcs_tp_transferpaymentstream'
                IS NOT DISTINCT FROM old_row -> 'egcs_tp_transferpaymentstream'
            )
          )
        THEN
          RETURN NEW;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM extensions.gcs_outcome_cost_allocation_allocations allocation
          INNER JOIN extensions.gcs_outcome_cost_allocation_versions version
            ON version.id = allocation.allocation_version_id
            AND version.status = 'active'
            AND version._deleted = false
          INNER JOIN "Funding_Case_Agreement_Budget_Fiscal_Year" agreement_budget
            ON COALESCE(agreement_budget.egcs_fc_originalbudgetfiscalyear, agreement_budget.id) = allocation.agreement_budget_fiscal_year_id
            AND agreement_budget._deleted = false
          INNER JOIN "Funding_Case_Agreement_Budget_Version" agreement_budget_version
            ON agreement_budget_version.id = agreement_budget.egcs_fc_budgetversion
            AND agreement_budget_version.egcs_fc_fundingagreement = allocation.agreement_id
            AND agreement_budget_version.egcs_fc_iscurrent = true
            AND agreement_budget_version._deleted = false
          INNER JOIN "Funding_Case_Agreement_Profile" agreement
            ON agreement.id = allocation.agreement_id
            AND agreement._deleted = false
          INNER JOIN "Transfer_Payment_Stream" stream
            ON stream.id = agreement.egcs_fc_transferpaymentstream
            AND stream._deleted = false
          INNER JOIN "Transfer_Payment_Fiscal_Year_Budget" fiscal_budget
            ON fiscal_budget.egcs_tp_transferpaymentprofile = stream.egcs_tp_transferpaymentprofile
            AND fiscal_budget.egcs_tp_fiscalyear = agreement_budget.egcs_fc_fiscalyear
            AND fiscal_budget._deleted = false
          INNER JOIN "Transfer_Payment_Stream_Budget" stream_budget
            ON stream_budget.egcs_tp_transferpaymentbudget = fiscal_budget.id
            AND stream_budget.egcs_tp_transferpaymentstream = stream.id
            AND stream_budget._deleted = false
          WHERE allocation._deleted = false
            AND (
              (TG_TABLE_NAME = 'Agency_Fiscal_Year'
                AND agreement_budget.egcs_fc_fiscalyear = (old_row ->> 'id')::bigint)
              OR (TG_TABLE_NAME = 'Transfer_Payment_Stream'
                AND stream.id = (old_row ->> 'id')::bigint)
              OR (TG_TABLE_NAME = 'Transfer_Payment_Fiscal_Year_Budget'
                AND fiscal_budget.id = (old_row ->> 'id')::bigint)
              OR (TG_TABLE_NAME = 'Transfer_Payment_Stream_Budget'
                AND stream_budget.id = (old_row ->> 'id')::bigint)
            )
        ) THEN
          RAISE EXCEPTION 'Budget mapping rows referenced by active outcome allocations cannot be deleted or reassigned.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'gcs_outcome_cost_allocation_active_budget_mapping_guard';
        END IF;

        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)

    for (const tableName of [
      'Agency_Fiscal_Year',
      'Transfer_Payment_Stream',
      'Transfer_Payment_Fiscal_Year_Budget',
      'Transfer_Payment_Stream_Budget'
    ]) {
      await sql.raw(`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_active_budget_mapping ON "${tableName}"`).execute(db)
      await sql.raw(`
        CREATE TRIGGER gcs_outcome_cost_allocation_guard_active_budget_mapping
        BEFORE UPDATE OR DELETE
        ON "${tableName}"
        FOR EACH ROW
        EXECUTE FUNCTION extensions.gcs_outcome_cost_allocation_guard_active_budget_mapping()
      `).execute(db)
    }
  },
  down: async (db) => {
    const unsafeHistory = await sql<{ unsafe_count: string | number }>`
      SELECT (
        (
          SELECT COUNT(*)
          FROM extensions.gcs_outcome_cost_allocation_commitment_lines
        )
        +
        (
          SELECT COUNT(*)
          FROM extensions.gcs_outcome_cost_allocation_versions
          WHERE _deleted = false
            AND status IN ('active', 'inactive')
        )
      ) AS unsafe_count
    `.execute(db)

    if (Number(unsafeHistory.rows[0]?.unsafe_count ?? 0) > 0) {
      throw new Error(
        'Cannot uninstall outcome cost allocation while generated provenance or completed allocation history exists.'
      )
    }

    for (const tableName of [
      'Agency_Fiscal_Year',
      'Transfer_Payment_Stream',
      'Transfer_Payment_Fiscal_Year_Budget',
      'Transfer_Payment_Stream_Budget'
    ]) {
      await sql.raw(`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_active_budget_mapping ON "${tableName}"`).execute(db)
    }
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_stream_commitment_delete ON "Transfer_Payment_Stream_Chart_of_Account"`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_payment_line ON "Funding_Case_Agreement_Payment_Line"`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_payment_change ON "Funding_Case_Agreement_Payment"`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_payment_insert ON "Funding_Case_Agreement_Payment"`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_commitment ON "Funding_Case_Agreement_Commitment"`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_commitment_line ON "Funding_Case_Agreement_Commitment_Line"`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_commitment_line_provenance ON extensions.gcs_outcome_cost_allocation_commitment_lines`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_validate_commitment_line_provenance ON extensions.gcs_outcome_cost_allocation_commitment_lines`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_allocation ON extensions.gcs_outcome_cost_allocation_allocations`.execute(db)
    await sql`DROP TRIGGER IF EXISTS gcs_outcome_cost_allocation_guard_version ON extensions.gcs_outcome_cost_allocation_versions`.execute(db)

    await sql`DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_active_commitment_line`.execute(db)
    await sql`DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_version_allocation`.execute(db)
    await sql`DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_one_draft_version`.execute(db)
    await sql`DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_one_active_version`.execute(db)
    await sql`DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_unique_version`.execute(db)

    await db.schema.dropTable('extensions.gcs_outcome_cost_allocation_commitment_lines').execute()
    await db.schema.dropTable('extensions.gcs_outcome_cost_allocation_allocations').execute()
    await db.schema.dropTable('extensions.gcs_outcome_cost_allocation_versions').execute()

    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_active_budget_mapping()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_stream_commitment_delete()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_commitment_line_provenance()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_validate_commitment_line_provenance()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_payment_line()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_payment()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_commitment()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_commitment_line()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_allocation()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_guard_version()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_assert_managed_mutation(bigint)`.execute(db)
    await sql`DROP FUNCTION IF EXISTS extensions.gcs_outcome_cost_allocation_lock_agreement(bigint)`.execute(db)
  }
})
