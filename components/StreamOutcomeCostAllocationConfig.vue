<script setup lang="ts">
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsResolvedExtension } from '@gcs-ssc/extensions'
import {
  COMMITMENT_TYPES,
  type CommitmentType,
  type OutcomeCostAllocationConfig,
  parseOutcomeCostAllocationConfig
} from '../shared/allocation'

interface ListResponse<T> {
  items: T[]
}

interface OutcomeItem {
  id: string
  egcs_tp_name_en: string
  egcs_tp_name_fr: string
}

interface StreamBudgetItem {
  id: string
  fiscal_year_display: string
}

interface StreamCommitmentItem {
  id: string
  egcs_tp_streambudget: string
  egcs_tp_gl: number
  egcs_tp_gldescription: string
  fiscal_year_display: string
}

const {
  streamId,
  transferPaymentId
} = defineProps<{
  extension: GcsResolvedExtension
  streamId: string
  transferPaymentId?: string
  agencyId?: string
}>()

const config = defineModel<GcsExtensionJsonConfig>({ required: true })
const { locale } = useI18n()

const localConfig: Ref<OutcomeCostAllocationConfig> = ref(parseOutcomeCostAllocationConfig(config.value))

const { data: outcomesResponse } = useFetch<ListResponse<OutcomeItem>>(
  () => transferPaymentId ? `/api/transfer-payments/${transferPaymentId}/outcomes?page=1&limit=500` : '',
  { watch: [() => transferPaymentId] }
)
const { data: budgetsResponse } = useFetch<ListResponse<StreamBudgetItem>>(
  () => transferPaymentId ? `/api/transfer-payments/${transferPaymentId}/streams/${streamId}/budgets?page=1&limit=500` : '',
  { watch: [() => transferPaymentId, () => streamId] }
)
const { data: commitmentsResponse } = useFetch<ListResponse<StreamCommitmentItem>>(
  () => transferPaymentId ? `/api/transfer-payments/${transferPaymentId}/streams/${streamId}/commitments?page=1&limit=500` : '',
  { watch: [() => transferPaymentId, () => streamId] }
)

const outcomes = computed(() => outcomesResponse.value?.items ?? [])
const budgets = computed(() => budgetsResponse.value?.items ?? [])
const commitments = computed(() => commitmentsResponse.value?.items ?? [])
const isFrench = computed(() => locale.value === 'fr')

const commitmentTypeOptions = computed(() => COMMITMENT_TYPES.map(type => ({
  label: locale.value === 'fr' ? commitmentTypeLabels[type].fr : commitmentTypeLabels[type].en,
  value: type
})))

const selectedCommitmentTypes = computed({
  get: () => localConfig.value.enabledCommitmentTypes,
  set: (value: CommitmentType[]) => {
    localConfig.value = {
      ...localConfig.value,
      enabledCommitmentTypes: value
    }
  }
})

const commitmentOptionsForBudget = (budgetId: string) => commitments.value
  .filter(commitment => String(commitment.egcs_tp_streambudget) === String(budgetId))
  .map(commitment => ({
    label: `${commitment.fiscal_year_display} - GL ${commitment.egcs_tp_gl} - ${commitment.egcs_tp_gldescription}`,
    value: String(commitment.id)
  }))

const outcomeLabel = (outcome: OutcomeItem) => locale.value === 'fr'
  ? outcome.egcs_tp_name_fr
  : outcome.egcs_tp_name_en

const getMappedCommitmentId = (
  commitmentType: CommitmentType,
  outcomeId: string,
  streamBudgetId: string
) => localConfig.value.mappings.find(mapping =>
  mapping.commitmentType === commitmentType
  && mapping.outcomeId === outcomeId
  && mapping.streamBudgetId === streamBudgetId
)?.streamCommitmentId ?? ''

const setMappedCommitmentId = (
  commitmentType: CommitmentType,
  outcomeId: string,
  streamBudgetId: string,
  streamCommitmentId: string
) => {
  const remainingMappings = localConfig.value.mappings.filter(mapping =>
    mapping.commitmentType !== commitmentType
    || mapping.outcomeId !== outcomeId
    || mapping.streamBudgetId !== streamBudgetId
  )

  localConfig.value = {
    ...localConfig.value,
    mappings: streamCommitmentId
      ? [
          ...remainingMappings,
          {
            commitmentType,
            outcomeId,
            streamBudgetId,
            streamCommitmentId
          }
        ]
      : remainingMappings
  }
}

const updateMappedCommitmentId = (
  commitmentType: CommitmentType,
  outcomeId: string,
  streamBudgetId: string,
  value: string | number
) => {
  setMappedCommitmentId(commitmentType, outcomeId, streamBudgetId, String(value || ''))
}

watch(localConfig, value => {
  config.value = {
    enabledCommitmentTypes: value.enabledCommitmentTypes,
    mappings: value.mappings.map(mapping => ({
      commitmentType: mapping.commitmentType,
      outcomeId: mapping.outcomeId,
      streamBudgetId: mapping.streamBudgetId,
      streamCommitmentId: mapping.streamCommitmentId
    }))
  }
}, { deep: true })

watch(config, value => {
  localConfig.value = parseOutcomeCostAllocationConfig(value)
}, { deep: true })

const commitmentTypeLabels: Record<CommitmentType, { en: string, fr: string }> = {
  commitment: { en: 'Commitment', fr: 'Engagement' },
  paye: { en: 'PAYE', fr: 'CAFE' },
  paye2: { en: 'PAYE 2', fr: 'CAFE 2' },
  pyp: { en: 'PYP', fr: 'PAE' }
}

const text = {
  title: {
    en: 'Outcome to commitment line mappings',
    fr: 'Correspondances entre resultats et lignes d engagement'
  },
  enabledTypes: {
    en: 'Enabled commitment types',
    fr: 'Types d engagement actives'
  },
  noContext: {
    en: 'Transfer payment context is unavailable.',
    fr: 'Le contexte du paiement de transfert est indisponible.'
  },
  noRows: {
    en: 'Add program outcomes, stream budgets, and stream commitments before configuring mappings.',
    fr: 'Ajoutez des resultats de programme, des budgets de volet et des engagements de volet avant de configurer les correspondances.'
  }
}

const tLocal = (key: keyof typeof text) => locale.value === 'fr' ? text[key].fr : text[key].en
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-lg font-semibold text-zinc-900 dark:text-white">
        {{ tLocal('title') }}
      </h2>
    </div>

    <p v-if="!transferPaymentId" class="text-sm text-error">
      {{ tLocal('noContext') }}
    </p>

    <UFormField :label="tLocal('enabledTypes')">
      <USelectMenu
        v-model="selectedCommitmentTypes"
        multiple
        value-key="value"
        :items="commitmentTypeOptions"
        class="w-full" />
    </UFormField>

    <p v-if="outcomes.length === 0 || budgets.length === 0 || commitments.length === 0" class="text-sm text-zinc-500">
      {{ tLocal('noRows') }}
    </p>

    <div v-for="commitmentType in selectedCommitmentTypes" :key="commitmentType" class="space-y-4">
      <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
        {{ isFrench ? commitmentTypeLabels[commitmentType].fr : commitmentTypeLabels[commitmentType].en }}
      </h3>

      <div v-for="budget in budgets" :key="budget.id" class="space-y-3">
        <h4 class="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          {{ budget.fiscal_year_display }}
        </h4>

        <div class="overflow-hidden border-y border-zinc-200 dark:border-zinc-800">
          <div
            v-for="outcome in outcomes"
            :key="`${commitmentType}:${budget.id}:${outcome.id}`"
            class="grid gap-3 border-b border-zinc-100 py-3 last:border-b-0 dark:border-zinc-800 md:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)]">
            <div class="text-sm font-medium text-zinc-800 dark:text-zinc-100">
              {{ outcomeLabel(outcome) }}
            </div>
            <USelect
              :model-value="getMappedCommitmentId(commitmentType, String(outcome.id), String(budget.id))"
              value-key="value"
              :items="commitmentOptionsForBudget(String(budget.id))"
              class="w-full"
              @update:model-value="updateMappedCommitmentId(commitmentType, String(outcome.id), String(budget.id), $event)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
