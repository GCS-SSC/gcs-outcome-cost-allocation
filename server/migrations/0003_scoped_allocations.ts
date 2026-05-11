/* eslint-disable jsdoc/require-jsdoc */
import { sql } from 'kysely'
import { defineGcsExtensionMigration } from '@gcs-ssc/extensions/server'

export default defineGcsExtensionMigration({
  async up(db) {
    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
      ADD COLUMN IF NOT EXISTS commitment_type varchar(20) NOT NULL DEFAULT 'commitment'
    `.execute(db)

    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
      ADD COLUMN IF NOT EXISTS stream_commitment_id bigint
      REFERENCES "Transfer_Payment_Stream_Commitment" (id) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'gcs_outcome_cost_allocation_commitment_type'
        ) THEN
          ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
          ADD CONSTRAINT gcs_outcome_cost_allocation_commitment_type
          CHECK (commitment_type IN ('commitment', 'paye', 'paye2', 'pyp'));
        END IF;
      END
      $$;
    `.execute(db)

    await sql`
      DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_version_allocation
    `.execute(db)

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS gcs_outcome_cost_allocation_scoped_allocation
      ON extensions.gcs_outcome_cost_allocation_allocations (
        allocation_version_id,
        commitment_type,
        stream_commitment_id,
        agreement_budget_fiscal_year_id,
        outcome_id
      )
      WHERE _deleted = false
    `.execute(db)
  }
})
