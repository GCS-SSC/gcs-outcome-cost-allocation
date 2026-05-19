/* eslint-disable jsdoc/require-jsdoc */
import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import { deleteDraftAllocationVersion } from '../allocation-data'

export default defineGcsExtensionRouteHandler(async ({ params, db: rawDb }) => {
  const agreementId = params.agreementId ?? ''
  const allocationVersionId = params.allocationVersionId ?? ''
  const db = asOutcomeCostAllocationDb(rawDb)

  await deleteDraftAllocationVersion(db, agreementId, allocationVersionId)

  return {
    ok: true
  }
})
