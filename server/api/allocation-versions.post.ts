import { defineGcsExtensionRouteHandler, requireGcsExtensionAgreementFinancials } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { createDraftAllocationVersion } from '../allocation-data.ts'
import { parseAgreementRouteParams } from '../allocation-request-validation.ts'

export default defineGcsExtensionRouteHandler(async context => {
  const { params, entity, db: rawDb, writeAuthorization } = context
  const { agreementId } = parseAgreementRouteParams(params)
  const db = asOutcomeCostAllocationDb(rawDb)
  if (!writeAuthorization) {
    throw new Error('Fresh extension authorization is required for allocation writes.')
  }
  const version = await createDraftAllocationVersion(db, agreementId, {
    agencyId: String(entity?.agencyId ?? ''),
    streamId: String(entity?.streamId ?? ''),
      financials: requireGcsExtensionAgreementFinancials(context)
  }, writeAuthorization)

  return {
    ok: true,
    version
  }
})
