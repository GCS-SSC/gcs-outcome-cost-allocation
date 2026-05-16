<script setup lang="ts">
import { getClientRequestUrl } from '~/utils/client-request-url'
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsResolvedExtension } from '@gcs-ssc/extensions'
import {
  COMMITMENT_TYPES,
  type CommitmentType,
  type OutcomeCostAllocationConfig,
  type StreamCommitmentMapping,
  parseOutcomeCostAllocationConfig
} from '../shared/allocation'
import {
  buildStreamOutcomeAllocationTableRows,
  type StreamOutcomeAssociationTableRow,
  type StreamOutcomeHierarchyTableRow
} from '../shared/stream-outcome-cost-allocation-config'

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

interface AssociationDraft {
  streamCommitmentId: string
  commitmentType: CommitmentType
  outcomeId: string
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
const lastSyncedConfigJson: Ref<string> = ref(JSON.stringify({
  enabledCommitmentTypes: localConfig.value.enabledCommitmentTypes,
  mappings: localConfig.value.mappings
}))
const expandedRows: Ref<Record<string, boolean>> = ref({})
const selectedAssociation: Ref<AssociationDraft | null> = ref(null)
const isAssociationModalOpen: Ref<boolean> = ref(false)

const outcomesResponse: Ref<ListResponse<OutcomeItem> | null> = ref(null)
const budgetsResponse: Ref<ListResponse<StreamBudgetItem> | null> = ref(null)
const commitmentsResponse: Ref<ListResponse<StreamCommitmentItem> | null> = ref(null)
const fetchList = async <T>(url: string) => {
  const response = await fetch(getClientRequestUrl(url))
  return response.ok ? await response.json() as ListResponse<T> : { items: [] } as ListResponse<T>
}
const refreshLookups = async () => {
  if (!transferPaymentId) {
    return
  }

  const [outcomeItems, budgetItems, commitmentItems] = await Promise.all([
    fetchList<OutcomeItem>(`/api/transfer-payments/${transferPaymentId}/outcomes?page=1&limit=100`),
    fetchList<StreamBudgetItem>(`/api/transfer-payments/${transferPaymentId}/streams/${streamId}/budgets?page=1&limit=100`),
    fetchList<StreamCommitmentItem>(`/api/transfer-payments/${transferPaymentId}/streams/${streamId}/commitments?page=1&limit=100`)
  ])
  outcomesResponse.value = outcomeItems
  budgetsResponse.value = budgetItems
  commitmentsResponse.value = commitmentItems
}
await refreshLookups()

const outcomes = computed<OutcomeItem[]>(() => outcomesResponse.value?.items ?? [])
const budgets = computed<StreamBudgetItem[]>(() => budgetsResponse.value?.items ?? [])
const commitments = computed<StreamCommitmentItem[]>(() => commitmentsResponse.value?.items ?? [])
const isFrench = computed(() => locale.value === 'fr')

const commitmentTypeOptions = computed(() => COMMITMENT_TYPES.map(type => ({
  label: isFrench.value ? commitmentTypeLabels[type].fr : commitmentTypeLabels[type].en,
  value: type
})))

const outcomeOptions = computed(() => outcomes.value.map((outcome: OutcomeItem) => ({
  label: outcomeLabel(outcome),
  value: String(outcome.id)
})))

const commitmentLineOptions = computed(() => commitments.value.map((commitment: StreamCommitmentItem) => ({
  label: getCommitmentLineLabel(commitment),
  value: String(commitment.id)
})))

const mappingColumns = computed(() => [
  {
    id: 'commitmentLine',
    accessorKey: 'lineLabel',
    header: tLocal('commitmentLine')
  },
  {
    id: 'outcome',
    accessorKey: 'outcomeLabel',
    header: tLocal('outcome')
  },
  {
    id: 'actions',
    header: tLocal('actions')
  }
])

const getCommitmentLineLabel = (commitment: StreamCommitmentItem) =>
  `GL ${commitment.egcs_tp_gl} - ${commitment.egcs_tp_gldescription}`

const outcomeLabel = (outcome: OutcomeItem) => isFrench.value
  ? outcome.egcs_tp_name_fr
  : outcome.egcs_tp_name_en

const getOutcomeName = (outcomeId: string) => {
  const outcome = outcomes.value.find((item: OutcomeItem) => String(item.id) === outcomeId)
  return outcome ? outcomeLabel(outcome) : outcomeId
}

const getBudgetDisplay = (streamBudgetId: string) =>
  budgets.value.find((budget: StreamBudgetItem) => String(budget.id) === streamBudgetId)?.fiscal_year_display ?? streamBudgetId

const associationRows = computed<StreamOutcomeAssociationTableRow[]>(() => localConfig.value.mappings.map(mapping => {
  const commitment = findCommitment(mapping.streamCommitmentId)
  const commitmentTypeLabel = isFrench.value
    ? commitmentTypeLabels[mapping.commitmentType].fr
    : commitmentTypeLabels[mapping.commitmentType].en

  return {
    id: `${mapping.commitmentType}:${mapping.streamBudgetId}:${mapping.outcomeId}:${mapping.streamCommitmentId}`,
    commitmentType: mapping.commitmentType,
    commitmentTypeGroup: commitmentTypeLabel,
    fiscalYearGroup: commitment?.fiscal_year_display ?? getBudgetDisplay(mapping.streamBudgetId),
    streamBudgetId: mapping.streamBudgetId,
    streamCommitmentId: mapping.streamCommitmentId,
    outcomeId: mapping.outcomeId,
    lineLabel: commitment ? getCommitmentLineLabel(commitment) : mapping.streamCommitmentId,
    outcomeLabel: getOutcomeName(mapping.outcomeId)
  }
}).sort((a, b) => {
  const typeCompare = COMMITMENT_TYPES.indexOf(a.commitmentType) - COMMITMENT_TYPES.indexOf(b.commitmentType)
  if (typeCompare !== 0) {
    return typeCompare
  }
  const yearCompare = a.fiscalYearGroup.localeCompare(b.fiscalYearGroup)
  if (yearCompare !== 0) {
    return yearCompare
  }
  const lineCompare = a.lineLabel.localeCompare(b.lineLabel)
  if (lineCompare !== 0) {
    return lineCompare
  }
  return a.outcomeLabel.localeCompare(b.outcomeLabel)
}))

const isExpanded = (groupId: string) => expandedRows.value[groupId] === true
const toggleGroup = (groupId: string) => {
  expandedRows.value = {
    ...expandedRows.value,
    [groupId]: !isExpanded(groupId)
  }
}

const tableRows = computed<StreamOutcomeHierarchyTableRow[]>(() => buildStreamOutcomeAllocationTableRows(associationRows.value, {
  isExpanded,
  recordsLabel: tLocal('records')
}))

const findCommitment = (streamCommitmentId: string) =>
  commitments.value.find((commitment: StreamCommitmentItem) => String(commitment.id) === streamCommitmentId) ?? null

const syncEnabledCommitmentTypes = (mappings: StreamCommitmentMapping[]) =>
  COMMITMENT_TYPES.filter(type => mappings.some(mapping => mapping.commitmentType === type))

const openCreateAssociation = (streamCommitmentId = '') => {
  selectedAssociation.value = {
    streamCommitmentId: streamCommitmentId || String(commitments.value[0]?.id ?? ''),
    commitmentType: COMMITMENT_TYPES[0],
    outcomeId: String(outcomes.value[0]?.id ?? '')
  }
  isAssociationModalOpen.value = true
}

const saveAssociation = () => {
  if (!selectedAssociation.value) {
    return
  }

  const draft = selectedAssociation.value
  const commitment = findCommitment(draft.streamCommitmentId)
  if (!commitment || !draft.outcomeId) {
    return
  }

  const nextMapping: StreamCommitmentMapping = {
    commitmentType: draft.commitmentType,
    outcomeId: draft.outcomeId,
    streamBudgetId: String(commitment.egcs_tp_streambudget),
    streamCommitmentId: String(commitment.id)
  }
  const mappings = [
    ...localConfig.value.mappings.filter(mapping =>
      mapping.commitmentType !== nextMapping.commitmentType
      || mapping.outcomeId !== nextMapping.outcomeId
      || mapping.streamBudgetId !== nextMapping.streamBudgetId
    ),
    nextMapping
  ]

  localConfig.value = {
    enabledCommitmentTypes: syncEnabledCommitmentTypes(mappings),
    mappings
  }
  isAssociationModalOpen.value = false
  selectedAssociation.value = null
}

const removeAssociation = (association: StreamCommitmentMapping) => {
  const mappings = localConfig.value.mappings.filter(mapping =>
    mapping.commitmentType !== association.commitmentType
    || mapping.outcomeId !== association.outcomeId
    || mapping.streamBudgetId !== association.streamBudgetId
    || mapping.streamCommitmentId !== association.streamCommitmentId
  )

  localConfig.value = {
    enabledCommitmentTypes: syncEnabledCommitmentTypes(mappings),
    mappings
  }
}

watch(localConfig, value => {
  const nextConfig = {
    enabledCommitmentTypes: value.enabledCommitmentTypes,
    mappings: value.mappings.map(mapping => ({
      commitmentType: mapping.commitmentType,
      outcomeId: mapping.outcomeId,
      streamBudgetId: mapping.streamBudgetId,
      streamCommitmentId: mapping.streamCommitmentId
    }))
  }
  const nextConfigJson = JSON.stringify(nextConfig)
  if (nextConfigJson === lastSyncedConfigJson.value) {
    return
  }

  lastSyncedConfigJson.value = nextConfigJson
  config.value = nextConfig
}, { deep: true })

watch(config, value => {
  const nextConfig = parseOutcomeCostAllocationConfig(value)
  const nextConfigJson = JSON.stringify(nextConfig)
  if (nextConfigJson === lastSyncedConfigJson.value) {
    return
  }

  lastSyncedConfigJson.value = nextConfigJson
  localConfig.value = nextConfig
}, { deep: true })

const commitmentTypeLabels: Record<CommitmentType, { en: string, fr: string }> = {
  commitment: { en: 'Commitment', fr: 'Engagement' },
  paye: { en: 'PAYE', fr: 'CAFE' },
  paye2: { en: 'PAYE 2', fr: 'CAFE 2' },
  pyp: { en: 'PYP', fr: 'PAE' }
}

const text = {
  title: {
    en: 'Outcome cost allocation associations',
    fr: 'Associations de repartition des couts par resultat'
  },
  noContext: {
    en: 'Transfer payment context is unavailable.',
    fr: 'Le contexte du paiement de transfert est indisponible.'
  },
  noRows: {
    en: 'Add program outcomes, stream budgets, and stream commitments before configuring associations.',
    fr: 'Ajoutez des resultats de programme, des budgets de volet et des engagements de volet avant de configurer les associations.'
  },
  fiscalYear: {
    en: 'Fiscal year',
    fr: 'Exercice'
  },
  commitmentLine: {
    en: 'Commitment line',
    fr: 'Ligne d engagement'
  },
  associations: {
    en: 'Associations',
    fr: 'Associations'
  },
  actions: {
    en: 'Actions',
    fr: 'Actions'
  },
  addAssociation: {
    en: 'Add association',
    fr: 'Ajouter une association'
  },
  removeAssociation: {
    en: 'Remove association',
    fr: 'Retirer l association'
  },
  commitmentType: {
    en: 'Commitment type',
    fr: 'Type d engagement'
  },
  outcome: {
    en: 'Outcome',
    fr: 'Resultat'
  },
  cancel: {
    en: 'Cancel',
    fr: 'Annuler'
  },
  add: {
    en: 'Add',
    fr: 'Ajouter'
  },
  records: {
    en: 'associations',
    fr: 'associations'
  }
}

const tLocal = (key: keyof typeof text) => locale.value === 'fr' ? text[key].fr : text[key].en
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-lg font-semibold text-zinc-900 dark:text-white">
        {{ tLocal('title') }}
      </h2>
      <UButton
        icon="i-lucide-plus"
        :label="tLocal('addAssociation')"
        color="primary"
        class="cursor-default"
        :disabled="outcomes.length === 0 || commitments.length === 0"
        @click="openCreateAssociation()" />
    </div>

    <p v-if="!transferPaymentId" class="text-sm text-error">
      {{ tLocal('noContext') }}
    </p>

    <p v-if="outcomes.length === 0 || budgets.length === 0 || commitments.length === 0" class="text-sm text-zinc-500">
      {{ tLocal('noRows') }}
    </p>

    <div class="overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <UTable
        :data="tableRows"
        :columns="mappingColumns"
        class="min-w-full">
        <template #commitmentLine-cell="{ row }">
          <div v-if="row.original.rowType === 'commitmentType'" class="flex w-full items-center gap-3 py-1">
            <button type="button" class="group flex min-w-0 items-center gap-3 text-left" @click="toggleGroup(row.original.id)">
              <UIcon :name="isExpanded(row.original.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-zinc-400 transition-colors group-hover:text-primary" />
              <span class="text-sm font-semibold text-zinc-900 dark:text-white">{{ row.original.commitmentTypeGroup }}</span>
              <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {{ row.original.associationCount }}
              </span>
            </button>
          </div>
          <div v-else-if="row.original.rowType === 'fiscalYear'" class="flex w-full items-center gap-3 py-1 pl-6">
            <button type="button" class="group flex min-w-0 items-center gap-3 text-left" @click="toggleGroup(row.original.id)">
              <UIcon :name="isExpanded(row.original.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-zinc-400 transition-colors group-hover:text-primary" />
              <span class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{{ row.original.fiscalYearGroup }}</span>
              <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {{ row.original.associationCount }}
              </span>
            </button>
          </div>
          <div v-else class="flex min-w-0 items-center gap-3 py-1 pl-12">
            <UIcon name="i-lucide-corner-down-right" class="size-4 shrink-0 text-zinc-400" />
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                {{ row.original.lineLabel }}
              </div>
              <div class="text-xs text-zinc-500 dark:text-zinc-400">
                {{ getBudgetDisplay(row.original.streamBudgetId) }}
              </div>
            </div>
          </div>
        </template>

        <template #outcome-cell="{ row }">
          <span v-if="row.original.rowType !== 'association'" class="text-sm text-zinc-500 dark:text-zinc-400">
            {{ row.original.associationCount }} {{ tLocal('records') }}
          </span>
          <span v-else class="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {{ row.original.outcomeLabel }}
          </span>
        </template>

        <template #actions-cell="{ row }">
          <div v-if="row.original.rowType === 'association' && row.original.association" class="flex justify-end">
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              class="cursor-default"
              :aria-label="tLocal('removeAssociation')"
              @click="removeAssociation(row.original.association)" />
          </div>
        </template>
      </UTable>
      <div class="border-t border-zinc-200 px-4 py-3 text-xs font-bold tracking-widest text-zinc-400 uppercase dark:border-zinc-800">
        {{ tableRows.length }} {{ tLocal('records') }}
      </div>
    </div>

    <UModal v-if="selectedAssociation" v-model:open="isAssociationModalOpen" :title="tLocal('addAssociation')">
      <template #body>
        <div class="space-y-4">
          <UFormField :label="tLocal('commitmentLine')">
            <USelect
              v-model="selectedAssociation.streamCommitmentId"
              value-key="value"
              :items="commitmentLineOptions"
              class="w-full" />
          </UFormField>
          <UFormField :label="tLocal('commitmentType')">
            <USelect
              v-model="selectedAssociation.commitmentType"
              value-key="value"
              :items="commitmentTypeOptions"
              class="w-full" />
          </UFormField>
          <UFormField :label="tLocal('outcome')">
            <USelect
              v-model="selectedAssociation.outcomeId"
              value-key="value"
              :items="outcomeOptions"
              class="w-full" />
          </UFormField>
          <div class="flex justify-end gap-2 pt-2">
            <UButton :label="tLocal('cancel')" color="neutral" variant="ghost" class="cursor-default" @click="isAssociationModalOpen = false" />
            <UButton
              icon="i-lucide-plus"
              :label="tLocal('add')"
              color="primary"
              class="cursor-default"
              :disabled="!selectedAssociation.streamCommitmentId || !selectedAssociation.outcomeId"
              @click="saveAssociation" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
