/* eslint-disable jsdoc/require-jsdoc */
import { sql } from 'kysely'
import {
  type AllocationValidationIssue,
  type CostAllocationVersion,
  type CommitmentType,
  type GeneratedCommitmentLineCoverage,
  type OutcomeAllocationInput,
  type OutcomeAllocationResolved,
  type PaidCommitmentLineCoverage,
  type VersionedOutcomeAllocationInput,
  type YearFundingTotal,
  allocatePaymentAmountToCommitmentLines,
  isCommitmentType,
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
  toMoney,
  validateGeneratedCommitmentLinePaymentCoverage,
  validateAllocationReferences,
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

export interface StreamCommitmentLine {
  id: string
  stream_budget_id: string
  fiscal_year_display: string
  gl: number
  gl_description: string
}

type GeneratedAllocationLine = {
  allocation: OutcomeAllocationResolved
  allocationVersionId: string
  streamCommitmentId: string
}

type GeneratedPaymentLine = {
  commitmentLineId: string
  amount: number
}

const PAYMENT_COVERAGE_EXCLUDED_STATUSES = ['denied']

const mapAllocationVersion = (row: {
  id: string
  agreement_id: string
  version_number: number
  status: CostAllocationVersion['status']
  created_at?: Date | string | null
  completed_at?: Date | string | null
}): CostAllocationVersion => ({
  id: String(row.id),
  agreementId: String(row.agreement_id),
  versionNumber: Number(row.version_number),
  status: row.status,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null
})

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

export const getAllocationVersions = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<CostAllocationVersion[]> => {
  const rows = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('agreement_id', '=', agreementId)
    .where('_deleted', '=', false)
    .select([
      'id',
      'agreement_id',
      'version_number',
      'status',
      'created_at',
      'completed_at'
    ])
    .orderBy('version_number', 'desc')
    .execute()

  return rows.map(mapAllocationVersion)
}

export const createDraftAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<CostAllocationVersion> => await db.transaction().execute(async trx => {
  const existingDraft = await trx
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('agreement_id', '=', agreementId)
    .where('status', '=', 'draft')
    .where('_deleted', '=', false)
    .select([
      'id',
      'agreement_id',
      'version_number',
      'status',
      'created_at',
      'completed_at'
    ])
    .orderBy('version_number', 'desc')
    .executeTakeFirst()

  if (existingDraft) {
    return mapAllocationVersion(existingDraft)
  }

  const maxVersion = await trx
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('agreement_id', '=', agreementId)
    .where('_deleted', '=', false)
    .select(eb => eb.fn.max('version_number').as('max_version'))
    .executeTakeFirst()

  const inserted = await trx
    .insertInto('extensions.gcs_outcome_cost_allocation_versions')
    .values({
      agreement_id: agreementId,
      version_number: Number(maxVersion?.max_version ?? 0) + 1,
      status: 'draft'
    })
    .returning([
      'id',
      'agreement_id',
      'version_number',
      'status',
      'created_at',
      'completed_at'
    ])
    .executeTakeFirstOrThrow()

  return mapAllocationVersion(inserted)
})

export const ensureDraftAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<CostAllocationVersion> => {
  const existingDraft = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('agreement_id', '=', agreementId)
    .where('status', '=', 'draft')
    .where('_deleted', '=', false)
    .select([
      'id',
      'agreement_id',
      'version_number',
      'status',
      'created_at',
      'completed_at'
    ])
    .orderBy('version_number', 'desc')
    .executeTakeFirst()

  return existingDraft ? mapAllocationVersion(existingDraft) : await createDraftAllocationVersion(db, agreementId)
}

export const deleteDraftAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string
) => await db.transaction().execute(async trx => {
  const version = await trx
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('id', '=', allocationVersionId)
    .where('agreement_id', '=', agreementId)
    .where('_deleted', '=', false)
    .select(['id', 'status'])
    .executeTakeFirst()

  if (!version || version.status !== 'draft') {
    throw new Error('Only draft cost allocations can be deleted.')
  }

  await trx
    .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
    .set({ _deleted: true })
    .where('agreement_id', '=', agreementId)
    .where('allocation_version_id', '=', allocationVersionId)
    .where('_deleted', '=', false)
    .execute()

  await trx
    .updateTable('extensions.gcs_outcome_cost_allocation_versions')
    .set({ _deleted: true })
    .where('id', '=', allocationVersionId)
    .where('agreement_id', '=', agreementId)
    .where('status', '=', 'draft')
    .where('_deleted', '=', false)
    .execute()
})

export const getAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string
): Promise<CostAllocationVersion | null> => {
  const row = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('id', '=', allocationVersionId)
    .where('agreement_id', '=', agreementId)
    .where('_deleted', '=', false)
    .select([
      'id',
      'agreement_id',
      'version_number',
      'status',
      'created_at',
      'completed_at'
    ])
    .executeTakeFirst()

  return row ? mapAllocationVersion(row) : null
}

export const getActiveAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<CostAllocationVersion | null> => {
  const row = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('agreement_id', '=', agreementId)
    .where('status', '=', 'active')
    .where('_deleted', '=', false)
    .select([
      'id',
      'agreement_id',
      'version_number',
      'status',
      'created_at',
      'completed_at'
    ])
    .executeTakeFirst()

  return row ? mapAllocationVersion(row) : null
}

export const getSavedAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId?: string
): Promise<VersionedOutcomeAllocationInput[]> => {
  let query = db
    .selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
    .where('agreement_id', '=', agreementId)
    .where('_deleted', '=', false)

  if (allocationVersionId) {
    query = query.where('allocation_version_id', '=', allocationVersionId)
  }

  const rows = await query
    .select([
      'allocation_version_id',
      'commitment_type',
      'stream_commitment_id',
      'agreement_budget_fiscal_year_id',
      'outcome_id',
      'allocation_method',
      'allocation_value'
    ])
    .orderBy('id', 'asc')
    .execute()

  return rows.map(row => ({
    allocationVersionId: String(row.allocation_version_id),
    commitmentType: isCommitmentType(row.commitment_type) ? row.commitment_type : 'commitment',
    streamCommitmentId: String(row.stream_commitment_id ?? ''),
    agreementBudgetFiscalYearId: String(row.agreement_budget_fiscal_year_id),
    outcomeId: String(row.outcome_id),
    allocationMethod: row.allocation_method,
    allocationValue: Number(row.allocation_value)
  }))
}

export const getStreamCommitmentLines = async (
  db: OutcomeCostAllocationDb,
  streamId: string
): Promise<StreamCommitmentLine[]> => await db
  .selectFrom('Transfer_Payment_Stream_Commitment')
  .innerJoin(
    'Transfer_Payment_Stream_Budget',
    'Transfer_Payment_Stream_Budget.id',
    'Transfer_Payment_Stream_Commitment.egcs_tp_streambudget'
  )
  .innerJoin(
    'Transfer_Payment_Fiscal_Year_Budget',
    'Transfer_Payment_Fiscal_Year_Budget.id',
    'Transfer_Payment_Stream_Budget.egcs_tp_transferpaymentbudget'
  )
  .innerJoin(
    'Agency_Fiscal_Year',
    'Agency_Fiscal_Year.id',
    'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_fiscalyear'
  )
  .where('Transfer_Payment_Stream_Commitment.egcs_tp_transferpaymentstream', '=', streamId)
  .where('Transfer_Payment_Stream_Commitment._deleted', '=', false)
  .where('Transfer_Payment_Stream_Budget._deleted', '=', false)
  .where('Transfer_Payment_Fiscal_Year_Budget._deleted', '=', false)
  .where('Agency_Fiscal_Year._deleted', '=', false)
  .select([
    'Transfer_Payment_Stream_Commitment.id as id',
    'Transfer_Payment_Stream_Commitment.egcs_tp_streambudget as stream_budget_id',
    'Agency_Fiscal_Year.egcs_ay_fiscalyeardisplay as fiscal_year_display',
    'Transfer_Payment_Stream_Commitment.egcs_tp_gl as gl',
    'Transfer_Payment_Stream_Commitment.egcs_tp_gldescription as gl_description'
  ])
  .orderBy('Agency_Fiscal_Year.egcs_ay_fiscalyear', 'asc')
  .orderBy('Transfer_Payment_Stream_Commitment.egcs_tp_gl', 'asc')
  .execute()

export const saveAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  allocations: OutcomeAllocationInput[]
) => {
  await db.transaction().execute(async trx => {
    const version = await trx
      .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
      .where('id', '=', allocationVersionId)
      .where('agreement_id', '=', agreementId)
      .where('_deleted', '=', false)
      .select(['id', 'status'])
      .executeTakeFirst()

    if (!version || version.status !== 'draft') {
      throw new Error('Only draft cost allocations can be edited.')
    }

    await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ _deleted: true })
      .where('agreement_id', '=', agreementId)
      .where('allocation_version_id', '=', allocationVersionId)
      .where('_deleted', '=', false)
      .execute()

    if (allocations.length > 0) {
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values(allocations.map(allocation => ({
          allocation_version_id: allocationVersionId,
          agreement_id: agreementId,
          commitment_type: allocation.commitmentType ?? 'commitment',
          stream_commitment_id: allocation.streamCommitmentId ?? null,
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

  const yearTotals = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const activeOutcomeIds = new Set(outcomes.map(outcome => String(outcome.id)))

  return validateAllocationTotals(allocations, yearTotals, activeOutcomeIds)
}

const buildGeneratedCommitmentLineCoverage = (
  commitmentTypes: CommitmentType[],
  allocations: OutcomeAllocationResolved[],
  config: ReturnType<typeof parseOutcomeCostAllocationConfig>,
  streamBudgetIdsByAgreementBudgetFiscalYearId: Map<string, string>
): GeneratedCommitmentLineCoverage[] => commitmentTypes.flatMap(commitmentType =>
  allocations
    .filter(allocation => allocation.commitmentType === commitmentType && allocation.amount > 0)
    .flatMap(allocation => {
      const streamBudgetId = streamBudgetIdsByAgreementBudgetFiscalYearId.get(allocation.agreementBudgetFiscalYearId) ?? ''
      const mapping = config.mappings.find(candidate =>
        candidate.commitmentType === commitmentType
        && candidate.outcomeId === allocation.outcomeId
        && candidate.streamBudgetId === streamBudgetId
        && (!allocation.streamCommitmentId || candidate.streamCommitmentId === allocation.streamCommitmentId)
      )

      if (!mapping) {
        return []
      }

      return [{
        commitmentType,
        agreementBudgetFiscalYearId: allocation.agreementBudgetFiscalYearId,
        outcomeId: allocation.outcomeId,
        streamCommitmentId: mapping.streamCommitmentId,
        amount: allocation.amount
      }]
    })
)

const getPaidCommitmentLineCoverage = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  commitmentTypes: CommitmentType[]
): Promise<PaidCommitmentLineCoverage[]> => {
  if (commitmentTypes.length === 0) {
    return []
  }

  const rows = await db
    .selectFrom('Funding_Case_Agreement_Payment_Line')
    .innerJoin(
      'Funding_Case_Agreement_Payment',
      'Funding_Case_Agreement_Payment.id',
      'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment'
    )
    .innerJoin(
      'Funding_Case_Agreement_Commitment_Line',
      'Funding_Case_Agreement_Commitment_Line.id',
      'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline'
    )
    .innerJoin(
      'Funding_Case_Agreement_Commitment',
      'Funding_Case_Agreement_Commitment.id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_commitment'
    )
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_type', 'in', commitmentTypes)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment_Line._deleted', '=', false)
    .where('Funding_Case_Agreement_Payment_Line._deleted', '=', false)
    .where('Funding_Case_Agreement_Payment._deleted', '=', false)
    .where('Funding_Case_Agreement_Payment.egcs_fc_status', 'not in', PAYMENT_COVERAGE_EXCLUDED_STATUSES)
    .select([
      'Funding_Case_Agreement_Commitment_Line.id as commitment_line_id',
      'Funding_Case_Agreement_Commitment.egcs_fc_type as commitment_type',
      'Funding_Case_Agreement_Payment.egcs_fc_fiscalyear as agreement_budget_fiscal_year_id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_transferpaymentstreamcommitment as stream_commitment_id',
      'Funding_Case_Agreement_Payment_Line.egcs_fc_amount as paid_amount'
    ])
    .execute()

  return rows.map(row => ({
    commitmentLineId: String(row.commitment_line_id),
    commitmentType: row.commitment_type,
    agreementBudgetFiscalYearId: String(row.agreement_budget_fiscal_year_id),
    streamCommitmentId: String(row.stream_commitment_id),
    paidAmount: Number(row.paid_amount)
  }))
}

export const validateAllocationPaymentCoverage = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  config: unknown,
  allocations: OutcomeAllocationInput[],
  commitmentTypeFilter?: CommitmentType
): Promise<AllocationValidationIssue[]> => {
  const parsedConfig = parseOutcomeCostAllocationConfig(config)
  const commitmentTypes = commitmentTypeFilter
    ? parsedConfig.enabledCommitmentTypes.filter(type => type === commitmentTypeFilter)
    : parsedConfig.enabledCommitmentTypes
  const scopedAllocations = commitmentTypeFilter
    ? allocations.filter(allocation => allocation.commitmentType === commitmentTypeFilter)
    : allocations.filter(allocation => isCommitmentType(allocation.commitmentType) && commitmentTypes.includes(allocation.commitmentType))

  if (commitmentTypes.length === 0) {
    return []
  }

  const budgetYears = await getAgreementBudgetYears(db, agreementId, streamId)
  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const resolvedAllocations = resolveAllocationAmounts(scopedAllocations, yearTotals)
  const streamBudgetIdsByAgreementBudgetFiscalYearId = new Map(budgetYears.map(year => [
    String(year.id),
    String(year.stream_budget_id ?? '')
  ]))
  const generatedLines = buildGeneratedCommitmentLineCoverage(
    commitmentTypes,
    resolvedAllocations,
    parsedConfig,
    streamBudgetIdsByAgreementBudgetFiscalYearId
  )
  const paidLines = await getPaidCommitmentLineCoverage(db, agreementId, commitmentTypes)

  return validateGeneratedCommitmentLinePaymentCoverage(generatedLines, paidLines)
}

export const completeAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown
): Promise<CostAllocationVersion> => await db.transaction().execute(async trx => {
  const version = await getAllocationVersion(trx as OutcomeCostAllocationDb, agreementId, allocationVersionId)
  if (!version || version.status !== 'draft') {
    throw new Error('Only draft cost allocations can be completed.')
  }

  const allocations = await getSavedAllocations(trx as OutcomeCostAllocationDb, agreementId, allocationVersionId)
  const issues = await validateAgreementAllocations(trx as OutcomeCostAllocationDb, agreementId, streamId, allocations)
  if (issues.length > 0) {
    const error = new Error('Cost allocation validation failed.') as Error & { issues?: AllocationValidationIssue[] }
    error.issues = issues
    throw error
  }

  const coverageIssues = await validateAllocationPaymentCoverage(
    trx as OutcomeCostAllocationDb,
    agreementId,
    streamId,
    config,
    allocations
  )
  if (coverageIssues.length > 0) {
    const error = new Error('Cost allocation payment coverage validation failed.') as Error & { issues?: AllocationValidationIssue[] }
    error.issues = coverageIssues
    throw error
  }

  await trx
    .updateTable('extensions.gcs_outcome_cost_allocation_versions')
    .set({
      status: 'inactive',
      completed_at: sql`COALESCE(completed_at, now())`
    })
    .where('agreement_id', '=', agreementId)
    .where('status', '=', 'active')
    .where('_deleted', '=', false)
    .execute()

  const completed = await trx
    .updateTable('extensions.gcs_outcome_cost_allocation_versions')
    .set({
      status: 'active',
      completed_at: sql`now()`
    })
    .where('id', '=', allocationVersionId)
    .where('agreement_id', '=', agreementId)
    .where('status', '=', 'draft')
    .where('_deleted', '=', false)
    .returning([
      'id',
      'agreement_id',
      'version_number',
      'status',
      'created_at',
      'completed_at'
    ])
    .executeTakeFirstOrThrow()

  return mapAllocationVersion(completed)
})

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
): Promise<{
  status: 'continue'
} | {
  status: 'handled'
  issues: AllocationValidationIssue[]
  lines: GeneratedAllocationLine[]
}> => {
  const parsedConfig = parseOutcomeCostAllocationConfig(config)
  if (!parsedConfig.enabledCommitmentTypes.includes(commitmentType)) {
    return {
      status: 'continue' as const
    }
  }

  const activeVersion = await getActiveAllocationVersion(db, agreementId)
  if (!activeVersion) {
    return {
      status: 'handled' as const,
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED',
        path: 'allocationVersion',
        message: 'apiErrors.extensions.outcome_cost_allocation.active_required'
      }],
      lines: []
    }
  }

  const [allocations, budgetYears, outcomes, activeStreamCommitmentIds] = await Promise.all([
    getSavedAllocations(db, agreementId, activeVersion.id),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAgreementOutcomes(db, agreementId),
    getActiveStreamCommitmentIds(db, streamId)
  ])

  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const scopedAllocations = allocations.filter(allocation => allocation.commitmentType === commitmentType)
  const referenceIssues = validateAllocationReferences(
    scopedAllocations,
    yearTotals,
    new Set(outcomes.map(outcome => String(outcome.id)))
  )
  const resolvedAllocations = resolveAllocationAmounts(scopedAllocations, yearTotals)
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
  const generatedLines = resolvedAllocations
    .filter(allocation => allocation.amount > 0)
    .map(allocation => {
      const streamBudgetId = streamBudgetIdsByAgreementBudgetFiscalYearId.get(allocation.agreementBudgetFiscalYearId) ?? ''
      const mapping = parsedConfig.mappings.find(candidate =>
        candidate.commitmentType === commitmentType
        && candidate.outcomeId === allocation.outcomeId
        && candidate.streamBudgetId === streamBudgetId
        && (!allocation.streamCommitmentId || candidate.streamCommitmentId === allocation.streamCommitmentId)
      )

      return {
        allocation,
        allocationVersionId: activeVersion.id,
        streamCommitmentId: mapping?.streamCommitmentId ?? ''
      }
    })
  const paymentCoverageIssues = await validateAllocationPaymentCoverage(
    db,
    agreementId,
    streamId,
    config,
    allocations,
    commitmentType
  )

  return {
    status: 'handled' as const,
    issues: [...referenceIssues, ...mappingIssues, ...paymentCoverageIssues],
    lines: generatedLines
  }
}

export const getGeneratedPaymentLines = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  commitmentId: string,
  agreementBudgetFiscalYearId: string,
  paymentAmount: number,
  config: unknown
): Promise<{
  status: 'continue'
} | {
  status: 'handled'
  issues: AllocationValidationIssue[]
  lines: GeneratedPaymentLine[]
}> => {
  const commitment = await db
    .selectFrom('Funding_Case_Agreement_Commitment')
    .where('id', '=', commitmentId)
    .where('egcs_fc_fundingagreement', '=', agreementId)
    .where('_deleted', '=', false)
    .select(['id', 'egcs_fc_type'])
    .executeTakeFirst()

  if (!commitment || !isCommitmentType(commitment.egcs_fc_type)) {
    return {
      status: 'continue' as const
    }
  }

  const commitmentType = commitment.egcs_fc_type
  const parsedConfig = parseOutcomeCostAllocationConfig(config)
  if (!parsedConfig.enabledCommitmentTypes.includes(commitmentType)) {
    return {
      status: 'continue' as const
    }
  }

  const activeVersion = await getActiveAllocationVersion(db, agreementId)
  if (!activeVersion) {
    return {
      status: 'handled' as const,
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED',
        path: 'allocationVersion',
        message: 'apiErrors.extensions.outcome_cost_allocation.active_required'
      }],
      lines: []
    }
  }

  const [allocations, budgetYears, outcomes, activeStreamCommitmentIds] = await Promise.all([
    getSavedAllocations(db, agreementId, activeVersion.id),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAgreementOutcomes(db, agreementId),
    getActiveStreamCommitmentIds(db, streamId)
  ])
  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const scopedAllocations = allocations.filter(allocation => allocation.commitmentType === commitmentType)
  const referenceIssues = validateAllocationReferences(
    scopedAllocations,
    yearTotals,
    new Set(outcomes.map(outcome => String(outcome.id)))
  )
  const resolvedAllocations = resolveAllocationAmounts(scopedAllocations, yearTotals)
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
  const paymentAllocations = resolvedAllocations.filter(allocation =>
    allocation.agreementBudgetFiscalYearId === agreementBudgetFiscalYearId
    && allocation.amount > 0
  )

  const desiredStreamCommitmentIds = new Set(paymentAllocations.flatMap(allocation => {
    const streamBudgetId = streamBudgetIdsByAgreementBudgetFiscalYearId.get(allocation.agreementBudgetFiscalYearId) ?? ''
    const mapping = parsedConfig.mappings.find(candidate =>
      candidate.commitmentType === commitmentType
      && candidate.outcomeId === allocation.outcomeId
      && candidate.streamBudgetId === streamBudgetId
      && (!allocation.streamCommitmentId || candidate.streamCommitmentId === allocation.streamCommitmentId)
    )

    return mapping?.streamCommitmentId ? [mapping.streamCommitmentId] : []
  }))

  if (desiredStreamCommitmentIds.size === 0) {
    return {
      status: 'handled' as const,
      issues: [
        ...referenceIssues,
        ...mappingIssues,
        {
          code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_LINES_MISSING',
          path: 'paymentLines',
          message: 'apiErrors.extensions.outcome_cost_allocation.payment_lines_missing'
        }
      ],
      lines: []
    }
  }

  const commitmentLines = await db
    .selectFrom('Funding_Case_Agreement_Commitment_Line')
    .where('egcs_fc_commitment', '=', commitmentId)
    .where('egcs_fc_transferpaymentstreamcommitment', 'in', Array.from(desiredStreamCommitmentIds))
    .where('_deleted', '=', false)
    .select([
      'id',
      'egcs_fc_transferpaymentstreamcommitment',
      'egcs_fc_amount'
    ])
    .forUpdate()
    .execute()
  const commitmentLineByStreamCommitmentId = new Map(commitmentLines.map(line => [
    String(line.egcs_fc_transferpaymentstreamcommitment),
    {
      id: String(line.id),
      amount: Number(line.egcs_fc_amount)
    }
  ]))
  const paidRows = commitmentLines.length === 0
    ? []
    : await db
        .selectFrom('Funding_Case_Agreement_Payment_Line')
        .innerJoin(
          'Funding_Case_Agreement_Payment',
          'Funding_Case_Agreement_Payment.id',
          'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment'
        )
        .where('Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline', 'in', commitmentLines.map(line => String(line.id)))
        .where('Funding_Case_Agreement_Payment_Line._deleted', '=', false)
        .where('Funding_Case_Agreement_Payment._deleted', '=', false)
        .where('Funding_Case_Agreement_Payment.egcs_fc_status', 'not in', PAYMENT_COVERAGE_EXCLUDED_STATUSES)
        .select([
          'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline as commitment_line_id',
          sql<number>`COALESCE(SUM(${sql.ref('Funding_Case_Agreement_Payment_Line.egcs_fc_amount')}), 0)`.as('paid_amount')
        ])
        .groupBy('Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline')
        .execute()
  const paidAmountByCommitmentLineId = new Map(paidRows.map(row => [
    String(row.commitment_line_id),
    Number(row.paid_amount)
  ]))
  const paymentLineInputByCommitmentLineId = new Map<string, {
    commitmentLineId: string
    weightAmount: number
    remainingAmount: number
  }>()
  const paymentLineIssues: AllocationValidationIssue[] = []

  for (const [index, allocation] of paymentAllocations.entries()) {
    const streamBudgetId = streamBudgetIdsByAgreementBudgetFiscalYearId.get(allocation.agreementBudgetFiscalYearId) ?? ''
    const mapping = parsedConfig.mappings.find(candidate =>
      candidate.commitmentType === commitmentType
      && candidate.outcomeId === allocation.outcomeId
      && candidate.streamBudgetId === streamBudgetId
      && (!allocation.streamCommitmentId || candidate.streamCommitmentId === allocation.streamCommitmentId)
    )
    const commitmentLine = mapping?.streamCommitmentId
      ? commitmentLineByStreamCommitmentId.get(mapping.streamCommitmentId)
      : undefined

    if (!mapping || !commitmentLine) {
      paymentLineIssues.push({
        code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_COMMITMENT_LINE_MISSING',
        path: `allocations.${index}`,
        message: 'apiErrors.extensions.outcome_cost_allocation.payment_commitment_line_missing'
      })
      continue
    }

    const paidAmount = paidAmountByCommitmentLineId.get(commitmentLine.id) ?? 0
    const existingInput = paymentLineInputByCommitmentLineId.get(commitmentLine.id)
    paymentLineInputByCommitmentLineId.set(commitmentLine.id, {
      commitmentLineId: commitmentLine.id,
      weightAmount: toMoney((existingInput?.weightAmount ?? 0) + allocation.amount),
      remainingAmount: toMoney(commitmentLine.amount - paidAmount)
    })
  }

  const paymentLineInputs = Array.from(paymentLineInputByCommitmentLineId.values())
  const remainingTotal = toMoney(paymentLineInputs.reduce((sum, line) => sum + line.remainingAmount, 0))
  if (toMoney(paymentAmount) > toMoney(remainingTotal + 0.01)) {
    paymentLineIssues.push({
      code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING',
      path: 'paymentAmount',
      message: 'apiErrors.extensions.outcome_cost_allocation.payment_exceeds_remaining'
    })
  }

  if (referenceIssues.length > 0 || mappingIssues.length > 0 || paymentLineIssues.length > 0) {
    return {
      status: 'handled' as const,
      issues: [...referenceIssues, ...mappingIssues, ...paymentLineIssues],
      lines: []
    }
  }

  const lines = allocatePaymentAmountToCommitmentLines(paymentLineInputs, Number(paymentAmount)).map(line => ({
    commitmentLineId: line.commitmentLineId,
    amount: line.paymentAmount
  }))
  const generatedTotal = toMoney(lines.reduce((sum, line) => sum + line.amount, 0))
  if (Math.abs(generatedTotal - toMoney(paymentAmount)) > 0.01) {
    return {
      status: 'handled' as const,
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING',
        path: 'paymentAmount',
        message: 'apiErrors.extensions.outcome_cost_allocation.payment_exceeds_remaining'
      }],
      lines: []
    }
  }

  return {
    status: 'handled' as const,
    issues: [],
    lines
  }
}
