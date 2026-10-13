import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'
export const notifications = defineGcsExtensionMessages({
  en: { success: 'Success', error: 'Error', saved: 'Allocation saved.', deleted: 'Draft allocation deleted.' },
  fr: { success: 'Succès', error: 'Erreur', saved: 'Répartition enregistrée.', deleted: 'Ébauche supprimée.' }
})
