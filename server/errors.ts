/* eslint-disable jsdoc/require-jsdoc */
import type { H3Event } from 'h3'
import { getHeader } from 'h3'
import type { AllocationValidationIssue } from '../shared/allocation'

const errorMessages: Record<string, { en: string, fr: string }> = {
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
  }
}

const getLocale = (event: H3Event) => {
  const language = getHeader(event, 'accept-language') ?? ''
  return language.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

export const getOutcomeCostAllocationErrorMessage = (
  event: H3Event,
  code: string | undefined
) => {
  const message = errorMessages[code ?? 'GCS_OUTCOME_COST_ALLOCATION_INVALID']
    ?? errorMessages.GCS_OUTCOME_COST_ALLOCATION_INVALID
  return message[getLocale(event)]
}

export const localizeAllocationIssues = (
  event: H3Event,
  issues: AllocationValidationIssue[]
) => issues.map(issue => ({
  path: issue.path,
  message: getOutcomeCostAllocationErrorMessage(event, issue.code),
  code: issue.code
}))
