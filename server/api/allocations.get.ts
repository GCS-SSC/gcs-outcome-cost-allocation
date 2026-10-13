import { defineGcsExtensionRouteHandler, requireGcsExtensionAgreementFinancials } from '@gcs-ssc/extensions/server'
import { applyRemainingFunding, getAllocationFinancialContext } from '../allocation-financials.ts'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { parseAgreementRouteParams } from '../allocation-request-validation.ts'
import {
  getAgreementBudgetYears,
  getAgreementCurrency,
  getAgreementOutcomes,
  getAllocationVersions,
  getSavedAllocations,
  getStreamCommitmentTypes,
  getStreamCommitmentLines
} from '../allocation-data.ts'

export default defineGcsExtensionRouteHandler(async context => {
  const { params, entity, db: rawDb } = context
  const { agreementId } = parseAgreementRouteParams(params)
  const streamId = String(entity?.streamId ?? '')
  const db = asOutcomeCostAllocationDb(rawDb)

  const currency = await getAgreementCurrency(db, agreementId)
  const [outcomes, budgetYears, versions, allocations, streamCommitments, commitmentTypes, financialContext] = await Promise.all([
    getAgreementOutcomes(db, agreementId),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAllocationVersions(db, agreementId),
    getSavedAllocations(db, agreementId),
    getStreamCommitmentLines(db, streamId),
    getStreamCommitmentTypes(db, streamId),
    getAllocationFinancialContext(requireGcsExtensionAgreementFinancials(context))
  ])

  return {
    currency,
    outcomes,
    budgetYears: applyRemainingFunding(budgetYears, financialContext),
    codingPaidAmounts: financialContext.codingPaidAmounts,
    hasPendingEffects: financialContext.hasPendingEffects,
    versions,
    allocations,
    streamCommitments,
    commitmentTypes
  }
})
