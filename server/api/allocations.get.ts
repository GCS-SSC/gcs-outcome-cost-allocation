import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
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

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb }) => {
  const { agreementId } = parseAgreementRouteParams(params)
  const streamId = String(entity?.streamId ?? '')
  const db = asOutcomeCostAllocationDb(rawDb)

  const currency = await getAgreementCurrency(db, agreementId)
  const [outcomes, budgetYears, versions, allocations, streamCommitments, commitmentTypes] = await Promise.all([
    getAgreementOutcomes(db, agreementId),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAllocationVersions(db, agreementId),
    getSavedAllocations(db, agreementId),
    getStreamCommitmentLines(db, streamId),
    getStreamCommitmentTypes(db, streamId)
  ])

  return {
    currency,
    outcomes,
    budgetYears,
    versions,
    allocations,
    streamCommitments,
    commitmentTypes
  }
})
