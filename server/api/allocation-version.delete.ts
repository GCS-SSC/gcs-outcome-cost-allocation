/* eslint-disable jsdoc/require-jsdoc */
import type { H3Event } from 'h3'
import { asOutcomeCostAllocationDb } from '../db'
import { deleteDraftAllocationVersion } from '../allocation-data'

type AllocationVersionDeleteEvent = H3Event & {
  context: {
    $db: unknown
    params?: Record<string, string | undefined>
  }
}

export default async (event: AllocationVersionDeleteEvent) => {
  const agreementId = event.context.params?.agreementId ?? ''
  const allocationVersionId = event.context.params?.allocationVersionId ?? ''
  const db = asOutcomeCostAllocationDb(event.context.$db)

  await deleteDraftAllocationVersion(db, agreementId, allocationVersionId)

  return {
    ok: true
  }
}
