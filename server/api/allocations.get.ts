import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import {
  createDraftAllocationVersion,
  getAgreementBudgetYears,
  getAgreementOutcomes,
  getAllocationVersions,
  getSavedAllocations,
  getStreamCommitmentLines
} from '../allocation-data'

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb }) => {
  const agreementId = params.agreementId ?? ''
  const streamId = String(entity?.streamId ?? '')
  const db = asOutcomeCostAllocationDb(rawDb)

  let versions = await getAllocationVersions(db, agreementId)
  if (versions.length === 0) {
    await createDraftAllocationVersion(db, agreementId)
    versions = await getAllocationVersions(db, agreementId)
  }

  const [outcomes, budgetYears, allocations, streamCommitments] = await Promise.all([
    getAgreementOutcomes(db, agreementId),
    getAgreementBudgetYears(db, agreementId, streamId),
    getSavedAllocations(db, agreementId),
    getStreamCommitmentLines(db, streamId)
  ])

  return {
    outcomes,
    budgetYears,
    versions,
    allocations,
    streamCommitments
  }
})
