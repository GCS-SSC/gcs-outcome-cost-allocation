import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'
export const AgreementOutcomeCostAllocationTabMessages = defineGcsExtensionMessages({
  "en": {
    "title": "Cost allocation",
    "empty": "Add agreement activities with outcomes, budget fiscal years, and stream cost allocation configuration before allocating costs.",
    "outcome": "Outcome",
    "commitmentLine": "Commitment line",
    "method": "Method",
    "value": "Value",
    "amount": "Amount",
    "unallocated": "Unallocated",
    "version": "Version",
    "status": "Status",
    "actions": "Actions",
    "allocationVersions": "Cost allocations",
    "selectedAllocation": "Selected allocation",
    "generateRows": "Generate rows",
    "generateRowsTitle": "Generate allocation rows",
    "commitmentType": "Commitment type",
    "fiscalYears": "Fiscal years",
    "removeRowsTitle": "Remove stale allocation rows?",
    "removeRowsDescription": "Generating will remove rows that no longer match the selected commitment type, fiscal years, and agreement outcomes.",
    "removeAllocation": "Remove allocation",
    "noRows": "No allocation rows have been added to this draft.",
    "newDraft": "New draft",
    "complete": "Submit for approval",
    "view": "View",
    "delete": "Delete",
    "selected": "Selected",
    "readonly": "Only draft allocations can be edited.",
    "records": "allocations",
    "save": "Save",
    "workflows": "Workflows",
    "workflowsDescription": "Start and complete a standard workflow for the selected allocation version.",
    "percentage": "Percentage"
  },
  "fr": {
    "title": "Repartition des couts",
    "empty": "Ajoutez des activites avec des resultats, des exercices budgetaires et la configuration de repartition des couts du volet avant de repartir les couts.",
    "outcome": "Resultat",
    "commitmentLine": "Ligne d engagement",
    "method": "Methode",
    "value": "Valeur",
    "amount": "Montant",
    "unallocated": "Non reparti",
    "version": "Version",
    "status": "Statut",
    "actions": "Actions",
    "allocationVersions": "Repartitions des couts",
    "selectedAllocation": "Repartition selectionnee",
    "generateRows": "Generer les lignes",
    "generateRowsTitle": "Generer des lignes de repartition",
    "commitmentType": "Type d engagement",
    "fiscalYears": "Exercices",
    "removeRowsTitle": "Supprimer les lignes de repartition obsoletes?",
    "removeRowsDescription": "La generation supprimera les lignes qui ne correspondent plus au type d engagement, aux exercices et aux resultats de l entente selectionnes.",
    "removeAllocation": "Retirer la repartition",
    "noRows": "Aucune ligne de repartition n a ete ajoutee a ce brouillon.",
    "newDraft": "Nouveau brouillon",
    "complete": "Soumettre pour approbation",
    "view": "Voir",
    "delete": "Supprimer",
    "selected": "Selectionnee",
    "readonly": "Seules les repartitions en brouillon peuvent etre modifiees.",
    "records": "repartitions",
    "save": "Enregistrer",
    "workflows": "Flux de travail",
    "workflowsDescription": "Demarrez et terminez un flux de travail standard pour la version de repartition selectionnee.",
    "percentage": "Pourcentage"
  }
})

export const AgreementOutcomeCostAllocationTabStatusMessages = defineGcsExtensionMessages({
  "en": {
    "draft": "Draft",
    "active": "Active",
    "inactive": "Inactive"
  },
  "fr": {
    "draft": "Brouillon",
    "active": "Active",
    "inactive": "Inactive"
  }
})

export const AgreementOutcomeCostAllocationTabErrorMessages = defineGcsExtensionMessages({
  "en": {
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING": "The full agreement budget must be allocated.",
    "GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS": "The full agreement budget must be allocated.",
    "GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID": "The full agreement budget must be allocated.",
    "GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID": "The full agreement budget must be allocated.",
    "GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID": "The full agreement budget must be allocated.",
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID": "Each fiscal year must be fully allocated to its own budget value.",
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED": "An allocation cannot exceed its fiscal-year budget value.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME": "One saved allocation references an outcome that is no longer used by agreement activities.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR": "One saved allocation references a budget year that is no longer active."
  },
  "fr": {
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING": "Le budget complet de l entente doit etre reparti.",
    "GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS": "Le budget complet de l entente doit etre reparti.",
    "GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID": "Le budget complet de l entente doit etre reparti.",
    "GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID": "Le budget complet de l entente doit etre reparti.",
    "GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID": "Le budget complet de l entente doit etre reparti.",
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID": "Chaque exercice doit etre entierement reparti selon sa propre valeur budgetaire.",
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED": "Une repartition ne peut pas depasser la valeur budgetaire de son exercice.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME": "Une repartition enregistree reference un resultat qui n est plus utilise par les activites de l entente.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR": "Une repartition enregistree reference un exercice budgetaire qui n est plus actif."
  }
})
