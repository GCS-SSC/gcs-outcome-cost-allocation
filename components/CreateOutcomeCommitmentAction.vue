<script setup lang="ts">
import { getClientRequestUrl } from '~/utils/client-request-url'
import { computed, ref } from 'vue'
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

const parseErrorResponse = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return {
      message: response.statusText
    }
  }
}

const createCommitment = async () => {
  if (isSaving.value) {
    return
  }

  try {
    isSaving.value = true
    errorMessage.value = ''
    const response = await fetch(getClientRequestUrl(`/api/agreements/${agreementId}/commitments`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        egcs_fc_type: selectedType.value
      })
    })
    if (!response.ok) {
      throw await parseErrorResponse(response)
    }
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
