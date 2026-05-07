<script setup lang="ts">
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsExtensionRbacRequirement } from '@gcs-ssc/extensions'
import type { ExtensionEntityTabContext } from '@gcs-ssc/extensions/server'
import {
  type AllocationMethod,
  type OutcomeAllocationInput,
  toMoney,
  validateAllocationTotals
} from '../shared/allocation'

interface AllocationResponse {
  outcomes: Array<{
    id: string
    label_en: string
    label_fr: string
  }>
  budgetYears: Array<{
    id: string
    fiscal_year_display: string
    program_funding: number
  }>
  allocations: OutcomeAllocationInput[]
}

const {
  extensionKey,
  context
} = defineProps<{
  extensionKey: string
  context: ExtensionEntityTabContext
  config: GcsExtensionJsonConfig
  rbac: GcsExtensionRbacRequirement
}>()

const { locale } = useI18n()
const toast = useToast()
const allocations: Ref<OutcomeAllocationInput[]> = ref([])
const isSaving: Ref<boolean> = ref(false)
const saveError: Ref<string> = ref('')

const endpoint = computed(() => `/api/extensions/${extensionKey}/agreements/${context.agreementId}/allocations`)
const { data, refresh, status } = useFetch<AllocationResponse>(() => endpoint.value)

watch(() => data.value, value => {
  allocations.value = value?.allocations.map(allocation => ({ ...allocation })) ?? []
}, { immediate: true })

const outcomes = computed(() => data.value?.outcomes ?? [])
const budgetYears = computed(() => data.value?.budgetYears ?? [])
const localeCode = computed(() => locale.value)
const isLoading = computed(() => status.value === 'pending')

const methodOptions = computed(() => [
  { label: locale.value === 'fr' ? 'Montant' : 'Amount', value: 'amount' },
  { label: locale.value === 'fr' ? 'Pourcentage' : 'Percentage', value: 'percentage' }
])

const getOutcomeLabel = (outcome: AllocationResponse['outcomes'][number]) => locale.value === 'fr'
  ? outcome.label_fr
  : outcome.label_en

const getAllocation = (yearId: string, outcomeId: string): OutcomeAllocationInput => {
  const existing = allocations.value.find(allocation =>
    allocation.agreementBudgetFiscalYearId === yearId
    && allocation.outcomeId === outcomeId
  )
  if (existing) {
    return existing
  }

  const created: OutcomeAllocationInput = {
    agreementBudgetFiscalYearId: yearId,
    outcomeId,
    allocationMethod: 'amount',
    allocationValue: 0
  }
  allocations.value = [...allocations.value, created]
  return created
}

const setAllocationMethod = (yearId: string, outcomeId: string, allocationMethod: AllocationMethod) => {
  const allocation = getAllocation(yearId, outcomeId)
  allocation.allocationMethod = allocationMethod
}

const setAllocationValue = (yearId: string, outcomeId: string, value: string | number) => {
  const allocation = getAllocation(yearId, outcomeId)
  allocation.allocationValue = Number(value || 0)
}

const updateAllocationMethod = (yearId: string, outcomeId: string, value: string | number) => {
  setAllocationMethod(yearId, outcomeId, String(value) as AllocationMethod)
}

const activeAllocations = computed(() => allocations.value.filter(allocation => allocation.allocationValue > 0))

const allocationMethodForYear = (yearId: string): AllocationMethod => {
  const allocation = activeAllocations.value.find(item => item.agreementBudgetFiscalYearId === yearId)
  return allocation?.allocationMethod ?? 'amount'
}

const validationIssues = computed(() => validateAllocationTotals(
  activeAllocations.value,
  budgetYears.value.map(year => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  })),
  new Set(outcomes.value.map(outcome => String(outcome.id)))
))

const validationMessage = computed(() => {
  const issue = validationIssues.value[0]
  if (!issue) {
    return ''
  }

  const messages: Record<string, { en: string, fr: string }> = {
    GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING: {
      en: 'Each budget year needs at least one allocation.',
      fr: 'Chaque exercice budgetaire doit avoir au moins une repartition.'
    },
    GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS: {
      en: 'Use either amounts or percentages within a budget year, not both.',
      fr: 'Utilisez soit des montants, soit des pourcentages dans un exercice budgetaire, pas les deux.'
    },
    GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID: {
      en: 'Percentage allocations must total 100 for each budget year.',
      fr: 'Les pourcentages doivent totaliser 100 pour chaque exercice budgetaire.'
    },
    GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID: {
      en: 'Amount allocations must equal the program funding for each budget year.',
      fr: 'Les montants doivent egaler le financement de programme pour chaque exercice budgetaire.'
    },
    GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME: {
      en: 'One saved allocation references an outcome that is no longer used by agreement activities.',
      fr: 'Une repartition enregistree reference un resultat qui n est plus utilise par les activites de l entente.'
    },
    GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR: {
      en: 'One saved allocation references a budget year that is no longer active.',
      fr: 'Une repartition enregistree reference un exercice budgetaire qui n est plus actif.'
    }
  }

  const message = messages[issue.code]
  if (!message) {
    return issue.message
  }

  return locale.value === 'fr' ? message.fr : message.en
})

const yearAllocatedTotal = (yearId: string) => {
  const method = allocationMethodForYear(yearId)
  const total = activeAllocations.value
    .filter(allocation => allocation.agreementBudgetFiscalYearId === yearId)
    .reduce((sum, allocation) => sum + allocation.allocationValue, 0)
  if (method === 'percentage') {
    return `${toMoney(total)}%`
  }

  return locale.value === 'fr'
    ? new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(total)
    : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(total)
}

const save = async () => {
  if (isSaving.value || validationIssues.value.length > 0) {
    return
  }

  try {
    isSaving.value = true
    saveError.value = ''
    await $fetch(endpoint.value, {
      method: 'PUT',
      body: {
        allocations: activeAllocations.value
      }
    })
    await refresh()
    toast.add({
      title: locale.value === 'fr' ? 'Succes' : 'Success',
      description: locale.value === 'fr' ? 'Repartition enregistree.' : 'Allocation saved.',
      color: 'success'
    })
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isSaving.value = false
  }
}

const text = {
  title: {
    en: 'Outcome cost allocation',
    fr: 'Repartition des couts par resultat'
  },
  empty: {
    en: 'Add agreement activities with outcomes and budget fiscal years before allocating costs.',
    fr: 'Ajoutez des activites avec des resultats et des exercices budgetaires avant de repartir les couts.'
  },
  programFunding: {
    en: 'Program funding',
    fr: 'Financement de programme'
  },
  allocated: {
    en: 'Allocated',
    fr: 'Reparti'
  },
  save: {
    en: 'Save',
    fr: 'Enregistrer'
  }
}

const tLocal = (key: keyof typeof text) => locale.value === 'fr' ? text[key].fr : text[key].en
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold text-zinc-900 dark:text-white">
        {{ tLocal('title') }}
      </h2>
      <UButton
        icon="i-lucide-save"
        :label="tLocal('save')"
        color="primary"
        class="cursor-default"
        :loading="isSaving"
        :disabled="isSaving || validationIssues.length > 0 || isLoading"
        @click="save" />
    </div>

    <p v-if="outcomes.length === 0 || budgetYears.length === 0" class="text-sm text-zinc-500">
      {{ tLocal('empty') }}
    </p>

    <p v-if="validationIssues.length > 0" class="text-sm text-error">
      {{ validationMessage }}
    </p>
    <p v-if="saveError" class="text-sm text-error">
      {{ saveError }}
    </p>

    <div v-for="year in budgetYears" :key="year.id" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-2 dark:border-zinc-800">
        <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
          {{ year.fiscal_year_display }}
        </h3>
        <div class="text-sm text-zinc-600 dark:text-zinc-300">
          {{ tLocal('programFunding') }}: {{ Number(year.program_funding).toLocaleString(localeCode, { style: 'currency', currency: 'CAD' }) }}
          |
          {{ tLocal('allocated') }}: {{ yearAllocatedTotal(String(year.id)) }}
        </div>
      </div>

      <div class="overflow-hidden border-y border-zinc-200 dark:border-zinc-800">
        <div
          v-for="outcome in outcomes"
          :key="`${year.id}:${outcome.id}`"
          class="grid gap-3 border-b border-zinc-100 py-3 last:border-b-0 dark:border-zinc-800 md:grid-cols-[minmax(0,1fr)_10rem_12rem]">
          <div class="text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {{ getOutcomeLabel(outcome) }}
          </div>
          <USelect
            :model-value="getAllocation(String(year.id), String(outcome.id)).allocationMethod"
            value-key="value"
            :items="methodOptions"
            class="w-full"
            @update:model-value="updateAllocationMethod(String(year.id), String(outcome.id), $event)" />
          <input
            :value="getAllocation(String(year.id), String(outcome.id)).allocationValue"
            type="number"
            min="0"
            step="0.01"
            class="h-9 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
            @input="event => setAllocationValue(String(year.id), String(outcome.id), (event.target as HTMLInputElement).value)" >
        </div>
      </div>
    </div>
  </div>
</template>
