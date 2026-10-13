import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'

export const AgencyCodingConfigMessages = defineGcsExtensionMessages({
  en: {
    description: 'Configure yearly accounts receivable coding. Percentages in each set must total 100%.',
    creditMemoDescription: 'Credit memos use the latest active committed allocation matrix by default and link to its commitment coding. Add an exception only to remap a source commitment account for an inclusive date range. Target percentages must total 100%.',
    emptyExceptions: 'No remap exceptions. Credit memos follow the committed allocation matrix.',
    sourceAccount: 'Source commitment coding', targetAccounts: 'Target credit memo accounts',
    unavailable: 'Unavailable', dateRange: 'Date range', codingLines: 'Coding lines', actions: 'Actions', add: 'Add', edit: 'Edit', delete: 'Delete', cancel: 'Cancel', update: 'Update',
    search: 'Search coding settings', empty: 'No coding settings yet.', noMatch: 'No matching coding settings.',
    deleteTitle: 'Delete coding settings', deleteDescription: 'Remove this set from the configuration?',
    receivable: 'Accounts receivable', creditMemo: 'Credit memos', addSet: 'Add yearly set', addRule: 'Add remap exception',
    fiscalYear: 'Fiscal year', currency: 'Currency', startDate: 'Start date (inclusive)', endDate: 'End date (inclusive)', account: 'Coding account', percentage: 'Percentage',
    invalid: 'Complete all required fields and allocate exactly 100% using distinct accounts. Year/currency sets must be unique; date ranges for the same source commitment account and currency must not overlap.',
    duplicateYear: 'A coding set already exists for this fiscal year and currency. Edit the existing set.',
    lookupError: 'Unable to load Agency settings or accounts. Retry before editing coding.', retry: 'Retry', restore: 'Restores commitment coding', catchAll: 'Clears debt without restoring funding',
    loading: 'Loading settings…',
    saved: 'Cost allocation settings saved.', saveError: 'Unable to save cost allocation settings.',
    noContext: 'Agency context is unavailable.'
  },
  fr: {
    description: 'Configurez la codification annuelle des comptes débiteurs. Les pourcentages de chaque ensemble doivent totaliser 100 %.',
    creditMemoDescription: 'Par défaut, les notes de crédit utilisent la dernière matrice de répartition engagée active et sont liées à ses codes d’engagement. Ajoutez une exception seulement pour rediriger un compte d’engagement source durant une plage de dates inclusive. Les pourcentages cibles doivent totaliser 100 %.',
    emptyExceptions: 'Aucune exception de redirection. Les notes de crédit suivent la matrice de répartition engagée.',
    sourceAccount: 'Codification d’engagement source', targetAccounts: 'Comptes de note de crédit cibles',
    unavailable: 'Indisponible', dateRange: 'Plage de dates', codingLines: 'Lignes de codification', actions: 'Actions', add: 'Ajouter', edit: 'Modifier', delete: 'Supprimer', cancel: 'Annuler', update: 'Mettre à jour',
    search: 'Rechercher des paramètres de codification', empty: 'Aucun paramètre de codification.', noMatch: 'Aucun paramètre de codification correspondant.',
    deleteTitle: 'Supprimer les paramètres de codification', deleteDescription: 'Retirer cet ensemble de la configuration?',
    receivable: 'Comptes débiteurs', creditMemo: 'Notes de crédit', addSet: 'Ajouter un ensemble annuel', addRule: 'Ajouter une exception de redirection',
    fiscalYear: 'Exercice', currency: 'Devise', startDate: 'Date de début (incluse)', endDate: 'Date de fin (incluse)', account: 'Compte comptable', percentage: 'Pourcentage',
    invalid: 'Remplissez tous les champs obligatoires et répartissez exactement 100 % entre des comptes distincts. Les ensembles exercice/devise doivent être uniques; les plages de dates d’un même compte d’engagement source et d’une même devise ne doivent pas se chevaucher.',
    duplicateYear: 'Un ensemble de codes existe déjà pour cet exercice et cette devise. Modifiez l’ensemble existant.',
    lookupError: 'Impossible de charger les paramètres ou les comptes de l’agence. Réessayez avant de modifier les codes.', retry: 'Réessayer', restore: 'Restaure les codes d’engagement', catchAll: 'Règle la dette sans restaurer le financement',
    loading: 'Chargement des paramètres…',
    saved: 'Paramètres de répartition des coûts enregistrés.', saveError: 'Impossible d’enregistrer les paramètres de répartition des coûts.',
    noContext: 'Le contexte de l’agence est indisponible.'
  }
})
