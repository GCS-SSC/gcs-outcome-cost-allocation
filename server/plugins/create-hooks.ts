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
  type GcsExtensionStatusReferenceGuardContext,
  registerGcsExtensionAgreementLifecycleLock,
  registerGcsExtensionAgreementDeleteGuard,
  registerGcsExtensionAgreementStreamChangeGuard,
  registerGcsExtensionAgreementPaymentMutationGuard,
  registerGcsExtensionCreateOperationHandler,
  registerGcsExtensionDisableGuard,
  registerGcsExtensionStatusReferenceGuard
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
  type AllocationMoney,
  type CommitmentType,
  EXTENSION_KEY,
  isCommitmentType,
  parseAllocationMoney,
  toCents
} from '../../shared/allocation.ts'
import { databaseMoneyValue } from '../numeric.ts'

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

const allocationStatusReferenced = () => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_STATUS_REFERENCED',
  statusCode: 409,
  message: {
    en: 'This status is still referenced by outcome cost allocation history.',
    fr: 'Ce statut est toujours reference par un historique de repartition des couts par resultat.'
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
): Promise<{ id: string, terminal: boolean } | null> => {
  const payment = await db
    .selectFrom('Funding_Case_Agreement_Payment')
    .innerJoin(
      'Funding_Case_Agreement_Commitment',
      'Funding_Case_Agreement_Commitment.id',
      'Funding_Case_Agreement_Payment.egcs_fc_fundingagreementcommitment'
    )
    .innerJoin('Common_Status', 'Common_Status.id', 'Funding_Case_Agreement_Payment.egcs_fc_status')
    .where('Funding_Case_Agreement_Payment.id', '=', paymentId)
    .where('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', agreementId)
    .where('Funding_Case_Agreement_Payment._deleted', '=', false)
    .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
    .select([
      'Funding_Case_Agreement_Payment.egcs_fc_status',
      'Common_Status.egcs_cn_terminal as status_terminal'
    ])
    .forUpdate('Funding_Case_Agreement_Payment')
    .executeTakeFirst()

  return payment
    ? { id: String(payment.egcs_fc_status), terminal: payment.status_terminal === true }
    : null
}

const isTerminalStatus = async (
  db: ReturnType<typeof asOutcomeCostAllocationDb>,
  statusId: string
): Promise<boolean> => {
  const status = await db
    .selectFrom('Common_Status')
    .select('egcs_cn_terminal')
    .where('id', '=', statusId)
    .where('_deleted', '=', false)
    .executeTakeFirst()
  return status?.egcs_cn_terminal === true
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
      currentStatus?.terminal === true
      && context.nextStatusId !== undefined
      && !await isTerminalStatus(db, context.nextStatusId)
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

/** Blocks deletion of a status referenced by non-deleted allocation history in its canonical Agency. */
export const guardOutcomeCostAllocationStatusReference = async (
  context: GcsExtensionStatusReferenceGuardContext
): Promise<void> => {
  const db = asOutcomeCostAllocationDb(context.db)
  if (!await outcomeCostAllocationLifecycleTablesExist(db)) {
    return
  }

  const reference = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions as allocation_version')
    .innerJoin(
      'Funding_Case_Agreement_Profile as agreement',
      'agreement.id',
      'allocation_version.agreement_id'
    )
    .innerJoin(
      'Transfer_Payment_Stream as stream',
      'stream.id',
      'agreement.egcs_fc_transferpaymentstream'
    )
    .innerJoin(
      'Transfer_Payment_Profile as profile',
      'profile.id',
      'stream.egcs_tp_transferpaymentprofile'
    )
    .select('allocation_version.id')
    .where('allocation_version.lifecycle_status_id', '=', context.statusId)
    .where('allocation_version._deleted', '=', false)
    .where('agreement._deleted', '=', false)
    .where('stream._deleted', '=', false)
    .where('profile._deleted', '=', false)
    .where('profile.egcs_tp_agency', '=', context.agencyId)
    .executeTakeFirst()

  if (reference) {
    throw allocationStatusReferenced()
  }
}

/**
 * Inserts generated lines and provenance for the host-created commitment.
 */
const createGeneratedCommitment = async (
  context: CreateOperationContext,
  commitmentType: CommitmentType,
  generated: Extract<Awaited<ReturnType<typeof getGeneratedCommitmentLines>>, { status: 'handled' }>
) => {
  const db = asOutcomeCostAllocationDb(context.trx)
  const commitmentId = getRecordStringValue(context.createdRecord, 'id')
  if (!commitmentId) throw new Error('Host-created commitment identity is missing.')

  if (generated.lines.length === 0) {
    return
  }

  const commitmentLines = await db
    .insertInto('Funding_Case_Agreement_Commitment_Line')
    .values(generated.lines.map((line, index) => ({
      egcs_fc_commitment: commitmentId,
      egcs_fc_commitmentlinenumber: index + 1,
      egcs_fc_transferpaymentstreamchartofaccount: line.streamCommitmentId,
      egcs_fc_amount: databaseMoneyValue(line.allocation.amount)
    })))
    .returning(['id', 'egcs_fc_commitmentlinenumber'])
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
        generated_commitment_id: commitmentId,
        commitment_line_id: String(line.id),
        agreement_id: context.agreementId,
        agreement_budget_fiscal_year_id: generatedLine.allocation.agreementBudgetFiscalYearId,
        outcome_id: generatedLine.allocation.outcomeId,
        stream_commitment_id: generatedLine.streamCommitmentId,
        generated_amount: databaseMoneyValue(generatedLine.allocation.amount)
      }
    }))
    .execute()

}

/**
 * Handles supported commitment creation from the active allocation or lets the host continue unchanged.
 */
const handleCommitmentCreate = async (context: CreateOperationContext): Promise<CreateOperationResult> => {
  const commitmentType = context.validatedBody.egcs_fc_type
  if (!isCommitmentType(commitmentType)) {
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

  if (!context.createdRecord) return continueCreateOperation()
  await createGeneratedCommitment(context, commitmentType, generated)
  return continueCreateOperation()
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

const getPaymentCreateAmount = (context: CreateOperationContext): AllocationMoney | null => {
  const value = context.validatedBody.egcs_fc_paymentamount
  if (value === undefined || value === null || value === '') {
    return null
  }

  return parseAllocationMoney(value)
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
  && inputs.paymentAmount !== null
  && toCents(inputs.paymentAmount) > 0n

const paymentCreateRequestInputsAreComplete = (inputs: ReturnType<typeof getPaymentCreateInputs>): boolean =>
  Boolean(inputs.commitmentId)
  && Boolean(inputs.agreementBudgetFiscalYearId)
  && inputs.paymentAmount !== null
  && toCents(inputs.paymentAmount) > 0n

/**
 * Inserts generated payment lines for the host-created draft payment.
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
      egcs_fc_amount: databaseMoneyValue(line.amount)
    })))
    .execute()

}

/**
 * Adds allocation-derived lines after host payment creation when all required inputs are present.
 */
const handlePaymentCreate = async (context: CreateOperationContext): Promise<CreateOperationResult> => {
  const inputs = getPaymentCreateInputs(context)
  if (inputs.paymentAmount === null && context.validatedBody.egcs_fc_paymentamount !== undefined) {
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
  if (paymentAmount === null) return continueCreateOperation()

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
  registerGcsExtensionStatusReferenceGuard(EXTENSION_KEY, guardOutcomeCostAllocationStatusReference, nitroApp)
})
