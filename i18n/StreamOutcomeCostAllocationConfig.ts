import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'

export const StreamOutcomeCostAllocationConfigMessages = defineGcsExtensionMessages({
  "en": {
    "title": "Outcome cost allocation associations",
    "workflows": "Workflows",
    "workflowsDescription": "Link published Agency workflows for outcome cost allocation versions to this Stream. Workflow links are saved immediately when added or removed.",
    "noContext": "Transfer payment context is unavailable.",
    "noRows": "Add program outcomes, stream budgets, and stream commitments before configuring associations.",
    "fiscalYear": "Fiscal year",
    "commitmentLine": "Commitment line",
    "associations": "Associations",
    "actions": "Actions",
    "addAssociation": "Add association",
    "addAssociationDescription": "Select a commitment line, commitment type, and outcome, then add or cancel the association.",
    "removeAssociation": "Remove association",
    "commitmentType": "Commitment type",
    "outcome": "Outcome",
    "cancel": "Cancel",
    "add": "Add",
    "records": "associations"
  },
  "fr": {
    "title": "Associations de répartition des coûts par résultat",
    "workflows": "Flux de travail",
    "workflowsDescription": "Associez à ce volet les flux de travail publiés de l’organisme pour les versions de répartition des coûts par résultat. Les associations de flux de travail sont enregistrées immédiatement lors de leur ajout ou de leur retrait.",
    "noContext": "Le contexte du paiement de transfert est indisponible.",
    "noRows": "Ajoutez des résultats de programme, des budgets de volet et des engagements de volet avant de configurer les associations.",
    "fiscalYear": "Exercice",
    "commitmentLine": "Ligne d’engagement",
    "associations": "Associations",
    "actions": "Actions",
    "addAssociation": "Ajouter une association",
    "addAssociationDescription": "Sélectionnez une ligne d’engagement, un type d’engagement et un résultat, puis ajoutez ou annulez l’association.",
    "removeAssociation": "Retirer l’association",
    "commitmentType": "Type d’engagement",
    "outcome": "Résultat",
    "cancel": "Annuler",
    "add": "Ajouter",
    "records": "associations"
  }
})
