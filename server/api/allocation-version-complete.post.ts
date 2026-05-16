/* eslint-disable jsdoc/require-jsdoc */
import type { H3Event } from 'h3'
import { createGcsExtensionUserError } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import { completeAllocationVersion } from '../allocation-data'
import {
  bilingualAllocationIssues,
  getOutcomeCostAllocationErrorMessages
} from '../errors'
import type { AllocationValidationIssue } from '../../shared/allocation'

type AllocationVersionCompleteEvent = H3Event & {
  context: {
    $db: unknown
    params?: Record<string, string | undefined>
    gcsExtension?: {
      config?: unknown
      entity?: {
        streamId?: string
      }
    }
  }
}

const hasAllocationIssues = (error: unknown): error is Error & { issues: AllocationValidationIssue[] } =>
  error instanceof Error && Array.isArray((error as Error & { issues?: unknown }).issues)

const resolveCompletionContext = (event: AllocationVersionCompleteEvent) => ({
  agreementId: event.context.params?.agreementId ?? '',
  allocationVersionId: event.context.params?.allocationVersionId ?? '',
  streamId: event.context.gcsExtension?.entity?.streamId ?? '',
  config: event.context.gcsExtension?.config ?? {},
  db: asOutcomeCostAllocationDb(event.context.$db)
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

export default async (event: AllocationVersionCompleteEvent) => {
  const {
    agreementId,
    allocationVersionId,
    streamId,
    config,
    db
  } = resolveCompletionContext(event)

  try {
    const version = await completeAllocationVersion(db, agreementId, streamId, allocationVersionId, config)
    return {
      ok: true,
      version
    }
  } catch (error: unknown) {
    throwCompletionError(error)
  }
}
