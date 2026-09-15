import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'
export const CreateOutcomeCommitmentActionMessages = defineGcsExtensionMessages({
  "en": {
    "success": "Success",
    "commitment_added": "Commitment added.",
    "complete_the_form_fields_then_save_or_cancel": "Complete the form fields, then save or cancel your changes.",
    "type": "Type",
    "cancel": "Cancel",
    "add": "Add"
  },
  "fr": {
    "success": "Succes",
    "commitment_added": "Engagement ajoute.",
    "complete_the_form_fields_then_save_or_cancel": "Remplissez les champs du formulaire, puis enregistrez ou annulez vos modifications.",
    "type": "Type",
    "cancel": "Annuler",
    "add": "Ajouter"
  }
})

export const CreateOutcomeCommitmentActionErrorMessages = defineGcsExtensionMessages({
  "en": {
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING": "The full agreement budget must be allocated before this commitment can be created.",
    "GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS": "The full agreement budget must be allocated before this commitment can be created.",
    "GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID": "The full agreement budget must be allocated before this commitment can be created.",
    "GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID": "The full agreement budget must be allocated before this commitment can be created.",
    "GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID": "The full agreement budget must be allocated before this commitment can be created.",
    "GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED": "Complete and activate a cost allocation before creating this commitment.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME": "One saved allocation references an outcome that is no longer used by agreement activities.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR": "One saved allocation references a budget year that is no longer active.",
    "GCS_OUTCOME_COST_ALLOCATION_STREAM_BUDGET_MISSING": "A budget year is missing its stream budget mapping.",
    "GCS_OUTCOME_COST_ALLOCATION_MAPPING_MISSING": "Configure an outcome-to-commitment-line mapping for this commitment type before creating the commitment.",
    "GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE": "One configured stream commitment line is no longer active.",
    "GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH": "One configured stream commitment line belongs to a different fiscal-year budget.",
    "GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING": "The active cost allocation has no positive allocations for this commitment type."
  },
  "fr": {
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING": "Le budget complet de l entente doit etre reparti avant de creer cet engagement.",
    "GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS": "Le budget complet de l entente doit etre reparti avant de creer cet engagement.",
    "GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID": "Le budget complet de l entente doit etre reparti avant de creer cet engagement.",
    "GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID": "Le budget complet de l entente doit etre reparti avant de creer cet engagement.",
    "GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID": "Le budget complet de l entente doit etre reparti avant de creer cet engagement.",
    "GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED": "Terminez et activez une repartition des couts avant de creer cet engagement.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME": "Une repartition enregistree reference un resultat qui n est plus utilise par les activites de l entente.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR": "Une repartition enregistree reference un exercice budgetaire qui n est plus actif.",
    "GCS_OUTCOME_COST_ALLOCATION_STREAM_BUDGET_MISSING": "Un exercice budgetaire n a pas de correspondance avec un budget de volet.",
    "GCS_OUTCOME_COST_ALLOCATION_MAPPING_MISSING": "Configurez une correspondance entre resultat et ligne d engagement pour ce type d engagement avant de creer l engagement.",
    "GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE": "Une ligne d engagement de volet configuree n est plus active.",
    "GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH": "Une ligne d engagement de volet configuree appartient au budget d un autre exercice.",
    "GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING": "La repartition des couts active ne contient aucune repartition positive pour ce type d engagement."
  }
})
