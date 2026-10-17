import { translateGcsExtensionMessage } from '@gcs-ssc/extensions'
import { allocationErrorMessages } from '../i18n/errors.ts'
import {
  createGcsExtensionUserError,
  getGcsExtensionRequestHeader,
  type GcsExtensionRouteEvent,
  type GcsExtensionLocalizedMessage,
  type GcsExtensionUserErrorDetail,
  type GcsExtensionUserErrorOptions
} from '@gcs-ssc/extensions/server'
import type { AllocationValidationIssue } from '../shared/allocation.ts'


type OutcomeCostAllocationDatabaseError = {
  code?: unknown
  constraint?: unknown
}

const databaseConstraintErrors: Record<string, { code: string, path?: string }> = {
  gcs_outcome_cost_allocation_agreement_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
    path: 'agreementId'
  },
  gcs_outcome_cost_allocation_commitment_type: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
    path: 'allocations'
  },
  gcs_outcome_cost_allocation_method: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
    path: 'allocations'
  },
  gcs_outcome_cost_allocation_version_status: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_allocation_coordinate_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE',
    path: 'allocations'
  },
  gcs_outcome_cost_allocation_commitment_line_provenance_coordinate_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE',
    path: 'allocations'
  },
  gcs_outcome_cost_allocation_generated_payment_line_coordinate_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE',
    path: 'allocations'
  },
  gcs_outcome_cost_allocation_one_draft_version: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EXISTS',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_one_active_version: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_unique_version: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_version_allocation: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocations'
  },
  gcs_outcome_cost_allocation_allocation_draft_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_allocation_identity_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_allocation_soft_delete_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_managed_mutation_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_snapshot_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocations'
  },
  gcs_outcome_cost_allocation_version_children_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_version_identity_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_version_transition_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
    path: 'allocationVersionId'
  },
  gcs_outcome_cost_allocation_generated_payment_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
    path: 'paymentId'
  },
  gcs_outcome_cost_allocation_generated_payment_line_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
    path: 'paymentLineId'
  },
  gcs_outcome_cost_allocation_generated_payment_total_guard: {
    code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
    path: 'paymentId'
  }
}

const defaultLocalizedMessage = (message: GcsExtensionLocalizedMessage): string =>
  typeof message === 'string' ? message : message.en

const createLocalizedUserError = (options: GcsExtensionUserErrorOptions) => {
  const error = createGcsExtensionUserError({
    ...options,
    message: defaultLocalizedMessage(options.message),
    details: options.details as GcsExtensionUserErrorDetail[] | undefined
  })

  return Object.assign(error, {
    localizedMessage: options.message,
    details: options.details
  })
}

const getLocale = (event: GcsExtensionRouteEvent) => {
  const language = getGcsExtensionRequestHeader(event, 'accept-language') ?? ''
  return language.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

/**
 * Returns one error message localized from the request's accepted language.
 */
export const getOutcomeCostAllocationErrorMessage = (
  event: GcsExtensionRouteEvent,
  code: string | undefined
) => {
  const message = getOutcomeCostAllocationErrorMessages(code)
  return typeof message === 'string' ? message : message[getLocale(event)]
}

const isAllocationErrorCode = (code: string): code is keyof typeof allocationErrorMessages.en =>
  Object.hasOwn(allocationErrorMessages.en, code)

/**
 * Returns the bilingual message for a code, falling back to the generic allocation error.
 */
export const getOutcomeCostAllocationErrorMessages = (
  code: string | undefined
) => {
  const key = code && isAllocationErrorCode(code)
    ? code : 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
  return {
    en: translateGcsExtensionMessage(allocationErrorMessages, 'en', key),
    fr: translateGcsExtensionMessage(allocationErrorMessages, 'fr', key)
  }
}

/**
 * Creates a bilingual extension user error with optional field-level detail.
 */
export const createOutcomeCostAllocationUserError = (
  code: string,
  path?: string
) => createLocalizedUserError({
  code,
  message: getOutcomeCostAllocationErrorMessages(code),
  details: path
    ? [{
        path,
        code,
        message: getOutcomeCostAllocationErrorMessages(code)
      }]
    : undefined
})

/**
 * Converts only known allocation persistence failures to stable bilingual user errors.
 */
export const throwOutcomeCostAllocationDatabaseError = (error: unknown): never => {
  if (typeof error !== 'object' || error === null) {
    throw error
  }

  const databaseError = error as OutcomeCostAllocationDatabaseError
  const sqlState = typeof databaseError.code === 'string' ? databaseError.code : ''
  const constraint = typeof databaseError.constraint === 'string' ? databaseError.constraint : ''
  const mapped = databaseConstraintErrors[constraint]

  if (mapped) {
    throw createOutcomeCostAllocationUserError(mapped.code, mapped.path)
  }

  const isExtensionForeignKey = sqlState === '23503'
    && constraint.startsWith('gcs_outcome_cost_allocation_')
  const isExtensionUnique = sqlState === '23505'
    && constraint.startsWith('gcs_outcome_cost_allocation_')

  if (isExtensionForeignKey || isExtensionUnique) {
    throw createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE',
      'allocations'
    )
  }

  throw error
}

/**
 * Converts validation issues to request-locale error details.
 */
export const localizeAllocationIssues = (
  event: GcsExtensionRouteEvent,
  issues: AllocationValidationIssue[]
) => issues.map(issue => ({
  path: issue.path,
  message: getOutcomeCostAllocationErrorMessage(event, issue.code),
  code: issue.code
}))

/**
 * Converts validation issues to bilingual error details for operation hooks.
 */
export const bilingualAllocationIssues = (
  issues: AllocationValidationIssue[]
) => issues.map(issue => ({
  path: issue.path,
  message: getOutcomeCostAllocationErrorMessages(issue.code),
  code: issue.code
}))

/** Converts domain validation issues from host lifecycle adapters to a stable user error. */
export const createAllocationValidationUserError = (
  issues: AllocationValidationIssue[]
) => {
  const code = issues[0]?.code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
  return createLocalizedUserError({
    code,
    message: getOutcomeCostAllocationErrorMessages(code),
    details: bilingualAllocationIssues(issues)
  })
}
