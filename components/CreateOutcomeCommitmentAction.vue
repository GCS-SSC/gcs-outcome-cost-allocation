<script setup lang="ts">
import { CreateOutcomeCommitmentActionErrorMessages, CreateOutcomeCommitmentActionMessages } from '../i18n/CreateOutcomeCommitmentAction'

import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { Ref } from 'vue'
import type {
  ExtensionEntityTabContext,
  GcsExtensionCreateOperation,
  GcsExtensionJsonConfig,
  GcsExtensionRbacRequirement
} from '@gcs-ssc/extensions'
import {
  ExtensionButton,
  ExtensionFormField,
  ExtensionModal,
  ExtensionSelect,
  useHostApi,
  useExtensionI18n,
  useExtensionToast
} from '@gcs-ssc/extensions/ui'
import { type CommitmentType, parseOutcomeCostAllocationConfig } from '../shared/allocation'

const {
  agreementId,
  label,
  icon = 'i-lucide-plus',
  onCreated,
  config
} = defineProps<{
  extensionKey: string
  operation: GcsExtensionCreateOperation
  context: ExtensionEntityTabContext
  agencyId: string
  streamId: string
  agreementId: string
  label: { en: string, fr: string }
  icon?: string
  mode: string
  config: GcsExtensionJsonConfig
  rbac: GcsExtensionRbacRequirement
  onCreated: () => void
}>()

const { locale, t: tLocal } = useExtensionI18n(CreateOutcomeCommitmentActionMessages)
const { t: errorText } = useExtensionI18n(CreateOutcomeCommitmentActionErrorMessages)
const toast = useExtensionToast()
const hostApi = useHostApi()
const isOpen: Ref<boolean> = ref(false)
const isSaving: Ref<boolean> = ref(false)
const parsedConfig = parseOutcomeCostAllocationConfig(config)
const configuredTypes = computed(() => parsedConfig.enabledCommitmentTypes)
const selectedType: Ref<CommitmentType> = ref(parsedConfig.enabledCommitmentTypes[0] ?? '')
const selectedCurrency: Ref<string> = ref('')
const availableCurrencies: Ref<string[]> = ref([])
const currencyOptions = computed(() => availableCurrencies.value.map(currency => ({ label: currency.toUpperCase(), value: currency })))
const errorMessage: Ref<string> = ref('')
const errorMessageId = useId()
const commitmentTypes: Ref<Array<{ id: string, label_en: string, label_fr: string }>> = ref([])

const typeOptions = computed(() => configuredTypes.value.map(type => ({
  label: commitmentTypes.value.find(item => item.id === type)?.[locale.value === 'fr' ? 'label_fr' : 'label_en'] ?? type,
  value: type
})))

let lookupSequence = 0
watch([isOpen, () => agreementId], async ([open]) => {
  const sequence = ++lookupSequence
  if (!open) return
  availableCurrencies.value = []
  selectedCurrency.value = ''
  errorMessage.value = ''
  try {
    const response = await hostApi.get<{ commitmentTypes: Array<{ id: string, label_en: string, label_fr: string }>, currency: string }>(
      `/api/extensions/gcs-outcome-cost-allocation/agreements/${agreementId}/allocations`
    )
    if (sequence !== lookupSequence) return
    commitmentTypes.value = response.commitmentTypes
    if (!/^[a-z]{3}$/.test(response.currency)) throw new Error(errorText('GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH'))
    availableCurrencies.value = [response.currency]
    selectedCurrency.value = response.currency
  } catch (error: unknown) {
    if (sequence !== lookupSequence) return
    commitmentTypes.value = []
    errorMessage.value = resolveErrorMessage(error)
  }
})
onBeforeUnmount(() => { lookupSequence += 1 })

const buttonLabel = computed(() => locale.value === 'fr' ? label.fr : label.en)

type ExtensionActionError = {
  data?: {
    code?: string
    message?: string
    data?: {
      code?: string
      message?: string
    }
  }
  message?: string
}

const getConfiguredErrorMessage = (errorCode?: string) => {
  if (!errorCode || !Object.prototype.hasOwnProperty.call(CreateOutcomeCommitmentActionErrorMessages.en, errorCode)) {
    return null
  }

  return errorText(errorCode as keyof typeof CreateOutcomeCommitmentActionErrorMessages.en)
}

const getFallbackErrorMessage = (error: ExtensionActionError, rawError: unknown) =>
  error.data?.data?.message
  ?? error.data?.message
  ?? error.message
  ?? String(rawError)

const resolveErrorMessage = (error: unknown): string => {
  if (!error || typeof error !== 'object') {
    return String(error)
  }

  const err = error as ExtensionActionError

  const errorCode = err.data?.code ?? err.data?.data?.code
  const configuredMessage = getConfiguredErrorMessage(errorCode)
  if (configuredMessage) {
    return configuredMessage
  }

  return getFallbackErrorMessage(err, error)
}

/**
 * Creates the selected commitment type, closing and notifying the host only after a successful request.
 */
const createCommitment = async () => {
  if (isSaving.value || !selectedType.value || !availableCurrencies.value.includes(selectedCurrency.value)) {
    return
  }

  try {
    isSaving.value = true
    errorMessage.value = ''
    await hostApi.post(`/api/agreements/${agreementId}/commitments`, {
      egcs_fc_type: selectedType.value,
      egcs_fc_currency: selectedCurrency.value
    })
    isOpen.value = false
    toast.add({
      title: tLocal("success"),
      description: tLocal("commitment_added"),
      color: 'success'
    })
    onCreated()
  } catch (error: unknown) {
    errorMessage.value = resolveErrorMessage(error)
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <ExtensionModal
    v-model:open="isOpen"
    :title="buttonLabel"
    :description="tLocal('complete_the_form_fields_then_save_or_cancel')">
    <ExtensionButton
      :icon="icon"
      :label="buttonLabel"
      color="primary"
      class="cursor-default" />

    <template #body>
      <div class="space-y-4">
        <ExtensionFormField :label="tLocal('type')" name="egcs_fc_type" required>
          <ExtensionSelect
            v-model="selectedType"
            value-key="value"
            :items="typeOptions"
            name="egcs_fc_type"
            :aria-label="tLocal('type')"
            required
            aria-required="true"
            :aria-describedby="errorMessage ? errorMessageId : undefined"
            :aria-invalid="Boolean(errorMessage)"
            class="w-full" />
        </ExtensionFormField>

        <ExtensionFormField :label="tLocal('currency')" name="egcs_fc_currency" required>
          <ExtensionSelect
            :model-value="selectedCurrency"
            disabled
            :items="currencyOptions"
            value-key="value"
            name="egcs_fc_currency"
            :aria-label="tLocal('currency')"
            required
            aria-required="true"
            :aria-describedby="errorMessage ? errorMessageId : undefined"
            :aria-invalid="Boolean(errorMessage)"
            class="w-full" />
        </ExtensionFormField>

        <p v-if="errorMessage" :id="errorMessageId" class="text-sm text-error">
          {{ errorMessage }}
        </p>

        <div class="flex justify-end gap-2 pt-2">
          <ExtensionButton
            :label="tLocal('cancel')"
            color="neutral"
            variant="ghost"
            class="cursor-default"
            @click="isOpen = false" />
          <ExtensionButton
            icon="i-lucide-save"
            :label="tLocal('add')"
            color="primary"
            class="cursor-default"
            :loading="isSaving"
            :disabled="isSaving || !selectedType || !availableCurrencies.includes(selectedCurrency)"
            @click="createCommitment" />
        </div>
      </div>
    </template>
  </ExtensionModal>
</template>
