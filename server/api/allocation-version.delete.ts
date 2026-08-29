import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { deleteDraftAllocationVersion } from '../allocation-data.ts'
import { parseAllocationVersionRouteParams } from '../allocation-request-validation.ts'

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb, writeAuthorization }) => {
  const { agreementId, allocationVersionId } = parseAllocationVersionRouteParams(params)
  const db = asOutcomeCostAllocationDb(rawDb)

  if (!writeAuthorization) {
    throw new Error('Fresh extension authorization is required for allocation writes.')
  }
  await deleteDraftAllocationVersion(db, agreementId, allocationVersionId, {
    agencyId: String(entity?.agencyId ?? ''),
    streamId: String(entity?.streamId ?? '')
  }, writeAuthorization)

  return {
    ok: true
  }
})
