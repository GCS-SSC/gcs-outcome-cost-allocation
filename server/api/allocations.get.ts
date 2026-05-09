/* eslint-disable jsdoc/require-jsdoc */
import { asOutcomeCostAllocationDb } from '../db'
import {
  createDraftAllocationVersion,
  getAgreementBudgetYears,
  getAgreementOutcomes,
  getAllocationVersions,
  getSavedAllocations,
  getStreamCommitmentLines
} from '../allocation-data'

export default async (event: {
  context: {
    $db: unknown
    params?: Record<string, string | undefined>
    gcsExtension?: {
      entity?: {
        streamId?: string
      }
    }
  }
}) => {
  const agreementId = event.context.params?.agreementId ?? ''
  const streamId = event.context.gcsExtension?.entity?.streamId ?? ''
  const db = asOutcomeCostAllocationDb(event.context.$db)

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
}
