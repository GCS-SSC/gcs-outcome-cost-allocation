import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import {
  getAgreementBudgetYears,
  getAgreementOutcomes,
  getAllocationVersions,
  getSavedAllocations,
  getStreamCommitmentTypes,
  getStreamCommitmentLines
} from '../allocation-data.ts'

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb }) => {
  const agreementId = params.agreementId ?? ''
  const streamId = String(entity?.streamId ?? '')
  const db = asOutcomeCostAllocationDb(rawDb)

  const [outcomes, budgetYears, versions, allocations, streamCommitments, commitmentTypes] = await Promise.all([
    getAgreementOutcomes(db, agreementId),
    getAgreementBudgetYears(db, agreementId, streamId),
    getAllocationVersions(db, agreementId),
    getSavedAllocations(db, agreementId),
    getStreamCommitmentLines(db, streamId),
    getStreamCommitmentTypes(db, streamId)
  ])

  return {
    outcomes,
    budgetYears,
    versions,
    allocations,
    streamCommitments,
    commitmentTypes
  }
})
