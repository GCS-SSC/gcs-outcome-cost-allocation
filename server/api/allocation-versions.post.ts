import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { createDraftAllocationVersion } from '../allocation-data.ts'

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb, writeAuthorization }) => {
  const agreementId = params.agreementId ?? ''
  const db = asOutcomeCostAllocationDb(rawDb)
  if (!writeAuthorization) {
    throw new Error('Fresh extension authorization is required for allocation writes.')
  }
  const version = await createDraftAllocationVersion(db, agreementId, {
    agencyId: String(entity?.agencyId ?? ''),
    streamId: String(entity?.streamId ?? '')
  }, writeAuthorization)

  return {
    ok: true,
    version
  }
})
