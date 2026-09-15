import { expect, it } from 'vitest'
import { translateGcsExtensionMessage } from '@gcs-ssc/extensions'
import { StreamOutcomeCostAllocationConfigMessages } from '../../i18n/StreamOutcomeCostAllocationConfig'
import { notifications } from '../../i18n/notifications'

it('owns stream configuration labels and notification text in both languages', () => {
  expect(translateGcsExtensionMessage(StreamOutcomeCostAllocationConfigMessages, 'en', 'cancel')).toBe('Cancel')
  expect(translateGcsExtensionMessage(StreamOutcomeCostAllocationConfigMessages, 'fr', 'cancel')).toBe('Annuler')
  expect(translateGcsExtensionMessage(notifications, 'fr-CA', 'saved')).toBe('Repartition enregistree.')
  expect(() => translateGcsExtensionMessage(notifications, 'en', 'common.save' as never)).toThrow('Unknown extension message')
})
