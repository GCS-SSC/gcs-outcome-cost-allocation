import { sql } from 'kysely'
import { defineGcsExtensionMigration } from '@gcs-ssc/extensions/server'

export default defineGcsExtensionMigration({
  up: async (db) => {
    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
      ADD COLUMN IF NOT EXISTS commitment_type bigint
      REFERENCES "Transfer_Payment_Stream_Commitment_Type" (id) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
      ADD COLUMN IF NOT EXISTS stream_commitment_id bigint
      REFERENCES "Transfer_Payment_Stream_Chart_of_Account" (id) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_version_allocation
    `.execute(db)

    await sql`
      DROP INDEX IF EXISTS extensions.gcs_outcome_cost_allocation_scoped_allocation
    `.execute(db)

    await sql`
      ALTER TABLE extensions.gcs_outcome_cost_allocation_allocations
      ALTER COLUMN commitment_type SET NOT NULL,
      ALTER COLUMN stream_commitment_id SET NOT NULL
    `.execute(db)

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
  }
})
