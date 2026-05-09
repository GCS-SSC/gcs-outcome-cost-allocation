/* eslint-disable jsdoc/require-jsdoc */
import { sql } from 'kysely'
import { defineGcsExtensionMigration } from '@gcs-ssc/extensions/server'

export default defineGcsExtensionMigration({
  async up(db) {
    await sql`
      CREATE TABLE IF NOT EXISTS extensions.gcs_outcome_cost_allocation_versions (
        id bigserial PRIMARY KEY,
        agreement_id bigint NOT NULL REFERENCES "Funding_Case_Agreement_Profile" (id) ON DELETE RESTRICT,
        version_number integer NOT NULL,
        status varchar(20) NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        completed_at timestamp,
        _deleted boolean NOT NULL DEFAULT false,
        CONSTRAINT gcs_outcome_cost_allocation_version_status
          CHECK (status IN ('draft', 'active', 'inactive'))
      )
    `.execute(db)

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS gcs_outcome_cost_allocation_unique_version
      ON extensions.gcs_outcome_cost_allocation_versions (agreement_id, version_number)
      WHERE _deleted = false
    `.execute(db)

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS gcs_outcome_cost_allocation_one_active_version
      ON extensions.gcs_outcome_cost_allocation_versions (agreement_id)
      WHERE _deleted = false AND status = 'active'
    `.execute(db)

    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
      ADD COLUMN IF NOT EXISTS allocation_version_id bigint
      REFERENCES extensions.gcs_outcome_cost_allocation_versions (id) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
        agreement_id,
        version_number,
        status,
        completed_at
      )
      SELECT DISTINCT
        allocation.agreement_id,
        1,
        'active',
        now()
      FROM extensions.gcs_outcome_cost_allocation_allocations allocation
      WHERE allocation._deleted = false
        AND NOT EXISTS (
          SELECT 1
          FROM extensions.gcs_outcome_cost_allocation_versions version
          WHERE version.agreement_id = allocation.agreement_id
            AND version._deleted = false
        )
    `.execute(db)

    await sql`
      UPDATE extensions.gcs_outcome_cost_allocation_allocations allocation
      SET allocation_version_id = version.id
      FROM extensions.gcs_outcome_cost_allocation_versions version
      WHERE allocation.allocation_version_id IS NULL
        AND version.agreement_id = allocation.agreement_id
        AND version.version_number = 1
        AND version._deleted = false
    `.execute(db)

    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
      ALTER COLUMN allocation_version_id SET NOT NULL
    `.execute(db)

    await sql`
      DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_unique_allocation
    `.execute(db)

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS gcs_outcome_cost_allocation_version_allocation
      ON extensions.gcs_outcome_cost_allocation_allocations (
        allocation_version_id,
        agreement_budget_fiscal_year_id,
        outcome_id
      )
      WHERE _deleted = false
    `.execute(db)

    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_commitment_lines
      ADD COLUMN IF NOT EXISTS allocation_version_id bigint
      REFERENCES extensions.gcs_outcome_cost_allocation_versions (id) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
        agreement_id,
        version_number,
        status,
        completed_at
      )
      SELECT DISTINCT
        commitment_line.agreement_id,
        1,
        'active',
        now()
      FROM extensions.gcs_outcome_cost_allocation_commitment_lines commitment_line
      WHERE commitment_line._deleted = false
        AND NOT EXISTS (
          SELECT 1
          FROM extensions.gcs_outcome_cost_allocation_versions version
          WHERE version.agreement_id = commitment_line.agreement_id
            AND version._deleted = false
        )
    `.execute(db)

    await sql`
      UPDATE extensions.gcs_outcome_cost_allocation_commitment_lines commitment_line
      SET allocation_version_id = version.id
      FROM extensions.gcs_outcome_cost_allocation_versions version
      WHERE commitment_line.allocation_version_id IS NULL
        AND version.agreement_id = commitment_line.agreement_id
        AND version.version_number = 1
        AND version._deleted = false
    `.execute(db)

    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_commitment_lines
      ALTER COLUMN allocation_version_id SET NOT NULL
    `.execute(db)
  }
})
