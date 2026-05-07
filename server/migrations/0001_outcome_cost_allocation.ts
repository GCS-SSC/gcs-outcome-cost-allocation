/* eslint-disable jsdoc/require-jsdoc */
import { sql } from 'kysely'
import { defineGcsExtensionMigration } from '@gcs-ssc/extensions/server'

export default defineGcsExtensionMigration({
  async up(db) {
    await db.schema
      .createTable('extensions.gcs_outcome_cost_allocation_allocations')
      .addColumn('id', 'bigserial', col => col.primaryKey())
      .addColumn('agreement_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Profile.id').onDelete('restrict'))
      .addColumn('agreement_budget_fiscal_year_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Budget_Fiscal_Year.id').onDelete('restrict'))
      .addColumn('outcome_id', 'bigint', col => col.notNull().references('Transfer_Payment_Outcome.id').onDelete('restrict'))
      .addColumn('allocation_method', 'varchar(20)', col => col.notNull())
      .addColumn('allocation_value', 'numeric(19, 4)', col => col.notNull())
      .addColumn('_deleted', 'boolean', col => col.defaultTo(false).notNull())
      .addCheckConstraint(
        'gcs_outcome_cost_allocation_method',
        sql`allocation_method IN ('amount', 'percentage')`
      )
      .execute()

    await sql`
      CREATE UNIQUE INDEX gcs_outcome_cost_allocation_active_allocation
      ON extensions.gcs_outcome_cost_allocation_allocations (
        agreement_id,
        agreement_budget_fiscal_year_id,
        outcome_id
      )
      WHERE _deleted = false
    `.execute(db)

    await db.schema
      .createTable('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .addColumn('id', 'bigserial', col => col.primaryKey())
      .addColumn('generated_commitment_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Commitment.id').onDelete('restrict'))
      .addColumn('commitment_line_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Commitment_Line.id').onDelete('restrict'))
      .addColumn('agreement_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Profile.id').onDelete('restrict'))
      .addColumn('agreement_budget_fiscal_year_id', 'bigint', col => col.notNull().references('Funding_Case_Agreement_Budget_Fiscal_Year.id').onDelete('restrict'))
      .addColumn('outcome_id', 'bigint', col => col.notNull().references('Transfer_Payment_Outcome.id').onDelete('restrict'))
      .addColumn('stream_commitment_id', 'bigint', col => col.notNull().references('Transfer_Payment_Stream_Commitment.id').onDelete('restrict'))
      .addColumn('generated_amount', 'numeric(19, 2)', col => col.notNull())
      .addColumn('_deleted', 'boolean', col => col.defaultTo(false).notNull())
      .execute()

    await sql`
      CREATE UNIQUE INDEX gcs_outcome_cost_allocation_active_commitment_line
      ON extensions.gcs_outcome_cost_allocation_commitment_lines (commitment_line_id)
      WHERE _deleted = false
    `.execute(db)
  }
})
