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
    en: 'Each budget year needs at least one allocation.',
    fr: 'Chaque exercice budgetaire doit avoir au moins une repartition.'
  },
  GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS: {
    en: 'Use either amounts or percentages within a budget year, not both.',
    fr: 'Utilisez soit des montants, soit des pourcentages dans un exercice budgetaire, pas les deux.'
  },
  GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID: {
    en: 'Percentage allocations must total 100 for each budget year.',
    fr: 'Les pourcentages doivent totaliser 100 pour chaque exercice budgetaire.'
  },
  GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID: {
    en: 'Amount allocations must equal the program funding for each budget year.',
    fr: 'Les montants doivent egaler le financement de programme pour chaque exercice budgetaire.'
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
