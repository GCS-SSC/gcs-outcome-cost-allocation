<script setup lang="ts">
import { CreateOutcomeCommitmentActionErrorMessages, CreateOutcomeCommitmentActionMessages } from '../i18n/CreateOutcomeCommitmentAction'

import { computed, ref, watch } from 'vue'
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
const errorMessage: Ref<string> = ref('')
const commitmentTypes: Ref<Array<{ id: string, label_en: string, label_fr: string }>> = ref([])

const typeOptions = computed(() => configuredTypes.value.map(type => ({
  label: commitmentTypes.value.find(item => item.id === type)?.[locale.value === 'fr' ? 'label_fr' : 'label_en'] ?? type,
  value: type
})))

watch(isOpen, async open => {
  if (!open || commitmentTypes.value.length > 0) return
  try {
    const response = await hostApi.get<{ commitmentTypes: Array<{ id: string, label_en: string, label_fr: string }> }>(
      `/api/extensions/gcs-outcome-cost-allocation/agreements/${agreementId}/allocations`
    )
    commitmentTypes.value = response.commitmentTypes
  } catch {
    commitmentTypes.value = []
  }
})

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
  if (isSaving.value || !selectedType.value) {
    return
  }

  try {
    isSaving.value = true
    errorMessage.value = ''
    await hostApi.post(`/api/agreements/${agreementId}/commitments`, {
      egcs_fc_type: selectedType.value
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
        <ExtensionFormField :label="tLocal('type')" required>
          <ExtensionSelect
            v-model="selectedType"
            value-key="value"
            :items="typeOptions"
            class="w-full" />
        </ExtensionFormField>

        <p v-if="errorMessage" class="text-sm text-error">
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
            :disabled="isSaving || !selectedType"
            @click="createCommitment" />
        </div>
      </div>
    </template>
  </ExtensionModal>
</template>
