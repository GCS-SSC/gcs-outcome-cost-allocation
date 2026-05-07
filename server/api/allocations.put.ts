/* eslint-disable jsdoc/require-jsdoc */
import { z } from 'zod'
import { createGcsExtensionUserError } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import {
  saveAllocations,
  validateAgreementAllocations
} from '../allocation-data'

const AllocationSchema = z.object({
  agreementBudgetFiscalYearId: z.string().min(1),
  outcomeId: z.string().min(1),
  allocationMethod: z.enum(['amount', 'percentage']),
  allocationValue: z.coerce.number().nonnegative()
})

const SaveAllocationsSchema = z.object({
  allocations: z.array(AllocationSchema)
})

export default async (event: {
  context: {
    $db: unknown
    params?: Record<string, string | undefined>
    gcsExtension?: {
      entity?: {
        streamId?: string
      }
    }
  }
}) => {
  const readBody = (globalThis as typeof globalThis & {
    readBody?: (targetEvent: unknown) => Promise<unknown>
  }).readBody
  if (!readBody) {
    throw new Error('readBody is unavailable in the extension route runtime.')
  }

  const body = SaveAllocationsSchema.parse(await readBody(event))
  const agreementId = event.context.params?.agreementId ?? ''
  const streamId = event.context.gcsExtension?.entity?.streamId ?? ''
  const db = asOutcomeCostAllocationDb(event.context.$db)
  const issues = await validateAgreementAllocations(db, agreementId, streamId, body.allocations)

  if (issues.length > 0) {
    throw createGcsExtensionUserError({
      code: issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      message: issues[0]?.message ?? 'apiErrors.extensions.outcome_cost_allocation.invalid',
      details: issues.map(issue => ({
        path: issue.path,
        message: issue.message,
        code: issue.code
      }))
    })
  }

  await saveAllocations(db, agreementId, body.allocations)

  return {
    ok: true
  }
}
