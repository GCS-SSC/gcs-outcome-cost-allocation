/* eslint-disable jsdoc/require-jsdoc */
import type { H3Event } from 'h3'
import { createGcsExtensionUserError } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import { completeAllocationVersion } from '../allocation-data'
import {
  getOutcomeCostAllocationErrorMessage,
  localizeAllocationIssues
} from '../errors'
import type { AllocationValidationIssue } from '../../shared/allocation'

type AllocationVersionCompleteEvent = H3Event & {
  context: {
    $db: unknown
    params?: Record<string, string | undefined>
    gcsExtension?: {
      entity?: {
        streamId?: string
      }
    }
  }
}

const hasAllocationIssues = (error: unknown): error is Error & { issues: AllocationValidationIssue[] } =>
  error instanceof Error && Array.isArray((error as Error & { issues?: unknown }).issues)

export default async (event: AllocationVersionCompleteEvent) => {
  const agreementId = event.context.params?.agreementId ?? ''
  const allocationVersionId = event.context.params?.allocationVersionId ?? ''
  const streamId = event.context.gcsExtension?.entity?.streamId ?? ''
  const db = asOutcomeCostAllocationDb(event.context.$db)

  try {
    const version = await completeAllocationVersion(db, agreementId, streamId, allocationVersionId)
    return {
      ok: true,
      version
    }
  } catch (error: unknown) {
    if (!hasAllocationIssues(error)) {
      throw error
    }

    const code = error.issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
    throw createGcsExtensionUserError({
      code,
      message: getOutcomeCostAllocationErrorMessage(event, code),
      details: localizeAllocationIssues(event, error.issues)
    })
  }
}
