/* eslint-disable jsdoc/require-jsdoc */
import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import { createDraftAllocationVersion } from '../allocation-data'

export default defineGcsExtensionRouteHandler(async ({ params, db: rawDb }) => {
  const agreementId = params.agreementId ?? ''
  const db = asOutcomeCostAllocationDb(rawDb)
  const version = await createDraftAllocationVersion(db, agreementId)

  return {
    ok: true,
    version
  }
})
