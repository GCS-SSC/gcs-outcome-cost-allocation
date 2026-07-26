import {
  createGcsExtensionUserError,
  defineGcsExtensionNitroPlugin,
  type GcsExtensionAgreementDeleteGuardContext,
  type GcsExtensionAgreementStreamChangeGuardContext,
  type GcsExtensionAgreementLifecycleLockContext,
  type GcsExtensionAgreementPaymentMutationGuardContext,
  type GcsExtensionCreateOperationContext,
  type GcsExtensionCreateOperationResult,
  type GcsExtensionDisableGuardContext,
  registerGcsExtensionAgreementLifecycleLock,
  registerGcsExtensionAgreementDeleteGuard,
  registerGcsExtensionAgreementStreamChangeGuard,
  registerGcsExtensionAgreementPaymentMutationGuard,
  registerGcsExtensionCreateOperationHandler,
  registerGcsExtensionDisableGuard
} from '@gcs-ssc/extensions/server'
import { sql } from 'kysely'
import { asOutcomeCostAllocationDb } from '../db.ts'
import {
  getGeneratedCommitmentLines,
  getGeneratedPaymentLines,
  generatedPaymentStatusResurrectionExceedsCoverage,
  lockAndGetOutcomeCostAllocationConfig,
  lockAgreementAllocationAdvisory,
  lockAgreementAllocationLifecycle,
  lockOutcomeCostAllocationScope
} from '../allocation-data.ts'
import {
  bilingualAllocationIssues,
  getOutcomeCostAllocationErrorMessages
} from '../errors.ts'
import {
  type AllocationValidationIssue,
  type CommitmentType,
  EXTENSION_KEY,
  isCommitmentType,
  parseExactNumeric19Scale4
} from '../../shared/allocation.ts'

type CreateOperationContext = GcsExtensionCreateOperationContext
type CreateOperationResult = GcsExtensionCreateOperationResult

const continueCreateOperation = (): CreateOperationResult => ({ status: 'continue' })

const outcomeCostAllocationScopeChanged = () => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_SCOPE_CHANGED',
  statusCode: 409,
  message: {
    en: 'The agreement scope changed while the operation was being prepared. Retry the operation.',
    fr: 'La portee de l entente a change pendant la preparation de l operation. Reessayez l operation.'
  }
})

/** Safely detects whether the extension-owned lifecycle tables have been migrated. */
const outcomeCostAllocationLifecycleTablesExist = async (
  db: ReturnType<typeof asOutcomeCostAllocationDb>
): Promise<boolean> => {
  const result = await sql<{
    commitment_lines_table: string | null
    versions_table: string | null
  }>`
    SELECT
      to_regclass('extensions.gcs_outcome_cost_allocation_commitment_lines')::text
        AS commitment_lines_table,
      to_regclass('extensions.gcs_outcome_cost_allocation_versions')::text
        AS versions_table
  `.execute(db)
  const tables = result.rows[0]

  return Boolean(tables?.commitment_lines_table) && Boolean(tables?.versions_table)
}

const extensionDisableBlocked = () => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_DISABLE_BLOCKED',
  statusCode: 409,
  message: {
    en: 'Outcome cost allocation cannot be disabled while allocation-generated commitments exist. Keep the extension enabled so future payments remain managed.',
    fr: 'La repartition des couts par resultat ne peut pas etre desactivee tant que des engagements generes existent. Gardez l extension activee afin que les paiements futurs restent geres.'
  }
})

const agreementStreamChangeBlocked = () => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_AGREEMENT_STREAM_CHANGE_BLOCKED',
  statusCode: 409,
  message: {
    en: 'This agreement cannot be moved to another stream because outcome cost allocation history already exists.',
    fr: 'Cette entente ne peut pas etre deplacee vers un autre volet, car un historique de repartition des couts par resultat existe deja.'
  }
})

const agreementDeleteBlocked = () => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_AGREEMENT_DELETE_BLOCKED',
  statusCode: 409,
  message: {
    en: 'This agreement cannot be deleted because outcome cost allocation history or generated records exist.',
    fr: 'Cette entente ne peut pas etre supprimee, car un historique de repartition des couts par resultat ou des enregistrements generes existent.'
  }
})

const generatedPaymentMutationBlocked = (path: string) => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
  statusCode: 409,
  message: getOutcomeCostAllocationErrorMessages('GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE'),
  details: [{
    path,
    code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
    message: getOutcomeCostAllocationErrorMessages('GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE')
  }]
})

const paymentCoverageConflict = () => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING',
  statusCode: 409,
  message: getOutcomeCostAllocationErrorMessages('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING'),
  details: [{
    path: 'paymentId',
    code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING',
    message: getOutcomeCostAllocationErrorMessages('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING')
  }]
})

const hasGeneratedPayment = async (
  db: ReturnType<typeof asOutcomeCostAllocationDb>,
  paymentIds: string[]
): Promise<boolean> => Boolean(await db
  .selectFrom('Funding_Case_Agreement_Payment')
  .innerJoin(
    'extensions.gcs_outcome_cost_allocation_commitment_lines',
    'extensions.gcs_outcome_cost_allocation_commitment_lines.generated_commitment_id',
    'Funding_Case_Agreement_Payment.egcs_fc_fundingagreementcommitment'
  )
  .where('Funding_Case_Agreement_Payment.id', 'in', paymentIds)
  .where('Funding_Case_Agreement_Payment._deleted', '=', false)
  .where('extensions.gcs_outcome_cost_allocation_commitment_lines._deleted', '=', false)
  .select('Funding_Case_Agreement_Payment.id')
  .executeTakeFirst())

const hasGeneratedCommitment = async (
  db: ReturnType<typeof asOutcomeCostAllocationDb>,
  commitmentId: unknown
): Promise<boolean> => {
  if (commitmentId === undefined || commitmentId === null || commitmentId === '') {
    return false
  }

  return Boolean(await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_commitment_lines')
    .where('generated_commitment_id', '=', String(commitmentId))
    .where('_deleted', '=', false)
    .select('id')
    .executeTakeFirst())
}

const hasGeneratedCommitmentLine = async (
  db: ReturnType<typeof asOutcomeCostAllocationDb>,
  commitmentLineId: unknown
): Promise<boolean> => {
  if (commitmentLineId === undefined || commitmentLineId === null || commitmentLineId === '') {
    return false
  }

  return Boolean(await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_commitment_lines')
    .where('commitment_line_id', '=', String(commitmentLineId))
    .where('_deleted', '=', false)
    .select('id')
    .executeTakeFirst())
}

/** Detects generated provenance on both existing records and requested mutation destinations. */
const mutationTouchesGeneratedPayment = async (
  db: ReturnType<typeof asOutcomeCostAllocationDb>,
  context: GcsExtensionAgreementPaymentMutationGuardContext
): Promise<boolean> => {
  const requestedPaymentId = context.changes?.egcs_fc_fundingagreementpayment
  const paymentIds = [...new Set([
    context.paymentId,
    ...(requestedPaymentId === undefined || requestedPaymentId === null || requestedPaymentId === ''
      ? []
      : [String(requestedPaymentId)])
  ])]
  if (await hasGeneratedPayment(db, paymentIds)) {
    return true
  }

  if (context.operation === 'payment.update') {
    return await hasGeneratedCommitment(
      db,
      context.changes?.egcs_fc_fundingagreementcommitment
    )
  }

  if (context.operation === 'payment-line.create' || context.operation === 'payment-line.update') {
    return await hasGeneratedCommitmentLine(
      db,
      context.changes?.egcs_fc_fundingagreementcommitmentline
    )
  }

  return false
}

const GENERATED_PAYMENT_SENSITIVE_FIELDS = new Set([
  'egcs_fc_fundingagreementcommitment',
  'egcs_fc_fiscalyear',
  'egcs_fc_paymentamount',
  '_deleted'
])

/** Loads and locks the payment status after the agreement lifecycle lock is held. */
const getLockedPaymentStatus = async (
  db: ReturnType<typeof asOutcomeCostAllocationDb>,
  agreementId: string,
  paymentId: string
): Promise<string | null> => {
  const payment = await db
    .selectFrom('Funding_Case_Agreement_Payment')
    .innerJoin(
      'Funding_Case_Agreement_Commitment',
      'Funding_Case_Agreement_Commitment.id',
      'Funding_Case_Agreement_Payment.egcs_fc_fundingagreementcommitment'
    )
    .where('Funding_Case_Agreement_Payment.id', '=', paymentId)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Payment._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .select('Funding_Case_Agreement_Payment.egcs_fc_status')
    .forUpdate('Funding_Case_Agreement_Payment')
    .executeTakeFirst()

  return payment ? String(payment.egcs_fc_status) : null
}

/** Serializes and preflights host edits that can affect generated payment coverage. */
const guardAgreementPaymentMutation = async (
  context: GcsExtensionAgreementPaymentMutationGuardContext
): Promise<void> => {
  const db = asOutcomeCostAllocationDb(context.db)
  if (!await outcomeCostAllocationLifecycleTablesExist(db)) {
    return
  }

  await lockAgreementAllocationLifecycle(db, context.agreementId)

  if (!await mutationTouchesGeneratedPayment(db, context)) {
    return
  }

  if (context.operation === 'payment.status-change') {
    const currentStatus = await getLockedPaymentStatus(
      db,
      context.agreementId,
      context.paymentId
    )
    if (
      currentStatus === 'denied'
      && context.nextStatus !== undefined
      && context.nextStatus !== 'denied'
      && await generatedPaymentStatusResurrectionExceedsCoverage(db, context.paymentId)
    ) {
      throw paymentCoverageConflict()
    }
    return
  }

  if (context.operation === 'payment.update') {
    const changesSensitiveField = Object.keys(context.changes ?? {})
      .some(field => GENERATED_PAYMENT_SENSITIVE_FIELDS.has(field))
    if (!changesSensitiveField) {
      return
    }
    throw generatedPaymentMutationBlocked('paymentId')
  }

  throw generatedPaymentMutationBlocked(context.operation.startsWith('payment-line.') ? 'paymentLineId' : 'paymentId')
}

/** Acquires the OCA advisory lock during the host's pre-row agreement lock phase. */
const lockAgreementLifecycle = async (
  context: GcsExtensionAgreementLifecycleLockContext
): Promise<void> => {
  await lockAgreementAllocationAdvisory(
    asOutcomeCostAllocationDb(context.db),
    context.agreementId
  )
}

const throwOutcomeCostAllocationIssues = (
  issues: AllocationValidationIssue[]
) => {
  const code = issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
  throw createGcsExtensionUserError({
    code,
    message: getOutcomeCostAllocationErrorMessages(code),
    details: bilingualAllocationIssues(issues)
  })
}

/**
 * Lists agreement ids whose generated provenance would depend on the disabled scope.
 */
const getDisableScopeAgreementIds = async (
  context: GcsExtensionDisableGuardContext
): Promise<string[]> => {
  const db = asOutcomeCostAllocationDb(context.db)
  let query = db
    .selectFrom('Funding_Case_Agreement_Profile')
    .innerJoin(
      'Transfer_Payment_Stream',
      'Transfer_Payment_Stream.id',
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream'
    )
    .where('Funding_Case_Agreement_Profile._deleted', '=', false)
    .where('Transfer_Payment_Stream._deleted', '=', false)
    .select('Funding_Case_Agreement_Profile.id')
    .distinct()
    .orderBy('Funding_Case_Agreement_Profile.id', 'asc')

  if (context.scope === 'stream' && context.streamId) {
    query = query.where(
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream',
      '=',
      context.streamId
    )
  } else {
    query = query
      .innerJoin(
        'Transfer_Payment_Profile',
        'Transfer_Payment_Profile.id',
        'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile'
      )
      .where('Transfer_Payment_Profile.egcs_tp_agency', '=', context.agencyId)
      .where('Transfer_Payment_Profile._deleted', '=', false)
  }

  return (await query.execute()).map(agreement => String(agreement.id))
}

/**
 * Serializes disable with generated work, then rejects scopes containing immutable provenance.
 */
const guardExtensionDisable = async (
  context: GcsExtensionDisableGuardContext
): Promise<void> => {
  const db = asOutcomeCostAllocationDb(context.db)
  await lockOutcomeCostAllocationScope(
    db,
    context.agencyId,
    context.scope === 'stream' ? context.streamId : undefined
  )
  const agreementIds = await getDisableScopeAgreementIds(context)
  for (const agreementId of agreementIds) {
    await lockAgreementAllocationLifecycle(db, agreementId)
  }

  if (agreementIds.length === 0) {
    return
  }

  const provenance = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_commitment_lines')
    .where('agreement_id', 'in', agreementIds)
    .select('id')
    .executeTakeFirst()
  if (provenance) {
    throw extensionDisableBlocked()
  }
}

/**
 * Serializes stream reassignment with generated work and preserves all allocation history in its original scope.
 */
const guardAgreementStreamChange = async (
  context: GcsExtensionAgreementStreamChangeGuardContext
): Promise<void> => {
  const db = asOutcomeCostAllocationDb(context.db)
  if (!await outcomeCostAllocationLifecycleTablesExist(db)) {
    return
  }
  const streamIds = [...new Set([
    context.currentStreamId,
    context.nextStreamId
  ])].sort()

  for (const streamId of streamIds) {
    await lockOutcomeCostAllocationScope(db, context.agencyId, streamId)
  }
  await lockAgreementAllocationLifecycle(db, context.agreementId)

  const history = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('agreement_id', '=', context.agreementId)
    .where('_deleted', '=', false)
    .select('id')
    .executeTakeFirst()
  if (history) {
    throw agreementStreamChangeBlocked()
  }
}

/** Preserves allocation history and generated provenance when the host deletes an agreement. */
const guardAgreementDelete = async (
  context: GcsExtensionAgreementDeleteGuardContext
): Promise<void> => {
  const db = asOutcomeCostAllocationDb(context.db)
  if (!await outcomeCostAllocationLifecycleTablesExist(db)) {
    return
  }

  await lockAgreementAllocationLifecycle(db, context.agreementId)

  const history = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .where('agreement_id', '=', context.agreementId)
    .select('id')
    .executeTakeFirst()
  const generatedProvenance = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_commitment_lines')
    .where('agreement_id', '=', context.agreementId)
    .select('id')
    .executeTakeFirst()

  if (history || generatedProvenance) {
    throw agreementDeleteBlocked()
  }
}

/**
 * Inserts a commitment, its generated lines, and allocation provenance in the operation transaction.
 */
const createGeneratedCommitment = async (
  context: CreateOperationContext,
  commitmentType: CommitmentType,
  generated: Extract<Awaited<ReturnType<typeof getGeneratedCommitmentLines>>, { status: 'handled' }>
) => {
  const db = asOutcomeCostAllocationDb(context.trx)
  const commitment = await db
    .insertInto('Funding_Case_Agreement_Commitment')
    .values({
      egcs_fc_fundingagreement: context.agreementId,
      egcs_fc_type: commitmentType,
      egcs_fc_status: 'inprogress',
      egcs_fc_financialsystemnumber: null
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  if (generated.lines.length === 0) {
    return commitment
  }

  const commitmentLines = await db
    .insertInto('Funding_Case_Agreement_Commitment_Line')
    .values(generated.lines.map((line, index) => ({
      egcs_fc_commitment: String(commitment.id),
      egcs_fc_commitmentlinenumber: index + 1,
      egcs_fc_transferpaymentstreamcommitment: line.streamCommitmentId,
      egcs_fc_amount: line.allocation.amount
    })))
    .returningAll()
    .execute()

  await db
    .insertInto('extensions.gcs_outcome_cost_allocation_commitment_lines')
    .values(commitmentLines.map(line => {
      const generatedLine = generated.lines[line.egcs_fc_commitmentlinenumber - 1]
      if (!generatedLine) {
        throw new Error('Generated commitment line association is missing.')
      }

      return {
        allocation_version_id: generatedLine.allocationVersionId,
        generated_commitment_id: String(commitment.id),
        commitment_line_id: String(line.id),
        agreement_id: context.agreementId,
        agreement_budget_fiscal_year_id: generatedLine.allocation.agreementBudgetFiscalYearId,
        outcome_id: generatedLine.allocation.outcomeId,
        stream_commitment_id: generatedLine.streamCommitmentId,
        generated_amount: generatedLine.allocation.amount
      }
    }))
    .execute()

  return commitment
}

/**
 * Handles supported commitment creation from the active allocation or lets the host continue unchanged.
 */
const handleCommitmentCreate = async (context: CreateOperationContext): Promise<CreateOperationResult> => {
  const commitmentType = context.validatedBody.egcs_fc_type
  if (!isCommitmentType(commitmentType) || context.createdRecord) {
    return continueCreateOperation()
  }

  const db = asOutcomeCostAllocationDb(context.trx)
  const config = await lockAndGetOutcomeCostAllocationConfig(
    db,
    context.agencyId,
    context.streamId
  )
  if (config === null) {
    return continueCreateOperation()
  }
  const lockedStreamId = await lockAgreementAllocationLifecycle(db, context.agreementId)
  if (lockedStreamId !== context.streamId) {
    throw outcomeCostAllocationScopeChanged()
  }
  const generated = await getGeneratedCommitmentLines(
    db,
    context.agreementId,
    context.streamId,
    commitmentType,
    config
  )

  if (generated.status === 'continue') {
    return continueCreateOperation()
  }

  if (generated.issues.length > 0) {
    throwOutcomeCostAllocationIssues(generated.issues)
  }

  return {
    status: 'handled',
    response: await createGeneratedCommitment(context, commitmentType, generated)
  }
}

const getRecordStringValue = (record: Record<string, unknown> | undefined, key: string): string => {
  if (!record) {
    return ''
  }

  const value = record[key]
  return value === undefined || value === null ? '' : String(value)
}

const getPaymentCreateCommitmentId = (context: CreateOperationContext): string => {
  const validatedCommitmentId = getRecordStringValue(context.validatedBody, 'egcs_fc_fundingagreementcommitment')
  return validatedCommitmentId || getRecordStringValue(context.createdRecord, 'egcs_fc_fundingagreementcommitment')
}

const getPaymentCreateAmount = (context: CreateOperationContext): number => {
  const value = context.validatedBody.egcs_fc_paymentamount
  if (value === undefined || value === null || value === '') {
    return 0
  }

  const parsed = parseExactNumeric19Scale4(value)
  return parsed === null ? Number.NaN : parsed
}

const getPaymentCreateInputs = (context: CreateOperationContext) => {
  return {
    paymentId: getRecordStringValue(context.createdRecord, 'id'),
    commitmentId: getPaymentCreateCommitmentId(context),
    agreementBudgetFiscalYearId: getRecordStringValue(context.validatedBody, 'egcs_fc_fiscalyear'),
    paymentAmount: getPaymentCreateAmount(context)
  }
}

const paymentCreateInputsAreComplete = (inputs: ReturnType<typeof getPaymentCreateInputs>): boolean =>
  Boolean(inputs.paymentId)
  && Boolean(inputs.commitmentId)
  && Boolean(inputs.agreementBudgetFiscalYearId)
  && inputs.paymentAmount > 0

const paymentCreateRequestInputsAreComplete = (inputs: ReturnType<typeof getPaymentCreateInputs>): boolean =>
  Boolean(inputs.commitmentId)
  && Boolean(inputs.agreementBudgetFiscalYearId)
  && inputs.paymentAmount > 0

/**
 * Inserts generated payment lines and advances a matching draft payment to in-progress.
 */
const createGeneratedPaymentLines = async (
  context: CreateOperationContext,
  paymentId: string,
  generated: Extract<Awaited<ReturnType<typeof getGeneratedPaymentLines>>, { status: 'handled' }>
) => {
  const db = asOutcomeCostAllocationDb(context.trx)
  await db
    .insertInto('Funding_Case_Agreement_Payment_Line')
    .values(generated.lines.map(line => ({
      egcs_fc_fundingagreementpayment: paymentId,
      egcs_fc_fundingagreementcommitmentline: line.commitmentLineId,
      egcs_fc_amount: line.amount
    })))
    .execute()

  await db
    .updateTable('Funding_Case_Agreement_Payment')
    .set({ egcs_fc_status: 'inprogress' })
    .where('id', '=', paymentId)
    .where('egcs_fc_status', '=', 'draft')
    .where('_deleted', '=', false)
    .execute()
}

/**
 * Adds allocation-derived lines after host payment creation when all required inputs are present.
 */
const handlePaymentCreate = async (context: CreateOperationContext): Promise<CreateOperationResult> => {
  const inputs = getPaymentCreateInputs(context)
  if (!Number.isFinite(inputs.paymentAmount)) {
    throwOutcomeCostAllocationIssues([{
      code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      path: 'egcs_fc_paymentamount',
      message: 'apiErrors.extensions.outcome_cost_allocation.invalid'
    }])
  }
  if (!paymentCreateRequestInputsAreComplete(inputs)) {
    return continueCreateOperation()
  }

  const db = asOutcomeCostAllocationDb(context.trx)
  const config = await lockAndGetOutcomeCostAllocationConfig(
    db,
    context.agencyId,
    context.streamId
  )
  if (config === null) {
    return continueCreateOperation()
  }
  const lockedStreamId = await lockAgreementAllocationLifecycle(db, context.agreementId)
  if (lockedStreamId !== context.streamId) {
    throw outcomeCostAllocationScopeChanged()
  }

  if (!context.createdRecord) {
    return continueCreateOperation()
  }

  const {
    paymentId,
    commitmentId,
    agreementBudgetFiscalYearId,
    paymentAmount
  } = inputs
  if (!paymentCreateInputsAreComplete({ paymentId, commitmentId, agreementBudgetFiscalYearId, paymentAmount })) {
    return continueCreateOperation()
  }

  const generated = await getGeneratedPaymentLines(
    db,
    context.agreementId,
    context.streamId,
    commitmentId,
    agreementBudgetFiscalYearId,
    paymentAmount,
    config
  )

  if (generated.status === 'continue') {
    return continueCreateOperation()
  }

  if (generated.issues.length > 0) {
    throwOutcomeCostAllocationIssues(generated.issues)
  }

  if (generated.lines.length > 0) {
    await createGeneratedPaymentLines(context, paymentId, generated)
  }

  return continueCreateOperation()
}

/**
 * Registers allocation-aware create handlers that generate commitment and payment records in host transactions.
 */
export default defineGcsExtensionNitroPlugin(nitroApp => {
  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.commitments.create', handleCommitmentCreate, nitroApp)
  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.payments.create', handlePaymentCreate, nitroApp)
  registerGcsExtensionDisableGuard(EXTENSION_KEY, guardExtensionDisable, nitroApp)
  registerGcsExtensionAgreementLifecycleLock(EXTENSION_KEY, lockAgreementLifecycle, nitroApp)
  registerGcsExtensionAgreementDeleteGuard(EXTENSION_KEY, guardAgreementDelete, nitroApp)
  registerGcsExtensionAgreementStreamChangeGuard(EXTENSION_KEY, guardAgreementStreamChange, nitroApp)
  registerGcsExtensionAgreementPaymentMutationGuard(EXTENSION_KEY, guardAgreementPaymentMutation, nitroApp)
})
