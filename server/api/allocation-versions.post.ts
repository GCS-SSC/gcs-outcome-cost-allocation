/* eslint-disable jsdoc/require-jsdoc */
import type { H3Event } from 'h3'
import { asOutcomeCostAllocationDb } from '../db'
import { createDraftAllocationVersion } from '../allocation-data'

type AllocationVersionPostEvent = H3Event & {
  context: {
    $db: unknown
    params?: Record<string, string | undefined>
  }
}

export default async (event: AllocationVersionPostEvent) => {
  const agreementId = event.context.params?.agreementId ?? ''
  const db = asOutcomeCostAllocationDb(event.context.$db)
  const version = await createDraftAllocationVersion(db, agreementId)

  return {
    ok: true,
    version
  }
}
