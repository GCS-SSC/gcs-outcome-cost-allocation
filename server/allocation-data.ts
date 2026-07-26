import { sql, type Transaction } from 'kysely'
import { lockGcsExtensionLifecycleScope } from '@gcs-ssc/extensions/server'
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
  EXTENSION_KEY,
  allocatePaymentAmountToCommitmentLines,
  fromCents,
  isCommitmentType,
  parseExactNumeric19Scale4,
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
  toCents,
  toMoney,
  validateGeneratedCommitmentLinePaymentCoverage,
  validateAllocationReferences,
  validateAllocationTotals,
  validateCommitmentMappings
} from '../shared/allocation.ts'
import type { OutcomeCostAllocationDb } from './db.ts'
import { createOutcomeCostAllocationUserError } from './errors.ts'

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

type PaymentLineInput = {
  commitmentLineId: string
  weightAmount: number
  remainingAmount: number
}

type CommitmentLinePaymentCoverage = {
  id: string
  amount: number
}

interface AllocationVersionRow {
  id: string
  agreement_id: string
  version_number: number
  status: CostAllocationVersion['status']
  created_at?: Date | string | null
  completed_at?: Date | string | null
  funding_basis_amount?: number | null
}

export interface AgreementAllocationScope {
  agencyId: string
  streamId: string
}

const PAYMENT_COVERAGE_EXCLUDED_STATUSES = ['denied']

const allocationCoordinateKey = (allocation: {
  commitmentType?: CommitmentType
  streamCommitmentId: string
  agreementBudgetFiscalYearId: string
  outcomeId: string
}) => [
  allocation.commitmentType ?? 'commitment',
  allocation.streamCommitmentId,
  allocation.agreementBudgetFiscalYearId,
  allocation.outcomeId
].join(':')

const resolveStoredAllocationAmounts = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[]
): OutcomeAllocationResolved[] => allocations.every(allocation => 'resolvedAmount' in allocation
  && allocation.resolvedAmount !== null
  && allocation.resolvedAmount !== undefined)
  ? allocations.map(allocation => ({
      ...allocation,
      amount: toMoney(
        'resolvedAmount' in allocation && typeof allocation.resolvedAmount === 'number'
          ? allocation.resolvedAmount
          : 0
      )
    }))
  : resolveAllocationAmounts(allocations, yearTotals)

const mapAllocationVersion = (row: AllocationVersionRow): CostAllocationVersion => ({
  id: String(row.id),
  agreementId: String(row.agreement_id),
  versionNumber: Number(row.version_number),
  status: row.status,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  ...(row.funding_basis_amount === null || row.funding_basis_amount === undefined
    ? {}
    : { fundingBasisAmount: Number(row.funding_basis_amount) })
})

/**
 * Loads one agreement allocation version and optionally locks it for a transaction-local status check.
 */
const getAllocationVersionRow = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  lockForUpdate: boolean
): Promise<AllocationVersionRow | null> => {
  let query = db
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
      'completed_at',
      'funding_basis_amount'
    ])

  if (lockForUpdate) {
    query = query.forUpdate()
  }

  return await query.executeTakeFirst() ?? null
}

const getAllocationVersionForUpdate = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string
): Promise<AllocationVersionRow | null> =>
  await getAllocationVersionRow(db, agreementId, allocationVersionId, true)

/**
 * Serializes allocation lifecycle work for one agreement for the duration of the caller's transaction.
 */
export const lockAgreementAllocationLifecycle = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  expectedScope?: AgreementAllocationScope
): Promise<string> => {
  const scope = await db
    .selectFrom('Funding_Case_Agreement_Profile')
    .innerJoin(
      'Transfer_Payment_Stream',
      'Transfer_Payment_Stream.id',
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream'
    )
    .innerJoin(
      'Transfer_Payment_Profile',
      'Transfer_Payment_Profile.id',
      'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile'
    )
    .where('Funding_Case_Agreement_Profile.id', '=', agreementId)
    .where('Funding_Case_Agreement_Profile._deleted', '=', false)
    .where('Transfer_Payment_Stream._deleted', '=', false)
    .where('Transfer_Payment_Profile._deleted', '=', false)
    .select([
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream as stream_id',
      'Transfer_Payment_Profile.egcs_tp_agency as agency_id'
    ])
    .executeTakeFirst()

  if (!scope) {
    throw createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      'agreementId'
    )
  }

  await lockOutcomeCostAllocationScope(
    db,
    String(scope.agency_id),
    String(scope.stream_id)
  )

  const agreement = await db
    .selectFrom('Funding_Case_Agreement_Profile')
    .where('id', '=', agreementId)
    .where('_deleted', '=', false)
    .select([
      'egcs_fc_transferpaymentstream',
      sql`extensions.gcs_outcome_cost_allocation_lock_agreement(
        ${agreementId}::bigint
      )`.$castTo<void>().as('managed_agreement')
    ])
    .executeTakeFirst()

  if (!agreement) {
    throw createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      'agreementId'
    )
  }

  const lockedScope = await db
    .selectFrom('Funding_Case_Agreement_Profile')
    .innerJoin(
      'Transfer_Payment_Stream',
      'Transfer_Payment_Stream.id',
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream'
    )
    .innerJoin(
      'Transfer_Payment_Profile',
      'Transfer_Payment_Profile.id',
      'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile'
    )
    .where('Funding_Case_Agreement_Profile.id', '=', agreementId)
    .where('Funding_Case_Agreement_Profile._deleted', '=', false)
    .where('Transfer_Payment_Stream._deleted', '=', false)
    .where('Transfer_Payment_Profile._deleted', '=', false)
    .select([
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream as stream_id',
      'Transfer_Payment_Profile.egcs_tp_agency as agency_id'
    ])
    .executeTakeFirst()

  if (!lockedScope) {
    throw createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      'agreementId'
    )
  }

  const currentScope: AgreementAllocationScope = {
    agencyId: String(lockedScope.agency_id),
    streamId: String(lockedScope.stream_id)
  }
  const observedScopeChanged = currentScope.agencyId !== String(scope.agency_id)
    || currentScope.streamId !== String(scope.stream_id)
  const expectedScopeChanged = expectedScope !== undefined
    && (currentScope.agencyId !== expectedScope.agencyId
      || currentScope.streamId !== expectedScope.streamId)
  if (observedScopeChanged || expectedScopeChanged) {
    throw createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
      'agreementId'
    )
  }

  return currentScope.streamId
}

/** Takes the OCA agreement advisory lock without acquiring the host agreement row. */
export const lockAgreementAllocationAdvisory = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<void> => {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended('gcs_outcome_cost_allocation.agreement', ${agreementId}::bigint)
    )
  `.execute(db)
}

/**
 * Takes the shared agency/stream lifecycle locks used by host configuration mutations.
 */
export const lockOutcomeCostAllocationScope = async (
  db: OutcomeCostAllocationDb,
  agencyId: string,
  streamId?: string
): Promise<void> => await lockGcsExtensionLifecycleScope(
  db as unknown as Transaction<unknown>,
  EXTENSION_KEY,
  agencyId,
  streamId
)

/**
 * Locks the extension scope and returns its current enabled stream configuration.
 */
export const lockAndGetOutcomeCostAllocationConfig = async (
  db: OutcomeCostAllocationDb,
  agencyId: string,
  streamId: string
): Promise<unknown | null> => {
  await lockOutcomeCostAllocationScope(db, agencyId, streamId)

  const enabled = await db
    .selectFrom('extensions.stream_configuration')
    .innerJoin('extensions.agency_enablement', join => join
      .onRef(
        'extensions.agency_enablement.extension_key',
        '=',
        'extensions.stream_configuration.extension_key'
      )
      .on('extensions.agency_enablement.agency_id', '=', agencyId)
      .on('extensions.agency_enablement.enabled', '=', true)
      .on('extensions.agency_enablement._deleted', '=', false))
    .where('extensions.stream_configuration.stream_id', '=', streamId)
    .where('extensions.stream_configuration.extension_key', '=', EXTENSION_KEY)
    .where('extensions.stream_configuration.enabled', '=', true)
    .where('extensions.stream_configuration._deleted', '=', false)
    .select('extensions.stream_configuration.config')
    .executeTakeFirst()

  return enabled ? enabled.config : null
}

/**
 * Lists distinct non-deleted outcomes linked to active agreement activities, ordered by English label.
 */
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

/**
 * Locks the active activity/outcome relationship used during allocation completion.
 *
 * The agreement row is locked before this helper. That parent lock also prevents new
 * activities while these existing child and reference rows are being stabilized.
 */
const lockAgreementOutcomeReferences = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
): Promise<void> => {
  const activities = await db
    .selectFrom('Funding_Case_Agreement_Activity')
    .where('egcs_fc_fundingagreement', '=', agreementId)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
  const activityIds = activities.map(activity => String(activity.id))
  if (activityIds.length === 0) {
    return
  }

  const outcomeActivities = await db
    .selectFrom('Funding_Case_Agreement_Outcome_Activity')
    .where('egcs_fc_activity', 'in', activityIds)
    .where('_deleted', '=', false)
    .select(['id', 'egcs_fc_outcomes'])
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
  const outcomeIds = [...new Set(outcomeActivities.map(link => String(link.egcs_fc_outcomes)))].sort()
  if (outcomeIds.length === 0) {
    return
  }

  await db
    .selectFrom('Transfer_Payment_Outcome')
    .where('id', 'in', outcomeIds)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
}

/**
 * Lists active agreement budget years with summed program funding and the matching stream-budget id.
 */
export const getAgreementBudgetYears = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string
): Promise<AgreementBudgetYear[]> => {
  const rows = await db
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
  .innerJoin('Transfer_Payment_Stream', join => join
    .on('Transfer_Payment_Stream.id', '=', streamId)
    .on('Transfer_Payment_Stream._deleted', '=', false))
  .leftJoin('Transfer_Payment_Fiscal_Year_Budget', join => join
    .onRef(
      'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_fiscalyear',
      '=',
      'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear'
    )
    .onRef(
      'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_transferpaymentprofile',
      '=',
      'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile'
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

  return rows.map(row => {
    const programFunding = parseExactNumeric19Scale4(row.program_funding)
    if (programFunding === null) {
      throw createOutcomeCostAllocationUserError(
        'GCS_OUTCOME_COST_ALLOCATION_INVALID',
        `budgetYears.${String(row.id)}.programFunding`
      )
    }

    return {
      ...row,
      program_funding: programFunding
    }
  })
}

/**
 * Locks every agreement budget parent and line-item source before capturing one completion funding view.
 *
 * Locking the parent rows also blocks new line items through PostgreSQL foreign-key key-share locking.
 */
const lockAndGetAgreementBudgetYears = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string
): Promise<AgreementBudgetYear[]> => {
  const budgetYears = await db
    .selectFrom('Funding_Case_Agreement_Budget_Fiscal_Year')
    .where('egcs_fc_fundingagreement', '=', agreementId)
    .where('_deleted', '=', false)
    .select([
      'id',
      'egcs_fc_fiscalyear as fiscal_year_id'
    ])
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
  const budgetYearIds = budgetYears.map(year => String(year.id))
  const fiscalYearIds = [...new Set(
    budgetYears.map(year => String(year.fiscal_year_id))
  )].sort()

  if (budgetYearIds.length > 0) {
    await db
      .selectFrom('Funding_Case_Agreement_Budget_Line_Item')
      .where('egcs_fc_fundingagreementbudgetfiscalyear', 'in', budgetYearIds)
      .where('_deleted', '=', false)
      .select('id')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute()
  }

  if (fiscalYearIds.length > 0) {
    await db
      .selectFrom('Agency_Fiscal_Year')
      .where('id', 'in', fiscalYearIds)
      .where('_deleted', '=', false)
      .select('id')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute()
  }

  const stream = await db
    .selectFrom('Transfer_Payment_Stream')
    .where('id', '=', streamId)
    .where('_deleted', '=', false)
    .select(['id', 'egcs_tp_transferpaymentprofile'])
    .forUpdate()
    .executeTakeFirst()

  if (stream && fiscalYearIds.length > 0) {
    const fiscalBudgets = await db
      .selectFrom('Transfer_Payment_Fiscal_Year_Budget')
      .where('egcs_tp_transferpaymentprofile', '=', String(stream.egcs_tp_transferpaymentprofile))
      .where('egcs_tp_fiscalyear', 'in', fiscalYearIds)
      .where('_deleted', '=', false)
      .select('id')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute()
    const fiscalBudgetIds = fiscalBudgets.map(budget => String(budget.id))

    if (fiscalBudgetIds.length > 0) {
      await db
        .selectFrom('Transfer_Payment_Stream_Budget')
        .where('egcs_tp_transferpaymentstream', '=', streamId)
        .where('egcs_tp_transferpaymentbudget', 'in', fiscalBudgetIds)
        .where('_deleted', '=', false)
        .select('id')
        .orderBy('id', 'asc')
        .forUpdate()
        .execute()
    }
  }

  return await getAgreementBudgetYears(db, agreementId, streamId)
}

/**
 * Lists non-deleted allocation versions for an agreement from newest version number to oldest.
 */
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
      'completed_at',
      'funding_basis_amount'
    ])
    .orderBy('version_number', 'desc')
    .execute()

  return rows.map(mapAllocationVersion)
}

/**
 * Reuses an existing draft or transactionally creates the next agreement version number.
 */
export const createDraftAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  expectedScope: AgreementAllocationScope,
  authorizeWrite?: (db: OutcomeCostAllocationDb) => Promise<void>
): Promise<CostAllocationVersion> => await db.transaction().execute(async trx => {
  await lockAgreementAllocationLifecycle(trx, agreementId, expectedScope)
  await authorizeWrite?.(trx)

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
      'completed_at',
      'funding_basis_amount'
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
      'completed_at',
      'funding_basis_amount'
    ])
    .executeTakeFirstOrThrow()

  return mapAllocationVersion(inserted)
})

/**
 * Returns the newest existing draft, creating one only when the agreement has none.
 */
export const ensureDraftAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  expectedScope: AgreementAllocationScope
): Promise<CostAllocationVersion> => await createDraftAllocationVersion(db, agreementId, expectedScope)

/**
 * Soft-deletes a draft and all of its active allocation rows in one transaction.
 */
export const deleteDraftAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  expectedScope: AgreementAllocationScope,
  authorizeWrite?: (db: OutcomeCostAllocationDb) => Promise<void>
) => await db.transaction().execute(async trx => {
  await lockAgreementAllocationLifecycle(trx, agreementId, expectedScope)
  await authorizeWrite?.(trx)

  const version = await getAllocationVersionForUpdate(
    trx,
    agreementId,
    allocationVersionId
  )

  if (!version || version.status !== 'draft') {
    throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_DRAFT_DELETE_REQUIRED', 'allocationVersionId')
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

/**
 * Loads one non-deleted agreement allocation version or returns `null` when it does not exist.
 */
export const getAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string
): Promise<CostAllocationVersion | null> => {
  const row = await getAllocationVersionRow(db, agreementId, allocationVersionId, false)

  return row ? mapAllocationVersion(row) : null
}

/**
 * Loads the agreement's active non-deleted allocation version or returns `null`.
 */
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
      'completed_at',
      'funding_basis_amount'
    ])
    .executeTakeFirst()

  return row ? mapAllocationVersion(row) : null
}

/**
 * Loads non-deleted saved allocations for an agreement, optionally scoped to one version, in insertion order.
 */
export const getSavedAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId?: string
): Promise<VersionedOutcomeAllocationInput[]> => {
  let query = db
    .selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
    .innerJoin(
      'extensions.gcs_outcome_cost_allocation_versions',
      join => join
        .onRef(
          'extensions.gcs_outcome_cost_allocation_versions.id',
          '=',
          'extensions.gcs_outcome_cost_allocation_allocations.allocation_version_id'
        )
        .onRef(
          'extensions.gcs_outcome_cost_allocation_versions.agreement_id',
          '=',
          'extensions.gcs_outcome_cost_allocation_allocations.agreement_id'
        )
        .on('extensions.gcs_outcome_cost_allocation_versions._deleted', '=', false)
    )
    .where('extensions.gcs_outcome_cost_allocation_allocations.agreement_id', '=', agreementId)
    .where('extensions.gcs_outcome_cost_allocation_allocations._deleted', '=', false)

  if (allocationVersionId) {
    query = query.where(
      'extensions.gcs_outcome_cost_allocation_allocations.allocation_version_id',
      '=',
      allocationVersionId
    )
  }

  const rows = await query
    .select([
      'extensions.gcs_outcome_cost_allocation_allocations.allocation_version_id',
      'extensions.gcs_outcome_cost_allocation_allocations.commitment_type',
      'extensions.gcs_outcome_cost_allocation_allocations.stream_commitment_id',
      'extensions.gcs_outcome_cost_allocation_allocations.agreement_budget_fiscal_year_id',
      'extensions.gcs_outcome_cost_allocation_allocations.outcome_id',
      'extensions.gcs_outcome_cost_allocation_allocations.allocation_method',
      'extensions.gcs_outcome_cost_allocation_allocations.allocation_value',
      'extensions.gcs_outcome_cost_allocation_allocations.resolved_amount',
      'extensions.gcs_outcome_cost_allocation_allocations.funding_basis_amount',
      'extensions.gcs_outcome_cost_allocation_allocations.outcome_label_en',
      'extensions.gcs_outcome_cost_allocation_allocations.outcome_label_fr',
      'extensions.gcs_outcome_cost_allocation_allocations.commitment_label_en',
      'extensions.gcs_outcome_cost_allocation_allocations.commitment_label_fr',
      'extensions.gcs_outcome_cost_allocation_allocations.fiscal_year_display'
    ])
    .orderBy('extensions.gcs_outcome_cost_allocation_allocations.id', 'asc')
    .execute()

  return rows.map(row => ({
    allocationVersionId: String(row.allocation_version_id),
    commitmentType: isCommitmentType(row.commitment_type) ? row.commitment_type : 'commitment',
    streamCommitmentId: String(row.stream_commitment_id),
    agreementBudgetFiscalYearId: String(row.agreement_budget_fiscal_year_id),
    outcomeId: String(row.outcome_id),
    allocationMethod: row.allocation_method,
    allocationValue: Number(row.allocation_value),
    ...(row.resolved_amount === null || row.resolved_amount === undefined
      ? {}
      : { resolvedAmount: Number(row.resolved_amount) }),
    ...(row.funding_basis_amount === null || row.funding_basis_amount === undefined
      ? {}
      : { fundingBasisAmount: Number(row.funding_basis_amount) }),
    outcomeLabelEn: row.outcome_label_en,
    outcomeLabelFr: row.outcome_label_fr,
    commitmentLabelEn: row.commitment_label_en,
    commitmentLabelFr: row.commitment_label_fr,
    fiscalYearDisplay: row.fiscal_year_display
  }))
}

/**
 * Lists active stream commitment lines with fiscal-year context, ordered by year then general-ledger code.
 */
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

/**
 * Replaces a draft version's allocations by soft-deleting old rows and inserting the new set transactionally.
 */
const saveAllocationsInTransaction = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  allocations: OutcomeAllocationInput[],
  expectedScope: AgreementAllocationScope,
  authorizeWrite?: (db: OutcomeCostAllocationDb) => Promise<void>
) => {
  await lockAgreementAllocationLifecycle(db, agreementId, expectedScope)
  await authorizeWrite?.(db)

  const version = await getAllocationVersionForUpdate(
    db,
    agreementId,
    allocationVersionId
  )

  if (!version || version.status !== 'draft') {
    throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED', 'allocationVersionId')
  }

  await db
    .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
    .set({ _deleted: true })
    .where('agreement_id', '=', agreementId)
    .where('allocation_version_id', '=', allocationVersionId)
    .where('_deleted', '=', false)
    .execute()

  if (allocations.length > 0) {
    await db
      .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
      .values(allocations.map(allocation => ({
        allocation_version_id: allocationVersionId,
        agreement_id: agreementId,
        commitment_type: allocation.commitmentType ?? 'commitment',
        stream_commitment_id: allocation.streamCommitmentId,
        agreement_budget_fiscal_year_id: allocation.agreementBudgetFiscalYearId,
        outcome_id: allocation.outcomeId,
        allocation_method: allocation.allocationMethod,
        allocation_value: allocation.allocationValue,
        resolved_amount: null,
        funding_basis_amount: null
      })))
      .execute()
  }
}

/**
 * Replaces one draft's saved allocations transactionally.
 */
export const saveAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  allocations: OutcomeAllocationInput[],
  expectedScope: AgreementAllocationScope,
  authorizeWrite?: (db: OutcomeCostAllocationDb) => Promise<void>
) => await db.transaction().execute(async trx =>
  await saveAllocationsInTransaction(
    trx,
    agreementId,
    allocationVersionId,
    allocations,
    expectedScope,
    authorizeWrite
  )
)

/**
 * Validates allocations against current agreement outcomes, budget years, and total program funding.
 */
export const validateAgreementAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocations: OutcomeAllocationInput[],
  capturedBudgetYears?: AgreementBudgetYear[]
) => {
  const outcomes = await getAgreementOutcomes(db, agreementId)
  const budgetYears = capturedBudgetYears
    ?? await getAgreementBudgetYears(db, agreementId, streamId)

  const yearTotals = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const activeOutcomeIds = new Set(outcomes.map(outcome => String(outcome.id)))

  return validateAllocationTotals(allocations, yearTotals, activeOutcomeIds)
}

/**
 * Projects positive mapped allocations into the commitment-line coverage expected after regeneration.
 */
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

/**
 * Loads non-denied payment amounts against active commitment lines for the selected commitment types.
 */
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

/**
 * Stabilizes commitments, payments, and their lines before validating paid coverage.
 */
const lockAgreementPaymentCoverage = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  commitmentTypes: CommitmentType[]
): Promise<void> => {
  if (commitmentTypes.length === 0) {
    return
  }

  const commitments = await db
    .selectFrom('Funding_Case_Agreement_Commitment')
    .where('egcs_fc_fundingagreement', '=', agreementId)
    .where('egcs_fc_type', 'in', commitmentTypes)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
  const commitmentIds = commitments.map(commitment => String(commitment.id))
  if (commitmentIds.length === 0) {
    return
  }

  await db
    .selectFrom('Funding_Case_Agreement_Commitment_Line')
    .where('egcs_fc_commitment', 'in', commitmentIds)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()

  const payments = await db
    .selectFrom('Funding_Case_Agreement_Payment')
    .where('egcs_fc_fundingagreementcommitment', 'in', commitmentIds)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .execute()
  const paymentIds = payments.map(payment => String(payment.id))
  if (paymentIds.length === 0) {
    return
  }

  await db
    .selectFrom('Funding_Case_Agreement_Payment_Line')
    .where('egcs_fc_fundingagreementpayment', 'in', paymentIds)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()

  await db
    .selectFrom('Funding_Case_Agreement_Payment')
    .where('id', 'in', paymentIds)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()

  // A concurrent line insert can commit while the payment lock is being acquired.
  // Re-scan after locking the parent so every now-visible line is stabilized.
  await db
    .selectFrom('Funding_Case_Agreement_Payment_Line')
    .where('egcs_fc_fundingagreementpayment', 'in', paymentIds)
    .where('_deleted', '=', false)
    .select('id')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
}

/**
 * Ensures regenerated lines for enabled commitment types still cover all non-denied paid amounts.
 */
export const validateAllocationPaymentCoverage = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  config: unknown,
  allocations: OutcomeAllocationInput[],
  commitmentTypeFilter?: CommitmentType,
  capturedBudgetYears?: AgreementBudgetYear[]
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

  const budgetYears = capturedBudgetYears
    ?? await getAgreementBudgetYears(db, agreementId, streamId)
  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const resolvedAllocations = resolveStoredAllocationAmounts(scopedAllocations, yearTotals)
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

/**
 * Checks whether restoring one denied generated payment would exceed any generated commitment line.
 * The caller must hold the agreement lifecycle lock for the enclosing transaction.
 */
export const generatedPaymentStatusResurrectionExceedsCoverage = async (
  db: OutcomeCostAllocationDb,
  paymentId: string
): Promise<boolean> => {
  const targetLines = await db
    .selectFrom('Funding_Case_Agreement_Payment_Line')
    .innerJoin(
      'Funding_Case_Agreement_Commitment_Line',
      'Funding_Case_Agreement_Commitment_Line.id',
      'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline'
    )
    .where('Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment', '=', paymentId)
    .where('Funding_Case_Agreement_Payment_Line._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment_Line._deleted', '=', false)
    .select([
      'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline as commitment_line_id',
      'Funding_Case_Agreement_Payment_Line.egcs_fc_amount as payment_amount',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_amount as commitment_amount'
    ])
    .execute()

  for (const targetLine of targetLines) {
    const paid = await db
      .selectFrom('Funding_Case_Agreement_Payment_Line')
      .innerJoin(
        'Funding_Case_Agreement_Payment',
        'Funding_Case_Agreement_Payment.id',
        'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment'
      )
      .where(
        'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline',
        '=',
        String(targetLine.commitment_line_id)
      )
      .where('Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment', '!=', paymentId)
      .where('Funding_Case_Agreement_Payment_Line._deleted', '=', false)
      .where('Funding_Case_Agreement_Payment._deleted', '=', false)
      .where('Funding_Case_Agreement_Payment.egcs_fc_status', 'not in', PAYMENT_COVERAGE_EXCLUDED_STATUSES)
      .select(sql<number>`COALESCE(SUM(${sql.ref('Funding_Case_Agreement_Payment_Line.egcs_fc_amount')}), 0)`.as('paid_amount'))
      .executeTakeFirst()

    if (Number(paid?.paid_amount ?? 0) + Number(targetLine.payment_amount) > Number(targetLine.commitment_amount)) {
      return true
    }
  }

  return false
}

/**
 * Validates every enabled commitment type against current stream mappings before a version is activated.
 */
const validateAllocationCommitmentMappings = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  config: unknown,
  allocations: OutcomeAllocationInput[],
  capturedBudgetYears?: AgreementBudgetYear[]
): Promise<AllocationValidationIssue[]> => {
  const parsedConfig = parseOutcomeCostAllocationConfig(config)
  const disabledTypeIssues = allocations.flatMap((allocation, index) => {
    const commitmentType = allocation.commitmentType ?? 'commitment'
    return parsedConfig.enabledCommitmentTypes.includes(commitmentType)
      ? []
      : [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_TYPE_DISABLED',
          path: `allocations.${index}.commitmentType`,
          message: 'apiErrors.extensions.outcome_cost_allocation.commitment_type_disabled'
        }]
  })
  if (disabledTypeIssues.length > 0) {
    return disabledTypeIssues
  }

  const budgetYears = capturedBudgetYears
    ?? await getAgreementBudgetYears(db, agreementId, streamId)
  const activeStreamCommitmentBudgetIds = await getActiveStreamCommitmentBudgetIds(
    db,
    streamId,
    true
  )
  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const streamBudgetIdsByAgreementBudgetFiscalYearId = new Map(budgetYears.map(year => [
    String(year.id),
    String(year.stream_budget_id ?? '')
  ]))
  const resolvedAllocations = resolveStoredAllocationAmounts(allocations, yearTotals)

  return parsedConfig.enabledCommitmentTypes.flatMap(commitmentType =>
    validateCommitmentMappings(
      commitmentType,
      resolvedAllocations.filter(allocation => allocation.commitmentType === commitmentType),
      parsedConfig,
      streamBudgetIdsByAgreementBudgetFiscalYearId,
      activeStreamCommitmentBudgetIds
    )
  )
}

/**
 * Persists immutable bilingual labels and resolved economics before a draft version is activated.
 */
const snapshotAllocationEconomics = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  allocations: VersionedOutcomeAllocationInput[],
  budgetYears: AgreementBudgetYear[]
): Promise<number> => {
  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const fundingBasisByYearId = new Map(yearTotals.map(year => [
    year.agreementBudgetFiscalYearId,
    toMoney(year.programFunding)
  ]))
  const resolvedAmountByCoordinate = new Map(resolveAllocationAmounts(allocations, yearTotals).map(allocation => [
    allocationCoordinateKey(allocation),
    allocation.amount
  ]))
  const rows = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
    .innerJoin(
      'Transfer_Payment_Outcome',
      'Transfer_Payment_Outcome.id',
      'extensions.gcs_outcome_cost_allocation_allocations.outcome_id'
    )
    .innerJoin(
      'Funding_Case_Agreement_Budget_Fiscal_Year',
      'Funding_Case_Agreement_Budget_Fiscal_Year.id',
      'extensions.gcs_outcome_cost_allocation_allocations.agreement_budget_fiscal_year_id'
    )
    .innerJoin(
      'Agency_Fiscal_Year',
      'Agency_Fiscal_Year.id',
      'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear'
    )
    .innerJoin(
      'Transfer_Payment_Stream_Commitment',
      'Transfer_Payment_Stream_Commitment.id',
      'extensions.gcs_outcome_cost_allocation_allocations.stream_commitment_id'
    )
    .where('extensions.gcs_outcome_cost_allocation_allocations.agreement_id', '=', agreementId)
    .where('extensions.gcs_outcome_cost_allocation_allocations.allocation_version_id', '=', allocationVersionId)
    .where('extensions.gcs_outcome_cost_allocation_allocations._deleted', '=', false)
    .where('Transfer_Payment_Outcome._deleted', '=', false)
    .where('Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false)
    .where('Agency_Fiscal_Year._deleted', '=', false)
    .where('Transfer_Payment_Stream_Commitment._deleted', '=', false)
    .select([
      'extensions.gcs_outcome_cost_allocation_allocations.id as allocation_id',
      'extensions.gcs_outcome_cost_allocation_allocations.commitment_type',
      'extensions.gcs_outcome_cost_allocation_allocations.stream_commitment_id',
      'extensions.gcs_outcome_cost_allocation_allocations.agreement_budget_fiscal_year_id',
      'extensions.gcs_outcome_cost_allocation_allocations.outcome_id',
      'Transfer_Payment_Outcome.egcs_tp_name_en as outcome_label_en',
      'Transfer_Payment_Outcome.egcs_tp_name_fr as outcome_label_fr',
      'Agency_Fiscal_Year.egcs_ay_fiscalyeardisplay as fiscal_year_display',
      'Transfer_Payment_Stream_Commitment.egcs_tp_gl as commitment_gl',
      'Transfer_Payment_Stream_Commitment.egcs_tp_gldescription as commitment_description'
    ])
    .execute()

  for (const row of rows) {
    const commitmentLabel = `GL ${Number(row.commitment_gl)} - ${row.commitment_description}`
    await db
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({
        outcome_label_en: row.outcome_label_en,
        outcome_label_fr: row.outcome_label_fr,
        commitment_label_en: commitmentLabel,
        commitment_label_fr: commitmentLabel,
        fiscal_year_display: row.fiscal_year_display,
        resolved_amount: resolvedAmountByCoordinate.get(allocationCoordinateKey({
          commitmentType: isCommitmentType(row.commitment_type) ? row.commitment_type : 'commitment',
          streamCommitmentId: String(row.stream_commitment_id),
          agreementBudgetFiscalYearId: String(row.agreement_budget_fiscal_year_id),
          outcomeId: String(row.outcome_id)
        })) ?? null,
        funding_basis_amount: fundingBasisByYearId.get(String(row.agreement_budget_fiscal_year_id)) ?? null
      })
      .where('id', '=', String(row.allocation_id))
      .where('agreement_id', '=', agreementId)
      .where('allocation_version_id', '=', allocationVersionId)
      .where('_deleted', '=', false)
      .execute()
  }

  return fromCents(yearTotals.reduce((sum, year) => sum + toCents(year.programFunding), 0))
}

/**
 * Validates a draft, demotes the prior active version, and activates the draft in one transaction.
 */
export const completeAllocationVersionInTransaction = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown,
  expectedScope: AgreementAllocationScope
): Promise<CostAllocationVersion> => {
  await lockAgreementAllocationLifecycle(db, agreementId, expectedScope)

  const versionRow = await getAllocationVersionForUpdate(
    db,
    agreementId,
    allocationVersionId
  )
  if (!versionRow || versionRow.status !== 'draft') {
    throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_DRAFT_COMPLETE_REQUIRED', 'allocationVersionId')
  }

  const allocations = await getSavedAllocations(db, agreementId, allocationVersionId)
  const budgetYears = await lockAndGetAgreementBudgetYears(db, agreementId, streamId)
  await lockAgreementOutcomeReferences(db, agreementId)
  const issues = await validateAgreementAllocations(
    db,
    agreementId,
    streamId,
    allocations,
    budgetYears
  )
  if (issues.length > 0) {
    throw Object.assign(new Error('Cost allocation validation failed.'), { issues })
  }

  const mappingIssues = await validateAllocationCommitmentMappings(
    db,
    agreementId,
    streamId,
    config,
    allocations,
    budgetYears
  )
  if (mappingIssues.length > 0) {
    throw Object.assign(
      new Error('Cost allocation commitment mapping validation failed.'),
      { issues: mappingIssues }
    )
  }

  const parsedConfig = parseOutcomeCostAllocationConfig(config)
  await lockAgreementPaymentCoverage(
    db,
    agreementId,
    parsedConfig.enabledCommitmentTypes
  )
  const coverageIssues = await validateAllocationPaymentCoverage(
    db,
    agreementId,
    streamId,
    config,
    allocations,
    undefined,
    budgetYears
  )
  if (coverageIssues.length > 0) {
    throw Object.assign(
      new Error('Cost allocation payment coverage validation failed.'),
      { issues: coverageIssues }
    )
  }

  const fundingBasisAmount = await snapshotAllocationEconomics(
    db,
    agreementId,
    allocationVersionId,
    allocations,
    budgetYears
  )

  await db
    .updateTable('extensions.gcs_outcome_cost_allocation_versions')
    .set({
      status: 'inactive',
      completed_at: sql`COALESCE(completed_at, now())`
    })
    .where('agreement_id', '=', agreementId)
    .where('status', '=', 'active')
    .where('_deleted', '=', false)
    .execute()

  const completed = await db
    .updateTable('extensions.gcs_outcome_cost_allocation_versions')
    .set({
      status: 'active',
      completed_at: sql`now()`,
      funding_basis_amount: fundingBasisAmount
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
      'completed_at',
      'funding_basis_amount'
    ])
    .executeTakeFirstOrThrow()

  return mapAllocationVersion(completed)
}

/**
 * Validates and activates one draft transactionally.
 */
export const completeAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown,
  expectedScope: AgreementAllocationScope
): Promise<CostAllocationVersion> => await db.transaction().execute(async trx =>
  await completeAllocationVersionInTransaction(
    trx,
    agreementId,
    streamId,
    allocationVersionId,
    config,
    expectedScope
  )
)

/**
 * Saves and activates one draft inside a single outer transaction.
 */
export const saveAndCompleteAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown,
  allocations: OutcomeAllocationInput[],
  expectedScope: AgreementAllocationScope
): Promise<CostAllocationVersion> => await db.transaction().execute(async trx => {
  await saveAllocationsInTransaction(trx, agreementId, allocationVersionId, allocations, expectedScope)
  return await completeAllocationVersionInTransaction(
    trx,
    agreementId,
    streamId,
    allocationVersionId,
    config,
    expectedScope
  )
})

/**
 * Saves and activates a draft using configuration re-read under the shared scope lock.
 */
export const saveAndCompleteAllocationVersionWithCurrentConfiguration = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  agencyId: string,
  streamId: string,
  allocationVersionId: string,
  allocations: OutcomeAllocationInput[],
  authorizeWrite?: (db: OutcomeCostAllocationDb) => Promise<void>
): Promise<CostAllocationVersion> => await db.transaction().execute(async trx => {
  const config = await lockAndGetOutcomeCostAllocationConfig(
    trx,
    agencyId,
    streamId
  )
  if (config === null) {
    throw createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      'config'
    )
  }

  const expectedScope = { agencyId, streamId }
  await saveAllocationsInTransaction(
    trx,
    agreementId,
    allocationVersionId,
    allocations,
    expectedScope,
    authorizeWrite
  )
  return await completeAllocationVersionInTransaction(
    trx,
    agreementId,
    streamId,
    allocationVersionId,
    config,
    expectedScope
  )
})

/**
 * Maps non-deleted commitment-line configuration ids to their current stream budgets.
 */
export const getActiveStreamCommitmentBudgetIds = async (
  db: OutcomeCostAllocationDb,
  streamId: string,
  lockForShare = false
): Promise<Map<string, string>> => {
  let query = db
    .selectFrom('Transfer_Payment_Stream_Commitment')
    .where('egcs_tp_transferpaymentstream', '=', streamId)
    .where('_deleted', '=', false)
    .select([
      'id',
      'egcs_tp_streambudget as stream_budget_id'
    ])

  if (lockForShare) {
    query = query.forShare()
  }

  const rows = await query.execute()

  return new Map(rows.map(row => [
    String(row.id),
    String(row.stream_budget_id)
  ]))
}

/**
 * Resolves allocation-derived commitment-line inputs and validation issues, or defers when the type is not extension-managed.
 */
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

  const [allocations, budgetYears, outcomes, activeStreamCommitmentBudgetIds] = await Promise.all([
    getSavedAllocations(db, agreementId, activeVersion.id),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAgreementOutcomes(db, agreementId),
    getActiveStreamCommitmentBudgetIds(db, streamId)
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
  const resolvedAllocations = resolveStoredAllocationAmounts(scopedAllocations, yearTotals)
  const streamBudgetIdsByAgreementBudgetFiscalYearId = new Map(budgetYears.map(year => [
    String(year.id),
    String(year.stream_budget_id ?? '')
  ]))
  const mappingIssues = validateCommitmentMappings(
    commitmentType,
    resolvedAllocations,
    parsedConfig,
    streamBudgetIdsByAgreementBudgetFiscalYearId,
    activeStreamCommitmentBudgetIds
  )
  const positiveAllocations = resolvedAllocations.filter(allocation => allocation.amount > 0)
  const generatedLines = positiveAllocations
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
    issues: [
      ...referenceIssues,
      ...mappingIssues,
      ...paymentCoverageIssues,
      ...(positiveAllocations.length === 0
        ? [{
            code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING',
            path: 'allocations',
            message: 'apiErrors.extensions.outcome_cost_allocation.commitment_lines_missing'
          }]
        : [])
    ],
    lines: generatedLines
  }
}

const getMappedStreamCommitmentId = (
  parsedConfig: ReturnType<typeof parseOutcomeCostAllocationConfig>,
  commitmentType: CommitmentType,
  allocation: OutcomeAllocationResolved,
  streamBudgetIdsByAgreementBudgetFiscalYearId: Map<string, string>
): string => {
  const streamBudgetId = streamBudgetIdsByAgreementBudgetFiscalYearId.get(allocation.agreementBudgetFiscalYearId) ?? ''
  const mapping = parsedConfig.mappings.find(candidate =>
    candidate.commitmentType === commitmentType
    && candidate.outcomeId === allocation.outcomeId
    && candidate.streamBudgetId === streamBudgetId
    && (!allocation.streamCommitmentId || candidate.streamCommitmentId === allocation.streamCommitmentId)
  )

  return mapping?.streamCommitmentId ?? ''
}

/**
 * Loads and resolves one allocation version's context needed to generate a commitment payment.
 */
const getPaymentContext = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  commitmentType: CommitmentType,
  allocationVersionId: string,
  parsedConfig: ReturnType<typeof parseOutcomeCostAllocationConfig>,
  validateCurrentMappings: boolean
) => {
  const [allocations, budgetYears, outcomes, activeStreamCommitmentBudgetIds] = await Promise.all([
    getSavedAllocations(db, agreementId, allocationVersionId),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAgreementOutcomes(db, agreementId),
    validateCurrentMappings
      ? getActiveStreamCommitmentBudgetIds(db, streamId)
      : Promise.resolve(new Map<string, string>())
  ])
  const yearTotals: YearFundingTotal[] = budgetYears.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  }))
  const scopedAllocations = allocations.filter(allocation => allocation.commitmentType === commitmentType)
  const streamBudgetIdsByAgreementBudgetFiscalYearId = new Map(budgetYears.map(year => [
    String(year.id),
    String(year.stream_budget_id ?? '')
  ]))
  const resolvedAllocations = resolveStoredAllocationAmounts(scopedAllocations, yearTotals)

  return {
    referenceIssues: validateAllocationReferences(
      scopedAllocations,
      yearTotals,
      new Set(outcomes.map(outcome => String(outcome.id)))
    ),
    mappingIssues: validateCurrentMappings
      ? validateCommitmentMappings(
          commitmentType,
          resolvedAllocations,
          parsedConfig,
          streamBudgetIdsByAgreementBudgetFiscalYearId,
          activeStreamCommitmentBudgetIds
        )
      : [],
    resolvedAllocations,
    streamBudgetIdsByAgreementBudgetFiscalYearId
  }
}

const getDesiredStreamCommitmentIds = (
  parsedConfig: ReturnType<typeof parseOutcomeCostAllocationConfig>,
  commitmentType: CommitmentType,
  paymentAllocations: OutcomeAllocationResolved[],
  streamBudgetIdsByAgreementBudgetFiscalYearId: Map<string, string>
): Set<string> => new Set(paymentAllocations.flatMap(allocation => {
  const streamCommitmentId = getMappedStreamCommitmentId(
    parsedConfig,
    commitmentType,
    allocation,
    streamBudgetIdsByAgreementBudgetFiscalYearId
  )

  return streamCommitmentId ? [streamCommitmentId] : []
}))

const commitmentLineAllocationKey = (
  allocationVersionId: string,
  agreementBudgetFiscalYearId: string,
  outcomeId: string,
  streamCommitmentId: string
) => [
  allocationVersionId,
  agreementBudgetFiscalYearId,
  outcomeId,
  streamCommitmentId
].join(':')

/**
 * Locks desired commitment lines and indexes generated lines by their complete allocation provenance.
 */
const getCommitmentLineCoverage = async (
  db: OutcomeCostAllocationDb,
  commitmentId: string,
  desiredStreamCommitmentIds: Set<string>
): Promise<{
  commitmentLineByAllocationKey: Map<string, CommitmentLinePaymentCoverage>
  manualCommitmentLinesByStreamCommitmentId: Map<string, CommitmentLinePaymentCoverage[]>
  paidAmountByCommitmentLineId: Map<string, number>
}> => {
  const commitmentLines = await db
    .selectFrom('Funding_Case_Agreement_Commitment_Line')
    .leftJoin('extensions.gcs_outcome_cost_allocation_commitment_lines', join => join
      .onRef(
        'extensions.gcs_outcome_cost_allocation_commitment_lines.commitment_line_id',
        '=',
        'Funding_Case_Agreement_Commitment_Line.id'
      )
      .on('extensions.gcs_outcome_cost_allocation_commitment_lines._deleted', '=', false))
    .where('Funding_Case_Agreement_Commitment_Line.egcs_fc_commitment', '=', commitmentId)
    .where('Funding_Case_Agreement_Commitment_Line.egcs_fc_transferpaymentstreamcommitment', 'in', Array.from(desiredStreamCommitmentIds))
    .where('Funding_Case_Agreement_Commitment_Line._deleted', '=', false)
    .select([
      'Funding_Case_Agreement_Commitment_Line.id as id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_commitmentlinenumber as line_number',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_transferpaymentstreamcommitment as stream_commitment_id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_amount as amount',
      'extensions.gcs_outcome_cost_allocation_commitment_lines.allocation_version_id as provenance_version_id',
      'extensions.gcs_outcome_cost_allocation_commitment_lines.agreement_budget_fiscal_year_id as provenance_year_id',
      'extensions.gcs_outcome_cost_allocation_commitment_lines.outcome_id as provenance_outcome_id',
      'extensions.gcs_outcome_cost_allocation_commitment_lines.stream_commitment_id as provenance_stream_commitment_id'
    ])
    .orderBy('Funding_Case_Agreement_Commitment_Line.egcs_fc_commitmentlinenumber', 'asc')
    .orderBy('Funding_Case_Agreement_Commitment_Line.id', 'asc')
    .forUpdate('Funding_Case_Agreement_Commitment_Line')
    .execute()
  const commitmentLineByAllocationKey = new Map<string, CommitmentLinePaymentCoverage>()
  const manualCommitmentLinesByStreamCommitmentId = new Map<string, CommitmentLinePaymentCoverage[]>()
  for (const line of commitmentLines) {
    const coverage = {
      id: String(line.id),
      amount: Number(line.amount)
    }
    if (
      line.provenance_version_id !== null
      && line.provenance_year_id !== null
      && line.provenance_outcome_id !== null
      && line.provenance_stream_commitment_id !== null
    ) {
      commitmentLineByAllocationKey.set(
        commitmentLineAllocationKey(
          String(line.provenance_version_id),
          String(line.provenance_year_id),
          String(line.provenance_outcome_id),
          String(line.provenance_stream_commitment_id)
        ),
        coverage
      )
      continue
    }

    const streamCommitmentId = String(line.stream_commitment_id)
    const existingLines = manualCommitmentLinesByStreamCommitmentId.get(streamCommitmentId)
    if (existingLines) {
      existingLines.push(coverage)
    } else {
      manualCommitmentLinesByStreamCommitmentId.set(streamCommitmentId, [coverage])
    }
  }
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

  return {
    commitmentLineByAllocationKey,
    manualCommitmentLinesByStreamCommitmentId,
    paidAmountByCommitmentLineId: new Map(paidRows.map(row => [
      String(row.commitment_line_id),
      Number(row.paid_amount)
    ]))
  }
}

/**
 * Loads immutable generated-line weights and current remaining balances for one historical commitment year.
 */
const getRecordedCommitmentPaymentLineInputs = async (
  db: OutcomeCostAllocationDb,
  commitmentId: string,
  agreementBudgetFiscalYearId: string
): Promise<PaymentLineInput[]> => {
  const commitmentLines = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_commitment_lines')
    .innerJoin(
      'Funding_Case_Agreement_Commitment_Line',
      'Funding_Case_Agreement_Commitment_Line.id',
      'extensions.gcs_outcome_cost_allocation_commitment_lines.commitment_line_id'
    )
    .where('extensions.gcs_outcome_cost_allocation_commitment_lines.generated_commitment_id', '=', commitmentId)
    .where('extensions.gcs_outcome_cost_allocation_commitment_lines.agreement_budget_fiscal_year_id', '=', agreementBudgetFiscalYearId)
    .where('extensions.gcs_outcome_cost_allocation_commitment_lines._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment_Line.egcs_fc_commitment', '=', commitmentId)
    .where('Funding_Case_Agreement_Commitment_Line._deleted', '=', false)
    .select([
      'Funding_Case_Agreement_Commitment_Line.id as commitment_line_id',
      'Funding_Case_Agreement_Commitment_Line.egcs_fc_amount as commitment_line_amount',
      'extensions.gcs_outcome_cost_allocation_commitment_lines.generated_amount as generated_amount'
    ])
    .orderBy('Funding_Case_Agreement_Commitment_Line.egcs_fc_commitmentlinenumber', 'asc')
    .orderBy('Funding_Case_Agreement_Commitment_Line.id', 'asc')
    .forUpdate('Funding_Case_Agreement_Commitment_Line')
    .execute()

  if (commitmentLines.length === 0) {
    return []
  }

  const paidRows = await db
    .selectFrom('Funding_Case_Agreement_Payment_Line')
    .innerJoin(
      'Funding_Case_Agreement_Payment',
      'Funding_Case_Agreement_Payment.id',
      'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment'
    )
    .where(
      'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline',
      'in',
      commitmentLines.map(line => String(line.commitment_line_id))
    )
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

  return commitmentLines.map(line => ({
    commitmentLineId: String(line.commitment_line_id),
    weightAmount: Number(line.generated_amount),
    remainingAmount: toMoney(
      Number(line.commitment_line_amount)
      - (paidAmountByCommitmentLineId.get(String(line.commitment_line_id)) ?? 0)
    )
  }))
}

/**
 * Splits one mapped allocation weight across every manual line for the same stream commitment.
 */
const distributeManualCommitmentLineWeight = (
  commitmentLines: CommitmentLinePaymentCoverage[],
  weightAmount: number
): Array<{
  commitmentLine: CommitmentLinePaymentCoverage
  weightAmount: number
}> => {
  const commitmentLineById = new Map(commitmentLines.map(line => [line.id, line]))
  return allocatePaymentAmountToCommitmentLines(
    commitmentLines.map(line => ({
      commitmentLineId: line.id,
      weightAmount: line.amount,
      remainingAmount: weightAmount
    })),
    weightAmount
  ).flatMap(line => {
    const commitmentLine = commitmentLineById.get(line.commitmentLineId)
    return commitmentLine
      ? [{ commitmentLine, weightAmount: line.paymentAmount }]
      : []
  })
}

/**
 * Aggregates allocation weights by mapped commitment line and reports mappings absent from the commitment.
 */
const getPaymentLineInputs = (
  parsedConfig: ReturnType<typeof parseOutcomeCostAllocationConfig>,
  allocationVersionId: string,
  commitmentType: CommitmentType,
  paymentAllocations: OutcomeAllocationResolved[],
  streamBudgetIdsByAgreementBudgetFiscalYearId: Map<string, string>,
  commitmentLineByAllocationKey: Map<string, CommitmentLinePaymentCoverage>,
  manualCommitmentLinesByStreamCommitmentId: Map<string, CommitmentLinePaymentCoverage[]>,
  paidAmountByCommitmentLineId: Map<string, number>,
  useRecordedProvenance: boolean
): {
  paymentLineInputs: PaymentLineInput[]
  paymentLineIssues: AllocationValidationIssue[]
} => {
  const paymentLineInputByCommitmentLineId = new Map<string, PaymentLineInput>()
  const paymentLineIssues: AllocationValidationIssue[] = []

  for (const [index, allocation] of paymentAllocations.entries()) {
    const streamCommitmentId = useRecordedProvenance
      ? allocation.streamCommitmentId
      : getMappedStreamCommitmentId(
          parsedConfig,
          commitmentType,
          allocation,
          streamBudgetIdsByAgreementBudgetFiscalYearId
        )
    const recordedCommitmentLine = useRecordedProvenance
      ? commitmentLineByAllocationKey.get(commitmentLineAllocationKey(
          allocationVersionId,
          allocation.agreementBudgetFiscalYearId,
          allocation.outcomeId,
          streamCommitmentId
        ))
      : undefined
    const weightedCommitmentLines = recordedCommitmentLine
      ? [{
          commitmentLine: recordedCommitmentLine,
          weightAmount: allocation.amount
        }]
      : distributeManualCommitmentLineWeight(
          manualCommitmentLinesByStreamCommitmentId.get(streamCommitmentId) ?? [],
          allocation.amount
        )

    if (!streamCommitmentId || weightedCommitmentLines.length === 0) {
      paymentLineIssues.push({
        code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_COMMITMENT_LINE_MISSING',
        path: `allocations.${index}`,
        message: 'apiErrors.extensions.outcome_cost_allocation.payment_commitment_line_missing'
      })
      continue
    }

    for (const { commitmentLine, weightAmount: commitmentLineWeight } of weightedCommitmentLines) {
      const paidAmount = paidAmountByCommitmentLineId.get(commitmentLine.id) ?? 0
      const existingInput = paymentLineInputByCommitmentLineId.get(commitmentLine.id)
      paymentLineInputByCommitmentLineId.set(commitmentLine.id, {
        commitmentLineId: commitmentLine.id,
        weightAmount: toMoney((existingInput?.weightAmount ?? 0) + commitmentLineWeight),
        remainingAmount: toMoney(commitmentLine.amount - paidAmount)
      })
    }
  }

  return {
    paymentLineInputs: Array.from(paymentLineInputByCommitmentLineId.values()),
    paymentLineIssues
  }
}

/**
 * Generates a cent-balanced payment split across mapped commitment lines after all active-allocation checks pass.
 */
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
    .leftJoin('extensions.gcs_outcome_cost_allocation_commitment_lines', join => join
      .onRef(
        'extensions.gcs_outcome_cost_allocation_commitment_lines.generated_commitment_id',
        '=',
        'Funding_Case_Agreement_Commitment.id'
      )
      .on('extensions.gcs_outcome_cost_allocation_commitment_lines._deleted', '=', false))
    .where('Funding_Case_Agreement_Commitment.id', '=', commitmentId)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .select([
      'Funding_Case_Agreement_Commitment.id as id',
      'Funding_Case_Agreement_Commitment.egcs_fc_type as egcs_fc_type',
      'extensions.gcs_outcome_cost_allocation_commitment_lines.allocation_version_id as allocation_version_id'
    ])
    .executeTakeFirst()

  if (!commitment || !isCommitmentType(commitment.egcs_fc_type)) {
    return {
      status: 'continue' as const
    }
  }

  const commitmentType = commitment.egcs_fc_type
  const commitmentAllocationVersionId = commitment.allocation_version_id === null
    || commitment.allocation_version_id === undefined
    ? null
    : String(commitment.allocation_version_id)
  const useRecordedProvenance = commitmentAllocationVersionId !== null
  if (useRecordedProvenance) {
    const paymentLineInputs = await getRecordedCommitmentPaymentLineInputs(
      db,
      commitmentId,
      agreementBudgetFiscalYearId
    )
    if (paymentLineInputs.length === 0) {
      return {
        status: 'handled' as const,
        issues: [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_LINES_MISSING',
          path: 'paymentLines',
          message: 'apiErrors.extensions.outcome_cost_allocation.payment_lines_missing'
        }],
        lines: []
      }
    }

    const remainingTotalCents = paymentLineInputs.reduce(
      (sum, line) => sum + toCents(line.remainingAmount),
      0
    )
    if (toCents(paymentAmount) > remainingTotalCents) {
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

    const lines = allocatePaymentAmountToCommitmentLines(
      paymentLineInputs,
      paymentAmount
    ).map(line => ({
      commitmentLineId: line.commitmentLineId,
      amount: line.paymentAmount
    }))
    const generatedTotalCents = lines.reduce((sum, line) => sum + toCents(line.amount), 0)
    if (generatedTotalCents !== toCents(paymentAmount)) {
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

  const parsedConfig = parseOutcomeCostAllocationConfig(config)
  if (!parsedConfig.enabledCommitmentTypes.includes(commitmentType)) {
    return {
      status: 'continue' as const
    }
  }

  const allocationVersion = await getActiveAllocationVersion(db, agreementId)
  if (!allocationVersion) {
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

  const {
    referenceIssues,
    mappingIssues,
    resolvedAllocations,
    streamBudgetIdsByAgreementBudgetFiscalYearId
  } = await getPaymentContext(
    db,
    agreementId,
    streamId,
    commitmentType,
    allocationVersion.id,
    parsedConfig,
    true
  )
  const paymentAllocations = resolvedAllocations.filter(allocation =>
    allocation.agreementBudgetFiscalYearId === agreementBudgetFiscalYearId
    && allocation.amount > 0
  )

  const desiredStreamCommitmentIds = getDesiredStreamCommitmentIds(
    parsedConfig,
    commitmentType,
    paymentAllocations,
    streamBudgetIdsByAgreementBudgetFiscalYearId
  )

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

  const {
    commitmentLineByAllocationKey,
    manualCommitmentLinesByStreamCommitmentId,
    paidAmountByCommitmentLineId
  } = await getCommitmentLineCoverage(db, commitmentId, desiredStreamCommitmentIds)
  const {
    paymentLineInputs,
    paymentLineIssues
  } = getPaymentLineInputs(
    parsedConfig,
    allocationVersion.id,
    commitmentType,
    paymentAllocations,
    streamBudgetIdsByAgreementBudgetFiscalYearId,
    commitmentLineByAllocationKey,
    manualCommitmentLinesByStreamCommitmentId,
    paidAmountByCommitmentLineId,
    useRecordedProvenance
  )
  const remainingTotalCents = paymentLineInputs.reduce(
    (sum, line) => sum + toCents(line.remainingAmount),
    0
  )
  if (toCents(paymentAmount) > remainingTotalCents) {
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
  const generatedTotalCents = lines.reduce((sum, line) => sum + toCents(line.amount), 0)
  if (generatedTotalCents !== toCents(paymentAmount)) {
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
