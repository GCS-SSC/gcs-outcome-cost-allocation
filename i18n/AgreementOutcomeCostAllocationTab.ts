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
    "supplementaryInformation": "Supplementary",
    "workflowsDescription": "Start and complete a standard workflow for the selected allocation version.",
    "percentage": "Percentage"
  },
  "fr": {
    "title": "Répartition des coûts",
    "empty": "Ajoutez des activités avec des résultats, des exercices budgétaires et la configuration de répartition des coûts du volet avant de répartir les coûts.",
    "outcome": "Résultat",
    "commitmentLine": "Ligne d’engagement",
    "method": "Méthode",
    "value": "Valeur",
    "amount": "Montant",
    "unallocated": "Non réparti",
    "version": "Version",
    "status": "Statut",
    "actions": "Actions",
    "allocationVersions": "Répartitions des coûts",
    "selectedAllocation": "Répartition sélectionnée",
    "generateRows": "Générer les lignes",
    "generateRowsTitle": "Générer des lignes de répartition",
    "commitmentType": "Type d’engagement",
    "fiscalYears": "Exercices",
    "removeRowsTitle": "Supprimer les lignes de répartition obsolètes?",
    "removeRowsDescription": "La génération supprimera les lignes qui ne correspondent plus au type d’engagement, aux exercices et aux résultats de l’entente sélectionnés.",
    "removeAllocation": "Retirer la répartition",
    "noRows": "Aucune ligne de répartition n’a été ajoutée à cette ébauche.",
    "newDraft": "Nouvelle ébauche",
    "complete": "Soumettre pour approbation",
    "view": "Voir",
    "delete": "Supprimer",
    "selected": "Sélectionnée",
    "readonly": "Seules les répartitions en ébauche peuvent être modifiées.",
    "records": "répartitions",
    "save": "Enregistrer",
    "workflows": "Processus",
    "supplementaryInformation": "Supplémentaire",
    "workflowsDescription": "Démarrez et terminez un processus standard pour la version de répartition sélectionnée.",
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
    "draft": "Ébauche",
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
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING": "Le budget complet de l’entente doit être réparti.",
    "GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS": "Le budget complet de l’entente doit être réparti.",
    "GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID": "Le budget complet de l’entente doit être réparti.",
    "GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID": "Le budget complet de l’entente doit être réparti.",
    "GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID": "Le budget complet de l’entente doit être réparti.",
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID": "Chaque exercice doit être entièrement réparti selon sa propre valeur budgétaire.",
    "GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED": "Une répartition ne peut pas dépasser la valeur budgétaire de son exercice.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME": "Une répartition enregistrée référence un résultat qui n’est plus utilisé par les activités de l’entente.",
    "GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR": "Une répartition enregistrée référence un exercice budgétaire qui n’est plus actif."
  }
})
