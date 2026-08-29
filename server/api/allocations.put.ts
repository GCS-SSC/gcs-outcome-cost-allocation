import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { saveAllocations } from '../allocation-data.ts'
import {
  parseAgreementRouteParams,
  parseSaveAllocationsRequest
} from '../allocation-request-validation.ts'
import {
  throwOutcomeCostAllocationDatabaseError
} from '../errors.ts'

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb, readBody, writeAuthorization }) => {
  const { agreementId } = parseAgreementRouteParams(params)
  const body = parseSaveAllocationsRequest(await readBody())
  const db = asOutcomeCostAllocationDb(rawDb)
  if (!writeAuthorization) {
    throw new Error('Fresh extension authorization is required for allocation writes.')
  }

  try {
    await saveAllocations(db, agreementId, body.allocationVersionId, body.allocations, {
      agencyId: String(entity?.agencyId ?? ''),
      streamId: String(entity?.streamId ?? '')
    }, writeAuthorization, true)
  } catch (error: unknown) {
    throwOutcomeCostAllocationDatabaseError(error)
  }

  return {
    ok: true
  }
})
