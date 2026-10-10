import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'
export const notifications = defineGcsExtensionMessages({
  en: { success: 'Success', error: 'Error', saved: 'Allocation saved.', submitted: 'Cost allocation submitted for approval.', deleted: 'Draft allocation deleted.' },
  fr: { success: 'Succès', error: 'Erreur', saved: 'Répartition enregistrée.', submitted: 'Répartition soumise au processus d’approbation.', deleted: 'Ébauche supprimée.' }
})
