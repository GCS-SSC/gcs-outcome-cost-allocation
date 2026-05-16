/* eslint-disable jsdoc/require-jsdoc */
import {
  createGcsExtensionUserError,
  type GcsExtensionCreateOperationContext,
  type GcsExtensionCreateOperationResult,
  registerGcsExtensionCreateOperationHandler
} from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import {
  getGeneratedCommitmentLines,
  getGeneratedPaymentLines
} from '../allocation-data'
import {
  bilingualAllocationIssues,
  getOutcomeCostAllocationErrorMessages
} from '../errors'
import {
  type AllocationValidationIssue,
  type CommitmentType,
  EXTENSION_KEY,
  isCommitmentType
} from '../../shared/allocation'

type CreateOperationContext = GcsExtensionCreateOperationContext
type CreateOperationResult = GcsExtensionCreateOperationResult

const continueCreateOperation = (): CreateOperationResult => ({ status: 'continue' })

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
    .values(commitmentLines.map((line, index) => {
      const generatedLine = generated.lines[index]
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

const handleCommitmentCreate = async (context: CreateOperationContext): Promise<CreateOperationResult> => {
  const commitmentType = context.validatedBody.egcs_fc_type
  if (!isCommitmentType(commitmentType) || context.createdRecord) {
    return continueCreateOperation()
  }

  const db = asOutcomeCostAllocationDb(context.trx)
  const generated = await getGeneratedCommitmentLines(
    db,
    context.agreementId,
    context.streamId,
    commitmentType,
    context.config
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

const getPaymentCreateAmount = (context: CreateOperationContext): number =>
  Number(context.validatedBody.egcs_fc_paymentamount ?? 0)

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

const handlePaymentCreate = async (context: CreateOperationContext): Promise<CreateOperationResult> => {
  if (!context.createdRecord) {
    return continueCreateOperation()
  }

  const {
    paymentId,
    commitmentId,
    agreementBudgetFiscalYearId,
    paymentAmount
  } = getPaymentCreateInputs(context)
  if (!paymentCreateInputsAreComplete({ paymentId, commitmentId, agreementBudgetFiscalYearId, paymentAmount })) {
    return continueCreateOperation()
  }

  const db = asOutcomeCostAllocationDb(context.trx)
  const generated = await getGeneratedPaymentLines(
    db,
    context.agreementId,
    context.streamId,
    commitmentId,
    agreementBudgetFiscalYearId,
    paymentAmount,
    context.config
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

export default defineNitroPlugin(nitroApp => {
  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.commitments.create', handleCommitmentCreate, nitroApp as Parameters<typeof registerGcsExtensionCreateOperationHandler>[3])
  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.payments.create', handlePaymentCreate, nitroApp as Parameters<typeof registerGcsExtensionCreateOperationHandler>[3])
})
