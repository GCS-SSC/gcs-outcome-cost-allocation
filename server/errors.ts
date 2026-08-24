import {
  createGcsExtensionUserError,
  getGcsExtensionRequestHeader,
  type GcsExtensionRouteEvent,
  type GcsExtensionLocalizedMessage,
  type GcsExtensionUserErrorDetail,
  type GcsExtensionUserErrorOptions
} from '@gcs-ssc/extensions/server'
import type { AllocationValidationIssue } from '../shared/allocation.ts'

const errorMessages: Record<string, GcsExtensionLocalizedMessage> = {
  GCS_OUTCOME_COST_ALLOCATION_INVALID: {
    en: 'Outcome cost allocations are invalid.',
    fr: 'Les repartitions des couts par resultat sont invalides.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME: {
    en: 'One saved allocation references an outcome that is no longer used by agreement activities.',
    fr: 'Une repartition enregistree reference un resultat qui n est plus utilise par les activites de l entente.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR: {
    en: 'One saved allocation references a budget year that is no longer active.',
    fr: 'Une repartition enregistree reference un exercice budgetaire qui n est plus actif.'
  },
  GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING: {
    en: 'The full agreement budget must be allocated.',
    fr: 'Le budget complet de l entente doit etre reparti.'
  },
  GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS: {
    en: 'The full agreement budget must be allocated.',
    fr: 'Le budget complet de l entente doit etre reparti.'
  },
  GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID: {
    en: 'The full agreement budget must be allocated.',
    fr: 'Le budget complet de l entente doit etre reparti.'
  },
  GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID: {
    en: 'The full agreement budget must be allocated.',
    fr: 'Le budget complet de l entente doit etre reparti.'
  },
  GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID: {
    en: 'The full agreement budget must be allocated.',
    fr: 'Le budget complet de l entente doit etre reparti.'
  },
  GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID: {
    en: 'Each fiscal year must be fully allocated to its own budget value.',
    fr: 'Chaque exercice doit etre entierement reparti selon sa propre valeur budgetaire.'
  },
  GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED: {
    en: 'An allocation cannot exceed its fiscal-year budget value.',
    fr: 'Une repartition ne peut pas depasser la valeur budgetaire de son exercice.'
  },
  GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED: {
    en: 'Complete and activate a cost allocation before creating this commitment.',
    fr: 'Terminez et activez une repartition des couts avant de creer cet engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STREAM_BUDGET_MISSING: {
    en: 'A budget year is missing its stream budget mapping.',
    fr: 'Un exercice budgetaire n a pas de correspondance avec un budget de volet.'
  },
  GCS_OUTCOME_COST_ALLOCATION_MAPPING_MISSING: {
    en: 'Configure an outcome-to-commitment-line mapping for this commitment type before creating the commitment.',
    fr: 'Configurez une correspondance entre resultat et ligne d engagement pour ce type d engagement avant de creer l engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE: {
    en: 'One configured stream commitment line is no longer active.',
    fr: 'Une ligne d engagement de volet configuree n est plus active.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH: {
    en: 'One configured stream commitment line belongs to a different fiscal-year budget.',
    fr: 'Une ligne d engagement de volet configuree appartient au budget d un autre exercice.'
  },
  GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_TYPE_DISABLED: {
    en: 'One saved allocation uses a commitment type that is no longer enabled.',
    fr: 'Une repartition enregistree utilise un type d engagement qui n est plus autorise.'
  },
  GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING: {
    en: 'The active cost allocation has no positive allocations for this commitment type.',
    fr: 'La repartition des couts active ne contient aucune repartition positive pour ce type d engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE: {
    en: 'This cost allocation would create a commitment line below the amount already paid.',
    fr: 'Cette repartition des couts creerait une ligne d engagement inferieure au montant deja paye.'
  },
  GCS_OUTCOME_COST_ALLOCATION_PAYMENT_LINES_MISSING: {
    en: 'The active cost allocation does not define payment lines for this payment.',
    fr: 'La repartition des couts active ne definit pas de lignes de paiement pour ce paiement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_PAYMENT_COMMITMENT_LINE_MISSING: {
    en: 'The selected commitment is missing a commitment line required by the active cost allocation.',
    fr: 'L engagement selectionne n a pas une ligne d engagement requise par la repartition des couts active.'
  },
  GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING: {
    en: 'This payment exceeds the remaining balance of the cost allocation commitment lines.',
    fr: 'Ce paiement depasse le solde restant des lignes d engagement de la repartition des couts.'
  },
  GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE: {
    en: 'This payment is managed by outcome cost allocation and its amount, allocation coordinates, and payment lines cannot be changed.',
    fr: 'Ce paiement est gere par la repartition des couts par resultat; son montant, ses coordonnees de repartition et ses lignes de paiement ne peuvent pas etre modifies.'
  },
  GCS_OUTCOME_COST_ALLOCATION_DRAFT_DELETE_REQUIRED: {
    en: 'Only draft cost allocations can be deleted.',
    fr: 'Seules les repartitions des couts en ebauche peuvent etre supprimees.'
  },
  GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED: {
    en: 'Only draft cost allocations can be edited.',
    fr: 'Seules les repartitions des couts en ebauche peuvent etre modifiees.'
  },
  GCS_OUTCOME_COST_ALLOCATION_DRAFT_COMPLETE_REQUIRED: {
    en: 'Only draft cost allocations can be completed.',
    fr: 'Seules les repartitions des couts en ebauche peuvent etre terminees.'
  },
  GCS_OUTCOME_COST_ALLOCATION_DRAFT_EXISTS: {
    en: 'A draft cost allocation already exists for this agreement. Refresh and edit that draft.',
    fr: 'Une repartition des couts en ebauche existe deja pour cette entente. Actualisez la page et modifiez cette ebauche.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE: {
    en: 'One allocation reference is no longer available for this agreement. Refresh the allocation and try again.',
    fr: 'Une reference de repartition n est plus disponible pour cette entente. Actualisez la repartition et reessayez.'
  },
  GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT: {
    en: 'The cost allocation changed while this request was being processed. Refresh and try again.',
    fr: 'La repartition des couts a change pendant le traitement de cette demande. Actualisez la page et reessayez.'
  }
}

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

/**
 * Returns the bilingual message for a code, falling back to the generic allocation error.
 */
export const getOutcomeCostAllocationErrorMessages = (
  code: string | undefined
) => errorMessages[code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID']
  ?? errorMessages.GCS_OUTCOME_COST_ALLOCATION_INVALID

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
