import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { deleteDraftAllocationVersion } from '../allocation-data.ts'

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb, authorizeFresh }) => {
  const agreementId = params.agreementId ?? ''
  const allocationVersionId = params.allocationVersionId ?? ''
  const db = asOutcomeCostAllocationDb(rawDb)

  if (!authorizeFresh) {
    throw new Error('Fresh extension authorization is required for allocation writes.')
  }
  await deleteDraftAllocationVersion(db, agreementId, allocationVersionId, {
    agencyId: String(entity?.agencyId ?? ''),
    streamId: String(entity?.streamId ?? '')
  }, async trx => await authorizeFresh(trx))

  return {
    ok: true
  }
})
