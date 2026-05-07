/* eslint-disable jsdoc/require-jsdoc */
import { asOutcomeCostAllocationDb } from '../db'
import {
  getAgreementBudgetYears,
  getAgreementOutcomes,
  getSavedAllocations
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

  const [outcomes, budgetYears, allocations] = await Promise.all([
    getAgreementOutcomes(db, agreementId),
    getAgreementBudgetYears(db, agreementId, streamId),
    getSavedAllocations(db, agreementId)
  ])

  return {
    outcomes,
    budgetYears,
    allocations
  }
}
