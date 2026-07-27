import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { saveAllocations } from '../allocation-data.ts'
import { SaveAllocationsRequestSchema } from '../allocation-request-schema.ts'
import {
  createOutcomeCostAllocationUserError,
  throwOutcomeCostAllocationDatabaseError
} from '../errors.ts'

const parseSaveAllocationsBody = (value: unknown) => {
  const result = SaveAllocationsRequestSchema.safeParse(value)
  if (result.success) {
    return result.data
  }

  const path = result.error.issues[0]?.path.map(segment => String(segment)).join('.')
  throw createOutcomeCostAllocationUserError(
    'GCS_OUTCOME_COST_ALLOCATION_INVALID',
    path
  )
}

export default defineGcsExtensionRouteHandler(async ({ params, entity, db: rawDb, readBody, writeAuthorization }) => {
  const body = parseSaveAllocationsBody(await readBody())
  const agreementId = params.agreementId ?? ''
  const db = asOutcomeCostAllocationDb(rawDb)
  if (!writeAuthorization) {
    throw new Error('Fresh extension authorization is required for allocation writes.')
  }

  try {
    await saveAllocations(db, agreementId, body.allocationVersionId, body.allocations, {
      agencyId: String(entity?.agencyId ?? ''),
      streamId: String(entity?.streamId ?? '')
    }, writeAuthorization)
  } catch (error: unknown) {
    throwOutcomeCostAllocationDatabaseError(error)
  }

  return {
    ok: true
  }
})
