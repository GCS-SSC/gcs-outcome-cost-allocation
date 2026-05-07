<script setup lang="ts">
import type { Ref } from 'vue'
import type {
  GcsExtensionCreateOperation,
  GcsExtensionJsonConfig,
  GcsExtensionRbacRequirement
} from '@gcs-ssc/extensions'
import type { ExtensionEntityTabContext } from '@gcs-ssc/extensions/server'
import {
  COMMITMENT_TYPES,
  type CommitmentType
} from '../shared/allocation'

const {
  agreementId,
  label,
  icon = 'i-lucide-plus',
  onCreated
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

const { locale } = useI18n()
const toast = useToast()
const isOpen: Ref<boolean> = ref(false)
const isSaving: Ref<boolean> = ref(false)
const selectedType: Ref<CommitmentType> = ref('commitment')
const errorMessage: Ref<string> = ref('')

const commitmentTypeLabels: Record<CommitmentType, { en: string, fr: string }> = {
  commitment: { en: 'Commitment', fr: 'Engagement' },
  paye: { en: 'PAYE', fr: 'CAFE' },
  paye2: { en: 'PAYE 2', fr: 'CAFE 2' },
  pyp: { en: 'PYP', fr: 'PAE' }
}

const typeOptions = computed(() => COMMITMENT_TYPES.map(type => ({
  label: locale.value === 'fr' ? commitmentTypeLabels[type].fr : commitmentTypeLabels[type].en,
  value: type
})))

const buttonLabel = computed(() => locale.value === 'fr' ? label.fr : label.en)
const isFrench = computed(() => locale.value === 'fr')

const createCommitment = async () => {
  if (isSaving.value) {
    return
  }

  try {
    isSaving.value = true
    errorMessage.value = ''
    await $fetch(`/api/agreements/${agreementId}/commitments`, {
      method: 'POST',
      body: {
        egcs_fc_type: selectedType.value
      }
    })
    isOpen.value = false
    toast.add({
      title: locale.value === 'fr' ? 'Succes' : 'Success',
      description: locale.value === 'fr' ? 'Engagement ajoute.' : 'Commitment added.',
      color: 'success'
    })
    onCreated()
  } catch (error: unknown) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="isOpen" :title="buttonLabel">
    <UButton
      :icon="icon"
      :label="buttonLabel"
      color="primary"
      class="cursor-default" />

    <template #body>
      <div class="space-y-4">
        <UFormField :label="isFrench ? 'Type' : 'Type'">
          <USelect
            v-model="selectedType"
            value-key="value"
            :items="typeOptions"
            class="w-full" />
        </UFormField>

        <p v-if="errorMessage" class="text-sm text-error">
          {{ errorMessage }}
        </p>

        <div class="flex justify-end gap-2 pt-2">
          <UButton
            :label="isFrench ? 'Annuler' : 'Cancel'"
            color="neutral"
            variant="ghost"
            class="cursor-default"
            @click="isOpen = false" />
          <UButton
            icon="i-lucide-save"
            :label="isFrench ? 'Ajouter' : 'Add'"
            color="primary"
            class="cursor-default"
            :loading="isSaving"
            :disabled="isSaving"
            @click="createCommitment" />
        </div>
      </div>
    </template>
  </UModal>
</template>
