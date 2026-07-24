import { createGcsExtensionUserError, defineGcsExtensionRouteHandler, type GcsExtensionRouteContext } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import { completeAllocationVersion } from '../allocation-data'
import {
  bilingualAllocationIssues,
  getOutcomeCostAllocationErrorMessages
} from '../errors'
import type { AllocationValidationIssue } from '../../shared/allocation'

const hasAllocationIssues = (error: unknown): error is Error & { issues: AllocationValidationIssue[] } =>
  error instanceof Error && Array.isArray((error as Error & { issues?: unknown }).issues)

const resolveCompletionContext = (context: GcsExtensionRouteContext) => ({
  agreementId: context.params.agreementId ?? '',
  allocationVersionId: context.params.allocationVersionId ?? '',
  streamId: String(context.entity?.streamId ?? ''),
  config: context.config ?? {},
  db: asOutcomeCostAllocationDb(context.db)
})

const throwCompletionError = (error: unknown): never => {
  if (!hasAllocationIssues(error)) {
    throw error
  }

  const code = error.issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
  throw createGcsExtensionUserError({
    code,
    message: getOutcomeCostAllocationErrorMessages(code),
    details: bilingualAllocationIssues(error.issues)
  })
}

export default defineGcsExtensionRouteHandler(async context => {
  const {
    agreementId,
    allocationVersionId,
    streamId,
    config,
    db
  } = resolveCompletionContext(context)

  try {
    const version = await completeAllocationVersion(db, agreementId, streamId, allocationVersionId, config)
    return {
      ok: true,
      version
    }
  } catch (error: unknown) {
    throwCompletionError(error)
  }
})
