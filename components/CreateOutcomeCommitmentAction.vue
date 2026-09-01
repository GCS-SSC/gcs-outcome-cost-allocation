<script setup lang="ts">
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

const { locale } = useExtensionI18n()
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
const isFrench = computed(() => locale.value === 'fr')

const errorMessages: Record<string, { en: string, fr: string }> = {
  GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING: {
    en: 'The full agreement budget must be allocated before this commitment can be created.',
    fr: 'Le budget complet de l entente doit etre reparti avant de creer cet engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS: {
    en: 'The full agreement budget must be allocated before this commitment can be created.',
    fr: 'Le budget complet de l entente doit etre reparti avant de creer cet engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID: {
    en: 'The full agreement budget must be allocated before this commitment can be created.',
    fr: 'Le budget complet de l entente doit etre reparti avant de creer cet engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID: {
    en: 'The full agreement budget must be allocated before this commitment can be created.',
    fr: 'Le budget complet de l entente doit etre reparti avant de creer cet engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID: {
    en: 'The full agreement budget must be allocated before this commitment can be created.',
    fr: 'Le budget complet de l entente doit etre reparti avant de creer cet engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED: {
    en: 'Complete and activate a cost allocation before creating this commitment.',
    fr: 'Terminez et activez une repartition des couts avant de creer cet engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME: {
    en: 'One saved allocation references an outcome that is no longer used by agreement activities.',
    fr: 'Une repartition enregistree reference un resultat qui n est plus utilise par les activites de l entente.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR: {
    en: 'One saved allocation references a budget year that is no longer active.',
    fr: 'Une repartition enregistree reference un exercice budgetaire qui n est plus actif.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STREAM_BUDGET_MISSING: {
    en: 'A budget year is missing its stream budget mapping.',
    fr: 'Un exercice budgetaire n a pas de correspondance avec un budget de volet.'
  },
  GCS_OUTCOME_COST_ALLOCATION_MAPPING_MISSING: {
    en: 'Configure an outcome-to-commitment-line mapping for this commitment type before creating the commitment.',
    fr: 'Configurez une correspondance entre resultat et ligne d engagement pour ce type d engagement avant de creer l engagement.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE: {
    en: 'One configured stream commitment line is no longer active.',
    fr: 'Une ligne d engagement de volet configuree n est plus active.'
  },
  GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH: {
    en: 'One configured stream commitment line belongs to a different fiscal-year budget.',
    fr: 'Une ligne d engagement de volet configuree appartient au budget d un autre exercice.'
  },
  GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING: {
    en: 'The active cost allocation has no positive allocations for this commitment type.',
    fr: 'La repartition des couts active ne contient aucune repartition positive pour ce type d engagement.'
  }
}

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
  const configuredMessage = errorCode ? errorMessages[errorCode] : undefined
  if (!configuredMessage) {
    return null
  }

  return locale.value === 'fr' ? configuredMessage.fr : configuredMessage.en
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
      title: locale.value === 'fr' ? 'Succes' : 'Success',
      description: locale.value === 'fr' ? 'Engagement ajoute.' : 'Commitment added.',
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
    :description="isFrench
      ? 'Remplissez les champs du formulaire, puis enregistrez ou annulez vos modifications.'
      : 'Complete the form fields, then save or cancel your changes.'">
    <ExtensionButton
      :icon="icon"
      :label="buttonLabel"
      color="primary"
      class="cursor-default" />

    <template #body>
      <div class="space-y-4">
        <ExtensionFormField :label="isFrench ? 'Type' : 'Type'">
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
            :label="isFrench ? 'Annuler' : 'Cancel'"
            color="neutral"
            variant="ghost"
            class="cursor-default"
            @click="isOpen = false" />
          <ExtensionButton
            icon="i-lucide-save"
            :label="isFrench ? 'Ajouter' : 'Add'"
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
