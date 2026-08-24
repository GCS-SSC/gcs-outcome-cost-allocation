import { sql } from 'kysely'
import { defineGcsExtensionMigration } from '@gcs-ssc/extensions/server'

/** Adds outcome-allocation provenance only for the unmistakable demo showcase Agreement. */
export default defineGcsExtensionMigration({
  up: async db => await db.transaction().execute(async trx => {
    const showcase = await trx.selectFrom('Funding_Case_Agreement_Profile')
      .select('id')
      .where('id', '=', '51')
      .where('egcs_fc_title_en', '=', 'Health Canada Cost Agreement 1 - Showcase')
      .where('_deleted', '=', false)
      .executeTakeFirst()
    if (!showcase) return

    await sql`SELECT extensions.gcs_outcome_cost_allocation_lock_agreement(51)`.execute(trx)
    const version = await trx.insertInto('extensions.gcs_outcome_cost_allocation_versions')
      .values({ agreement_id: '51', version_number: 1, status: 'draft' })
      .returning('id')
      .executeTakeFirstOrThrow()

    await sql`
      WITH budget_lines AS (
        SELECT line.id, year.id AS year_id, year.egcs_fc_fiscalyear,
          line.egcs_fc_programfunding,
          row_number() OVER (PARTITION BY year.id ORDER BY line.id) AS ordinal
        FROM "Funding_Case_Agreement_Budget_Fiscal_Year" year
        JOIN "Funding_Case_Agreement_Budget_Version" budget_version
          ON budget_version.id = year.egcs_fc_budgetversion
         AND budget_version.egcs_fc_iscurrent = true AND budget_version._deleted = false
        JOIN "Funding_Case_Agreement_Budget_Line_Item" line
          ON line.egcs_fc_fundingagreementbudgetfiscalyear = year.id AND line._deleted = false
        WHERE year.egcs_fc_fundingagreement = 51 AND year._deleted = false
      ), charts AS (
        SELECT budget_lines.year_id,
          stream_budget.id AS stream_budget_id,
          chart.id AS chart_id,
          row_number() OVER (PARTITION BY budget_lines.year_id ORDER BY chart.id) AS ordinal
        FROM (SELECT DISTINCT year_id, egcs_fc_fiscalyear FROM budget_lines) budget_lines
        JOIN "Transfer_Payment_Stream" stream ON stream.id = 31 AND stream._deleted = false
        JOIN "Transfer_Payment_Fiscal_Year_Budget" fiscal_budget
          ON fiscal_budget.egcs_tp_transferpaymentprofile = stream.egcs_tp_transferpaymentprofile
         AND fiscal_budget.egcs_tp_fiscalyear = budget_lines.egcs_fc_fiscalyear
         AND fiscal_budget._deleted = false
        JOIN "Transfer_Payment_Stream_Budget" stream_budget
          ON stream_budget.egcs_tp_transferpaymentbudget = fiscal_budget.id
         AND stream_budget.egcs_tp_transferpaymentstream = stream.id AND stream_budget._deleted = false
        JOIN "Transfer_Payment_Stream_Chart_of_Account" chart
          ON chart.egcs_tp_streambudget = stream_budget.id
         AND chart.egcs_tp_transferpaymentstream = stream.id AND chart._deleted = false
      ), outcomes AS (
        SELECT outcome.*, row_number() OVER (ORDER BY outcome.id) AS ordinal
        FROM "Transfer_Payment_Outcome" outcome
        JOIN "Transfer_Payment_Stream" stream ON stream.id = 31
        WHERE outcome.egcs_tp_transferpaymentprofile = stream.egcs_tp_transferpaymentprofile
          AND outcome._deleted = false
      ), commitment_type AS (
        SELECT id FROM "Transfer_Payment_Stream_Commitment_Type"
        WHERE egcs_tp_transferpaymentstream = 31 AND egcs_tp_name_en = 'Commitment' AND _deleted = false
        ORDER BY id LIMIT 1
      )
      INSERT INTO extensions.gcs_outcome_cost_allocation_allocations (
        allocation_version_id, agreement_id, commitment_type, stream_commitment_id,
        agreement_budget_fiscal_year_id, outcome_id, allocation_method, allocation_value,
        resolved_amount, funding_basis_amount, outcome_label_en, outcome_label_fr,
        commitment_label_en, commitment_label_fr, fiscal_year_display, _deleted
      )
      SELECT ${String(version.id)}::bigint, 51, commitment_type.id, charts.chart_id,
        budget_lines.year_id, outcomes.id, 'amount', budget_lines.egcs_fc_programfunding,
        budget_lines.egcs_fc_programfunding, budget_lines.egcs_fc_programfunding,
        outcomes.egcs_tp_name_en, outcomes.egcs_tp_name_fr,
        concat('Showcase commitment line ', budget_lines.ordinal),
        concat('Ligne d engagement vitrine ', budget_lines.ordinal),
        fiscal_year.egcs_ay_fiscalyeardisplay, false
      FROM budget_lines
      JOIN charts ON charts.year_id = budget_lines.year_id AND charts.ordinal = budget_lines.ordinal
      JOIN outcomes ON outcomes.ordinal = budget_lines.ordinal
      CROSS JOIN commitment_type
      JOIN "Agency_Fiscal_Year" fiscal_year ON fiscal_year.id = budget_lines.egcs_fc_fiscalyear
    `.execute(trx)

    const activeStatus = await trx.selectFrom('Common_Status')
      .innerJoin('Transfer_Payment_Profile', 'Transfer_Payment_Profile.egcs_tp_agency', 'Common_Status.egcs_cn_agency')
      .innerJoin('Transfer_Payment_Stream', 'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile', 'Transfer_Payment_Profile.id')
      .select('Common_Status.id')
      .where('Transfer_Payment_Stream.id', '=', '31')
      .where('Common_Status.egcs_cn_name_en', '=', 'Active')
      .where('Common_Status._deleted', '=', false)
      .executeTakeFirstOrThrow()
    await trx.updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ lifecycle_status_id: String(activeStatus.id) })
      .where('id', '=', String(version.id)).execute()
    await trx.updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ status: 'active', completed_at: new Date('2026-07-16T00:00:00Z'), funding_basis_amount: 165 })
      .where('id', '=', String(version.id)).execute()

    const actor = await trx.selectFrom('Common_User').select('id')
      .where('egcs_cn_email', '=', 'root@example.com').where('_deleted', '=', false).executeTakeFirstOrThrow()
    await trx.insertInto('Common_Completion').values({
      egcs_cn_entitytype: 'gcs-outcome-cost-allocation:allocation-version',
      egcs_cn_entityid: String(version.id),
      egcs_cn_comments: 'Showcase allocation completed before commitment and payment generation.',
      egcs_cn_user: String(actor.id),
      egcs_cn_disposition: 'no_workflow',
      egcs_cn_completedat: new Date('2026-07-16T00:00:00Z'),
      _deleted: false
    }).execute()

    await sql`
      INSERT INTO extensions.gcs_outcome_cost_allocation_commitment_lines (
        allocation_version_id, generated_commitment_id, commitment_line_id, agreement_id,
        agreement_budget_fiscal_year_id, outcome_id, stream_commitment_id, generated_amount, _deleted
      )
      SELECT ${String(version.id)}::bigint, commitment.id, line.id, 51,
        allocation.agreement_budget_fiscal_year_id, allocation.outcome_id,
        allocation.stream_commitment_id, line.egcs_fc_amount, false
      FROM "Funding_Case_Agreement_Commitment" commitment
      JOIN "Funding_Case_Agreement_Commitment_Line" line
        ON line.egcs_fc_commitment = commitment.id AND line._deleted = false
      JOIN extensions.gcs_outcome_cost_allocation_allocations allocation
        ON allocation.allocation_version_id = ${String(version.id)}::bigint
       AND allocation.stream_commitment_id = line.egcs_fc_transferpaymentstreamchartofaccount
       AND allocation.resolved_amount = line.egcs_fc_amount
       AND allocation._deleted = false
      WHERE commitment.egcs_fc_fundingagreement = 51
        AND commitment.egcs_fc_financialsystemnumber = '510001'
        AND commitment._deleted = false
    `.execute(trx)
  })
})
