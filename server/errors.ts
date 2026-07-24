import {
  createGcsExtensionUserError,
  getGcsExtensionRequestHeader,
  type GcsExtensionRouteEvent,
  type GcsExtensionLocalizedMessage,
  type GcsExtensionUserErrorDetail,
  type GcsExtensionUserErrorOptions
} from '@gcs-ssc/extensions/server'
import type { AllocationValidationIssue } from '../shared/allocation'

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
