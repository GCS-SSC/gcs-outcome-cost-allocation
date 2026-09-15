import { defineGcsExtensionMessages } from '@gcs-ssc/extensions'
export const notifications = defineGcsExtensionMessages({
  en: { success: 'Success', error: 'Error', saved: 'Allocation saved.', submitted: 'Cost allocation submitted for approval.', deleted: 'Draft allocation deleted.' },
  fr: { success: 'Succes', error: 'Erreur', saved: 'Repartition enregistree.', submitted: 'Repartition soumise au processus d approbation.', deleted: 'Brouillon supprime.' }
})
