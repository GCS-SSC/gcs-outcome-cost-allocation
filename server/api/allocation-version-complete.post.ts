import { createGcsExtensionUserError, defineGcsExtensionRouteHandler, type GcsExtensionRouteContext } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db.ts'
import { saveAndCompleteAllocationVersionWithCurrentConfiguration } from '../allocation-data.ts'
import { CompleteAllocationsRequestSchema } from '../allocation-request-schema.ts'
import {
  bilingualAllocationIssues,
  createOutcomeCostAllocationUserError,
  getOutcomeCostAllocationErrorMessages,
  throwOutcomeCostAllocationDatabaseError
} from '../errors.ts'
import type { AllocationValidationIssue } from '../../shared/allocation.ts'

const parseCompleteAllocationBody = (value: unknown) => {
  const result = CompleteAllocationsRequestSchema.safeParse(value)
  if (result.success) {
    return result.data
  }

  const path = result.error.issues[0]?.path.map(segment => String(segment)).join('.')
  throw createOutcomeCostAllocationUserError(
    'GCS_OUTCOME_COST_ALLOCATION_INVALID',
    path
  )
}

const hasAllocationIssues = (error: unknown): error is Error & { issues: AllocationValidationIssue[] } =>
  error instanceof Error && Array.isArray((error as Error & { issues?: unknown }).issues)

const resolveCompletionContext = (context: GcsExtensionRouteContext) => ({
  agreementId: context.params.agreementId ?? '',
  allocationVersionId: context.params.allocationVersionId ?? '',
  streamId: String(context.entity?.streamId ?? ''),
  agencyId: String(context.entity?.agencyId ?? ''),
  db: asOutcomeCostAllocationDb(context.db)
})

const throwCompletionError = (error: unknown): never => {
  if (hasAllocationIssues(error)) {
    const code = error.issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
    throw createGcsExtensionUserError({
      code,
      message: getOutcomeCostAllocationErrorMessages(code),
      details: bilingualAllocationIssues(error.issues)
    })
  }

  return throwOutcomeCostAllocationDatabaseError(error)
}

export default defineGcsExtensionRouteHandler(async context => {
  const {
    agreementId,
    allocationVersionId,
    streamId,
    agencyId,
    db
  } = resolveCompletionContext(context)
  const body = parseCompleteAllocationBody(await context.readBody())
  const authorizeFresh = context.authorizeFresh
  if (!authorizeFresh) {
    throw new Error('Fresh extension authorization is required for allocation writes.')
  }

  try {
    const version = await saveAndCompleteAllocationVersionWithCurrentConfiguration(
      db,
      agreementId,
      agencyId,
      streamId,
      allocationVersionId,
      body.allocations,
      async trx => await authorizeFresh(trx)
    )
    return {
      ok: true,
      version
    }
  } catch (error: unknown) {
    throwCompletionError(error)
  }
})
