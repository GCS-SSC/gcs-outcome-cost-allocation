/* eslint-disable jsdoc/require-jsdoc */
import { sql } from 'kysely'
import {
  type CommitmentType,
  type OutcomeAllocationInput,
  type YearFundingTotal,
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
  validateAllocationTotals,
  validateCommitmentMappings
} from '../shared/allocation'
import type { OutcomeCostAllocationDb } from './db'

export interface AgreementOutcome {
  id: string
  label_en: string
  label_fr: string
}

export interface AgreementBudgetYear {
  id: string
  fiscal_year_id: string
  fiscal_year_display: string
  program_funding: number
  stream_budget_id?: string | null
}

export const getAgreementOutcomes = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<AgreementOutcome[]> => await db
  .selectFrom('Funding_Case_Agreement_Activity')
  .innerJoin(
    'Funding_Case_Agreement_Outcome_Activity',
    'Funding_Case_Agreement_Outcome_Activity.egcs_fc_activity',
    'Funding_Case_Agreement_Activity.id'
  )
  .innerJoin(
    'Transfer_Payment_Outcome',
    'Transfer_Payment_Outcome.id',
    'Funding_Case_Agreement_Outcome_Activity.egcs_fc_outcomes'
  )
  .where('Funding_Case_Agreement_Activity.egcs_fc_fundingagreement', '=', agreementId)
  .where('Funding_Case_Agreement_Activity._deleted', '=', false)
  .where('Funding_Case_Agreement_Outcome_Activity._deleted', '=', false)
  .where('Transfer_Payment_Outcome._deleted', '=', false)
  .select([
    'Transfer_Payment_Outcome.id as id',
    'Transfer_Payment_Outcome.egcs_tp_name_en as label_en',
    'Transfer_Payment_Outcome.egcs_tp_name_fr as label_fr'
  ])
  .distinct()
  .orderBy('Transfer_Payment_Outcome.egcs_tp_name_en', 'asc')
  .execute()

export const getAgreementBudgetYears = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string
): Promise<AgreementBudgetYear[]> => await db
  .selectFrom('Funding_Case_Agreement_Budget_Fiscal_Year')
  .innerJoin(
    'Agency_Fiscal_Year',
    'Agency_Fiscal_Year.id',
    'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear'
  )
  .leftJoin('Funding_Case_Agreement_Budget_Line_Item', join => join
    .onRef(
      'Funding_Case_Agreement_Budget_Line_Item.egcs_fc_fundingagreementbudgetfiscalyear',
      '=',
      'Funding_Case_Agreement_Budget_Fiscal_Year.id'
    )
    .on('Funding_Case_Agreement_Budget_Line_Item._deleted', '=', false))
  .leftJoin('Transfer_Payment_Fiscal_Year_Budget', join => join
    .onRef(
      'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_fiscalyear',
      '=',
      'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear'
    )
    .on('Transfer_Payment_Fiscal_Year_Budget._deleted', '=', false))
  .leftJoin('Transfer_Payment_Stream_Budget', join => join
    .onRef(
      'Transfer_Payment_Stream_Budget.egcs_tp_transferpaymentbudget',
      '=',
      'Transfer_Payment_Fiscal_Year_Budget.id'
    )
    .on('Transfer_Payment_Stream_Budget.egcs_tp_transferpaymentstream', '=', streamId)
    .on('Transfer_Payment_Stream_Budget._deleted', '=', false))
  .where('Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement', '=', agreementId)
  .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
  .where('Agency_Fiscal_Year._deleted', '=', false)
  .select([
    'Funding_Case_Agreement_Budget_Fiscal_Year.id as id',
    'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear as fiscal_year_id',
    'Agency_Fiscal_Year.egcs_ay_fiscalyeardisplay as fiscal_year_display',
    'Transfer_Payment_Stream_Budget.id as stream_budget_id',
    sql<number>`COALESCE(SUM("Funding_Case_Agreement_Budget_Line_Item"."egcs_fc_programfunding"), 0)`.as('program_funding')
  ])
  .groupBy([
    'Funding_Case_Agreement_Budget_Fiscal_Year.id',
    'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear',
    'Agency_Fiscal_Year.egcs_ay_fiscalyeardisplay',
    'Agency_Fiscal_Year.egcs_ay_fiscalyear',
    'Transfer_Payment_Stream_Budget.id'
  ])
  .orderBy('Agency_Fiscal_Year.egcs_ay_fiscalyear', 'asc')
  .execute()

export const getSavedAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<OutcomeAllocationInput[]> => {
  const rows = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
    .where('agreement_id', '=', agreementId)
    .where('_deleted', '=', false)
    .select([
      'agreement_budget_fiscal_year_id',
      'outcome_id',
      'allocation_method',
      'allocation_value'
    ])
    .orderBy('id', 'asc')
    .execute()

  return rows.map(row => ({
    agreementBudgetFiscalYearId: String(row.agreement_budget_fiscal_year_id),
    outcomeId: String(row.outcome_id),
    allocationMethod: row.allocation_method,
    allocationValue: Number(row.allocation_value)
  }))
}

export const saveAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocations: OutcomeAllocationInput[]
) => {
  await db.transaction().execute(async trx => {
    await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ _deleted: true })
      .where('agreement_id', '=', agreementId)
      .where('_deleted', '=', false)
      .execute()

    if (allocations.length > 0) {
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values(allocations.map(allocation => ({
          agreement_id: agreementId,
          agreement_budget_fiscal_year_id: allocation.agreementBudgetFiscalYearId,
          outcome_id: allocation.outcomeId,
          allocation_method: allocation.allocationMethod,
          allocation_value: allocation.allocationValue
        })))
        .execute()
    }
  })
}

export const validateAgreementAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocations: OutcomeAllocationInput[]
) => {
  const [outcomes, budgetYears] = await Promise.all([
    getAgreementOutcomes(db, agreementId),
    getAgreementBudgetYears(db, agreementId, streamId)
  ])

  return validateAllocationTotals(
    allocations,
    budgetYears.map(year => ({
      agreementBudgetFiscalYearId: String(year.id),
      programFunding: Number(year.program_funding)
    })),
    new Set(outcomes.map(outcome => String(outcome.id)))
  )
}

export const getActiveStreamCommitmentIds = async (
  db: OutcomeCostAllocationDb,
  streamId: string
): Promise<Set<string>> => {
  const rows = await db
    .selectFrom('Transfer_Payment_Stream_Commitment')
    .where('egcs_tp_transferpaymentstream', '=', streamId)
    .where('_deleted', '=', false)
    .select('id')
    .execute()

  return new Set(rows.map(row => String(row.id)))
}

export const getGeneratedCommitmentLines = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  commitmentType: CommitmentType,
  config: unknown
) => {
  const parsedConfig = parseOutcomeCostAllocationConfig(config)
  if (!parsedConfig.enabledCommitmentTypes.includes(commitmentType)) {
    return {
      status: 'continue' as const
    }
  }

  const [allocations, budgetYears, outcomes, activeStreamCommitmentIds] = await Promise.all([
    getSavedAllocations(db, agreementId),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAgreementOutcomes(db, agreementId),
    getActiveStreamCommitmentIds(db, streamId)
  ])

  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const totalIssues = validateAllocationTotals(
    allocations,
    yearTotals,
    new Set(outcomes.map(outcome => String(outcome.id)))
  )
  const resolvedAllocations = resolveAllocationAmounts(allocations, yearTotals)
  const streamBudgetIdsByAgreementBudgetFiscalYearId = new Map(budgetYears.map(year => [
    String(year.id),
    String(year.stream_budget_id ?? '')
  ]))
  const mappingIssues = validateCommitmentMappings(
    commitmentType,
    resolvedAllocations,
    parsedConfig,
    streamBudgetIdsByAgreementBudgetFiscalYearId,
    activeStreamCommitmentIds
  )

  return {
    status: 'handled' as const,
    issues: [...totalIssues, ...mappingIssues],
    lines: resolvedAllocations
      .filter(allocation => allocation.amount > 0)
      .map(allocation => {
        const streamBudgetId = streamBudgetIdsByAgreementBudgetFiscalYearId.get(allocation.agreementBudgetFiscalYearId) ?? ''
        const mapping = parsedConfig.mappings.find(candidate =>
          candidate.commitmentType === commitmentType
          && candidate.outcomeId === allocation.outcomeId
          && candidate.streamBudgetId === streamBudgetId
        )

        return {
          allocation,
          streamCommitmentId: mapping?.streamCommitmentId ?? ''
        }
      })
  }
}
