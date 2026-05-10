/* eslint-disable jsdoc/require-jsdoc */
import {
  createGcsExtensionUserError,
  registerGcsExtensionCreateOperationHandler
} from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import {
  getGeneratedCommitmentLines,
  getGeneratedPaymentLines
} from '../allocation-data'
import {
  getOutcomeCostAllocationErrorMessage,
  localizeAllocationIssues
} from '../errors'
import {
  EXTENSION_KEY,
  isCommitmentType
} from '../../shared/allocation'

export default defineNitroPlugin(nitroApp => {
  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.commitments.create', async context => {
    const commitmentType = context.validatedBody.egcs_fc_type
    if (!isCommitmentType(commitmentType)) {
      return { status: 'continue' }
    }

    if (context.createdRecord) {
      return { status: 'continue' }
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
      return { status: 'continue' }
    }

    if (generated.issues.length > 0) {
      const code = generated.issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
      throw createGcsExtensionUserError({
        code,
        message: getOutcomeCostAllocationErrorMessage(context.event as Parameters<typeof getOutcomeCostAllocationErrorMessage>[0], code),
        details: localizeAllocationIssues(context.event as Parameters<typeof localizeAllocationIssues>[0], generated.issues)
      })
    }

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

    if (generated.lines.length > 0) {
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
    }

    return {
      status: 'handled',
      response: commitment
    }
  }, nitroApp as Parameters<typeof registerGcsExtensionCreateOperationHandler>[3])

  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.payments.create', async context => {
    if (!context.createdRecord) {
      return { status: 'continue' }
    }

    const paymentId = String(context.createdRecord.id ?? '')
    const commitmentId = String(
      context.validatedBody.egcs_fc_fundingagreementcommitment
      ?? context.createdRecord?.egcs_fc_fundingagreementcommitment
      ?? ''
    )
    const agreementBudgetFiscalYearId = String(context.validatedBody.egcs_fc_fiscalyear ?? '')
    const paymentAmount = Number(context.validatedBody.egcs_fc_paymentamount ?? 0)
    if (!paymentId || !commitmentId || !agreementBudgetFiscalYearId || paymentAmount <= 0) {
      return { status: 'continue' }
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
      return { status: 'continue' }
    }

    if (generated.issues.length > 0) {
      const code = generated.issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
      throw createGcsExtensionUserError({
        code,
        message: getOutcomeCostAllocationErrorMessage(context.event as Parameters<typeof getOutcomeCostAllocationErrorMessage>[0], code),
        details: localizeAllocationIssues(context.event as Parameters<typeof localizeAllocationIssues>[0], generated.issues)
      })
    }

    if (generated.lines.length === 0) {
      return { status: 'continue' }
    }

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

    return { status: 'continue' }
  }, nitroApp as Parameters<typeof registerGcsExtensionCreateOperationHandler>[3])
})
