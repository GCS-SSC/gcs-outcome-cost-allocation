<script setup lang="ts">
import { getClientRequestUrl } from '~/utils/client-request-url'
import type { Ref } from 'vue'
import type { GcsExtensionJsonConfig, GcsExtensionRbacRequirement } from '@gcs-ssc/extensions'
import type { ExtensionEntityTabContext } from '@gcs-ssc/extensions/server'
import {
  COMMITMENT_TYPES,
  type AllocationMethod,
  type AllocationVersionStatus,
  type CommitmentType,
  type CostAllocationVersion,
  type OutcomeAllocationInput,
  type VersionedOutcomeAllocationInput,
  parseOutcomeCostAllocationConfig,
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
    stream_budget_id?: string | null
    fiscal_year_display: string
    program_funding: number
  }>
  versions: CostAllocationVersion[]
  allocations: VersionedOutcomeAllocationInput[]
  streamCommitments: Array<{
    id: string
    stream_budget_id: string
    fiscal_year_display: string
    gl: number
    gl_description: string
  }>
}

type AllocationOutcome = AllocationResponse['outcomes'][number]
type AllocationBudgetYear = AllocationResponse['budgetYears'][number]
type AllocationStreamCommitment = AllocationResponse['streamCommitments'][number]

interface ConfiguredAssociationRow {
  id: string
  commitmentType: CommitmentType
  commitmentTypeLabel: string
  yearId: string
  yearLabel: string
  programFunding: number
  streamBudgetId: string
  streamCommitmentId: string
  commitmentLineLabel: string
  outcomeId: string
  outcomeLabel: string
}

interface AllocationTableRow {
  id: string
  rowType: 'commitmentType' | 'fiscalYear' | 'association'
  commitmentType?: CommitmentType
  commitmentTypeLabel: string
  yearId: string
  yearLabel: string
  streamBudgetId: string
  commitmentLineLabel: string
  outcomeId: string
  outcomeLabel: string
  associationCount: number
  programFunding: number
  association?: ConfiguredAssociationRow
}

interface ApiErrorResponse {
  message?: string
  statusMessage?: string
  data?: {
    message?: string
    details?: Array<{
      message?: string
    }>
  }
}

const {
  extensionKey,
  context,
  config
} = defineProps<{
  extensionKey: string
  context: ExtensionEntityTabContext
  config: GcsExtensionJsonConfig
  rbac: GcsExtensionRbacRequirement
}>()

const { locale } = useI18n()
const toast = useToast()
const allocations: Ref<VersionedOutcomeAllocationInput[]> = ref([])
const selectedVersionId: Ref<string> = ref('')
const isSaving: Ref<boolean> = ref(false)
const isCompleting: Ref<boolean> = ref(false)
const isCreatingDraft: Ref<boolean> = ref(false)
const deletingVersionId: Ref<string> = ref('')
const saveError: Ref<string> = ref('')
const expandedRows: Ref<Record<string, boolean>> = ref({})

const endpoint = computed(() => `/api/extensions/${extensionKey}/agreements/${context.agreementId}/allocations`)
const data: Ref<AllocationResponse | null> = ref(null)
const status: Ref<'idle' | 'pending' | 'success' | 'error'> = ref('idle')
const refresh = async () => {
  try {
    status.value = 'pending'
    const response = await fetch(getClientRequestUrl(endpoint.value))
    data.value = response.ok ? await response.json() as AllocationResponse : null
    status.value = response.ok ? 'success' : 'error'
  } catch {
    data.value = null
    status.value = 'error'
  }
}
await refresh()

watch(() => data.value, value => {
  allocations.value = value?.allocations.map((allocation: VersionedOutcomeAllocationInput) => ({ ...allocation })) ?? []
  const versions = value?.versions ?? []
  if (!selectedVersionId.value || !versions.some((version: CostAllocationVersion) => version.id === selectedVersionId.value)) {
    selectedVersionId.value = versions.find((version: CostAllocationVersion) => version.status === 'draft')?.id
      ?? versions.find((version: CostAllocationVersion) => version.status === 'active')?.id
      ?? versions[0]?.id
      ?? ''
  }
}, { immediate: true })

const outcomes = computed<AllocationOutcome[]>(() => data.value?.outcomes ?? [])
const budgetYears = computed<AllocationBudgetYear[]>(() => data.value?.budgetYears ?? [])
const streamCommitments = computed<AllocationStreamCommitment[]>(() => data.value?.streamCommitments ?? [])
const versions = computed<CostAllocationVersion[]>(() => data.value?.versions ?? [])
const selectedVersion = computed<CostAllocationVersion | null>(() => versions.value.find((version: CostAllocationVersion) => version.id === selectedVersionId.value) ?? null)
const canEditSelectedVersion = computed(() => selectedVersion.value?.status === 'draft')
const hasDraftVersion = computed(() => versions.value.some((version: CostAllocationVersion) => version.status === 'draft'))
const isLoading = computed(() => status.value === 'pending')
const streamConfig = computed(() => parseOutcomeCostAllocationConfig(config))

const methodOptions = computed(() => [
  { label: locale.value === 'fr' ? 'Montant' : 'Amount', value: 'amount' },
  { label: locale.value === 'fr' ? 'Pourcentage' : 'Percentage', value: 'percentage' }
])

const getOutcomeLabel = (outcome: AllocationOutcome) => locale.value === 'fr'
  ? outcome.label_fr
  : outcome.label_en

const commitmentTypeLabels: Record<CommitmentType, { en: string, fr: string }> = {
  commitment: { en: 'Commitment', fr: 'Engagement' },
  paye: { en: 'PAYE', fr: 'CAFE' },
  paye2: { en: 'PAYE 2', fr: 'CAFE 2' },
  pyp: { en: 'PYP', fr: 'PAE' }
}

const allocationColumns = computed(() => [
  {
    id: 'commitmentLine',
    accessorKey: 'commitmentLineLabel',
    header: tLocal('commitmentLine')
  },
  {
    id: 'outcome',
    accessorKey: 'outcomeLabel',
    header: tLocal('outcome')
  },
  {
    id: 'method',
    header: tLocal('method')
  },
  {
    id: 'value',
    header: tLocal('value')
  },
  {
    id: 'amount',
    header: tLocal('amount')
  }
])

const formatMoney = (value: number) => new Intl.NumberFormat(
  locale.value === 'fr' ? 'fr-CA' : 'en-CA',
  { style: 'currency', currency: 'CAD' }
).format(value)

const formatDate = (value?: string | null) => {
  if (!value) {
    return ''
  }

  return new Intl.DateTimeFormat(locale.value === 'fr' ? 'fr-CA' : 'en-CA', {
    dateStyle: 'medium'
  }).format(new Date(value))
}

const getStatusLabel = (statusValue: AllocationVersionStatus) => {
  const labels: Record<AllocationVersionStatus, { en: string, fr: string }> = {
    draft: { en: 'Draft', fr: 'Brouillon' },
    active: { en: 'Active', fr: 'Active' },
    inactive: { en: 'Inactive', fr: 'Inactive' }
  }
  const label = labels[statusValue]
  return locale.value === 'fr' ? label.fr : label.en
}

type BadgeColor = 'neutral' | 'success' | 'warning'

const getStatusColor = (statusValue: AllocationVersionStatus): BadgeColor => {
  const colors: Record<AllocationVersionStatus, BadgeColor> = {
    draft: 'neutral',
    active: 'success',
    inactive: 'warning'
  }
  return colors[statusValue]
}

const getCommitmentTypeLabel = (commitmentType: CommitmentType) =>
  locale.value === 'fr' ? commitmentTypeLabels[commitmentType].fr : commitmentTypeLabels[commitmentType].en

const getOutcomeName = (outcomeId: string) => {
  const outcome = outcomes.value.find((item: AllocationOutcome) => String(item.id) === outcomeId)
  return outcome ? getOutcomeLabel(outcome) : outcomeId
}

const getCommitmentLineLabel = (streamCommitmentId: string) => {
  const commitment = streamCommitments.value.find((item: AllocationStreamCommitment) => String(item.id) === streamCommitmentId)
  return commitment ? `GL ${commitment.gl} - ${commitment.gl_description}` : streamCommitmentId
}

const getYearForStreamBudget = (streamBudgetId: string) =>
  budgetYears.value.find((year: AllocationBudgetYear) => String(year.stream_budget_id ?? '') === streamBudgetId) ?? null

const configuredAssociationRows = computed<ConfiguredAssociationRow[]>(() => streamConfig.value.mappings.flatMap(mapping => {
  const year = getYearForStreamBudget(mapping.streamBudgetId)
  const hasOutcome = outcomes.value.some((outcome: AllocationOutcome) => String(outcome.id) === mapping.outcomeId)
  if (!year || !hasOutcome) {
    return []
  }

  return [{
    id: `${mapping.commitmentType}:${mapping.streamBudgetId}:${mapping.streamCommitmentId}:${mapping.outcomeId}`,
    commitmentType: mapping.commitmentType,
    commitmentTypeLabel: getCommitmentTypeLabel(mapping.commitmentType),
    yearId: String(year.id),
    yearLabel: year.fiscal_year_display,
    programFunding: Number(year.program_funding),
    streamBudgetId: mapping.streamBudgetId,
    streamCommitmentId: mapping.streamCommitmentId,
    commitmentLineLabel: getCommitmentLineLabel(mapping.streamCommitmentId),
    outcomeId: mapping.outcomeId,
    outcomeLabel: getOutcomeName(mapping.outcomeId)
  }]
}).sort((a, b) => {
  const typeCompare = COMMITMENT_TYPES.indexOf(a.commitmentType) - COMMITMENT_TYPES.indexOf(b.commitmentType)
  if (typeCompare !== 0) {
    return typeCompare
  }
  const yearCompare = a.yearLabel.localeCompare(b.yearLabel)
  if (yearCompare !== 0) {
    return yearCompare
  }
  const lineCompare = a.commitmentLineLabel.localeCompare(b.commitmentLineLabel)
  if (lineCompare !== 0) {
    return lineCompare
  }
  return a.outcomeLabel.localeCompare(b.outcomeLabel)
}))

const getCommitmentTypeGroupId = (commitmentType: CommitmentType) => `type:${commitmentType}`
const getFiscalYearGroupId = (commitmentType: CommitmentType, yearId: string) => `year:${commitmentType}:${yearId}`
const isExpanded = (groupId: string) => expandedRows.value[groupId] !== false
const toggleGroup = (groupId: string) => {
  expandedRows.value = {
    ...expandedRows.value,
    [groupId]: !isExpanded(groupId)
  }
}

const allocationRows = computed<AllocationTableRow[]>(() => {
  const rows: AllocationTableRow[] = []

  for (const commitmentType of COMMITMENT_TYPES) {
    const typeRows = configuredAssociationRows.value.filter((row: ConfiguredAssociationRow) => row.commitmentType === commitmentType)
    if (typeRows.length === 0) {
      continue
    }

    const commitmentTypeLabel = getCommitmentTypeLabel(commitmentType)
    const typeGroupId = getCommitmentTypeGroupId(commitmentType)
    rows.push({
      id: typeGroupId,
      rowType: 'commitmentType',
      commitmentType,
      commitmentTypeLabel,
      yearId: '',
      yearLabel: '',
      streamBudgetId: '',
      commitmentLineLabel: commitmentTypeLabel,
      outcomeId: '',
      outcomeLabel: `${typeRows.length} ${tLocal('records')}`,
      associationCount: typeRows.length,
      programFunding: 0
    })

    if (!isExpanded(typeGroupId)) {
      continue
    }

    const yearIds = Array.from(new Set(typeRows.map((row: ConfiguredAssociationRow) => row.yearId)))
    for (const yearId of yearIds) {
      const yearRows = typeRows.filter((row: ConfiguredAssociationRow) => row.yearId === yearId)
      const firstYearRow = yearRows[0]
      if (!firstYearRow) {
        continue
      }

      const yearGroupId = getFiscalYearGroupId(commitmentType, yearId)
      rows.push({
        id: yearGroupId,
        rowType: 'fiscalYear',
        commitmentType,
        commitmentTypeLabel,
        yearId,
        yearLabel: firstYearRow.yearLabel,
        streamBudgetId: firstYearRow.streamBudgetId,
        commitmentLineLabel: firstYearRow.yearLabel,
        outcomeId: '',
        outcomeLabel: `${yearRows.length} ${tLocal('records')}`,
        associationCount: yearRows.length,
        programFunding: firstYearRow.programFunding
      })

      if (!isExpanded(yearGroupId)) {
        continue
      }

      rows.push(...yearRows.map(row => ({
        id: row.id,
        rowType: 'association' as const,
        commitmentType,
        commitmentTypeLabel,
        yearId: row.yearId,
        yearLabel: row.yearLabel,
        streamBudgetId: row.streamBudgetId,
        commitmentLineLabel: row.commitmentLineLabel,
        outcomeId: row.outcomeId,
        outcomeLabel: row.outcomeLabel,
        associationCount: 1,
        programFunding: row.programFunding,
        association: row
      })))
    }
  }

  return rows
})

const getAllocation = (association: ConfiguredAssociationRow): OutcomeAllocationInput => {
  const existing = allocations.value.find(allocation =>
    allocation.allocationVersionId === selectedVersionId.value
    && allocation.commitmentType === association.commitmentType
    && allocation.streamCommitmentId === association.streamCommitmentId
    && allocation.agreementBudgetFiscalYearId === association.yearId
    && allocation.outcomeId === association.outcomeId
  )
  if (existing) {
    return existing
  }

  const created: VersionedOutcomeAllocationInput = {
    allocationVersionId: selectedVersionId.value,
    commitmentType: association.commitmentType,
    streamCommitmentId: association.streamCommitmentId,
    agreementBudgetFiscalYearId: association.yearId,
    outcomeId: association.outcomeId,
    allocationMethod: 'amount',
    allocationValue: 0
  }
  allocations.value = [...allocations.value, created]
  return created
}

const setAllocationMethod = (association: ConfiguredAssociationRow, allocationMethod: AllocationMethod) => {
  const allocation = getAllocation(association)
  allocation.allocationMethod = allocationMethod
}

const setAllocationValue = (association: ConfiguredAssociationRow, value: string | number) => {
  const allocation = getAllocation(association)
  allocation.allocationValue = Number(value || 0)
}

const updateAllocationMethod = (association: ConfiguredAssociationRow, value: string | number) => {
  setAllocationMethod(association, String(value) as AllocationMethod)
}

const updateAllocationRowValue = (row: AllocationTableRow, value: string | number) => {
  if (!row.association) {
    return
  }

  setAllocationValue(row.association, value)
}

const activeAllocations = computed<VersionedOutcomeAllocationInput[]>(() => allocations.value.filter((allocation: VersionedOutcomeAllocationInput) =>
  allocation.allocationVersionId === selectedVersionId.value && allocation.allocationValue > 0
))

const getProgramFunding = (yearId: string) =>
  Number(budgetYears.value.find((year: AllocationBudgetYear) => String(year.id) === yearId)?.program_funding ?? 0)

const getAllocationInputAmount = (allocation: OutcomeAllocationInput) => allocation.allocationMethod === 'percentage'
  ? toMoney(getProgramFunding(allocation.agreementBudgetFiscalYearId) * allocation.allocationValue / 100)
  : toMoney(allocation.allocationValue)

const getAllocationAmount = (association: ConfiguredAssociationRow) => {
  const allocation = getAllocation(association)
  return getAllocationInputAmount(allocation)
}

const getVersionAllocations = (versionId: string) => allocations.value.filter((allocation: VersionedOutcomeAllocationInput) =>
  allocation.allocationVersionId === versionId && allocation.allocationValue > 0
)

const getVersionTotal = (versionId: string) => getVersionAllocations(versionId)
  .reduce((sum: number, allocation: VersionedOutcomeAllocationInput) => toMoney(sum + getAllocationInputAmount(allocation)), 0)

const selectVersion = (versionId: string) => {
  selectedVersionId.value = versionId
}

const validationIssues = computed(() => validateAllocationTotals(
  activeAllocations.value,
  budgetYears.value.map((year: AllocationBudgetYear) => ({
    agreementBudgetFiscalYearId: String(year.id),
    programFunding: Number(year.program_funding)
  })),
  new Set(outcomes.value.map((outcome: AllocationOutcome) => String(outcome.id)))
))

const validationMessage = computed(() => {
  const issue = validationIssues.value[0]
  if (!issue) {
    return ''
  }

  const messages: Record<string, { en: string, fr: string }> = {
    GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING: {
      en: 'The full agreement budget must be allocated.',
      fr: 'Le budget complet de l entente doit etre reparti.'
    },
    GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS: {
      en: 'The full agreement budget must be allocated.',
      fr: 'Le budget complet de l entente doit etre reparti.'
    },
    GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID: {
      en: 'The full agreement budget must be allocated.',
      fr: 'Le budget complet de l entente doit etre reparti.'
    },
    GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID: {
      en: 'The full agreement budget must be allocated.',
      fr: 'Le budget complet de l entente doit etre reparti.'
    },
    GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID: {
      en: 'The full agreement budget must be allocated.',
      fr: 'Le budget complet de l entente doit etre reparti.'
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

const getGroupAmountTotal = (rows: ConfiguredAssociationRow[]) => rows
  .reduce((sum: number, row: ConfiguredAssociationRow) => sum + getAllocationAmount(row), 0)

const getCommitmentTypeAmountTotal = (commitmentType: CommitmentType) =>
  getGroupAmountTotal(configuredAssociationRows.value.filter((row: ConfiguredAssociationRow) => row.commitmentType === commitmentType))

const getFiscalYearAmountTotal = (commitmentType: CommitmentType, yearId: string) =>
  getGroupAmountTotal(configuredAssociationRows.value.filter((row: ConfiguredAssociationRow) =>
    row.commitmentType === commitmentType && row.yearId === yearId
  ))

const getAmountForRow = (row: AllocationTableRow) => {
  if (row.rowType === 'commitmentType' && row.commitmentType) {
    return getCommitmentTypeAmountTotal(row.commitmentType)
  }

  if (row.rowType === 'fiscalYear' && row.commitmentType) {
    return getFiscalYearAmountTotal(row.commitmentType, row.yearId)
  }

  return row.association ? getAllocationAmount(row.association) : 0
}

const getResponseErrorMessage = async (response: Response) => {
  try {
    const body = await response.json() as ApiErrorResponse
    return body.data?.message
      ?? body.data?.details?.[0]?.message
      ?? body.message
      ?? body.statusMessage
      ?? response.statusText
  } catch {
    return response.statusText
  }
}

const save = async () => {
  if (isSaving.value || !canEditSelectedVersion.value || !selectedVersionId.value) {
    return false
  }

  try {
    isSaving.value = true
    saveError.value = ''
    const response = await fetch(getClientRequestUrl(endpoint.value), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        allocationVersionId: selectedVersionId.value,
        allocations: activeAllocations.value
      })
    })
    if (!response.ok) throw new Error(await getResponseErrorMessage(response))
    await refresh()
    toast.add({
      title: locale.value === 'fr' ? 'Succes' : 'Success',
      description: locale.value === 'fr' ? 'Repartition enregistree.' : 'Allocation saved.',
      color: 'success'
    })
    return true
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    isSaving.value = false
  }
}

const completeSelectedVersion = async () => {
  if (isCompleting.value || !canEditSelectedVersion.value || !selectedVersionId.value) {
    return
  }

  if (validationIssues.value.length > 0) {
    toast.add({
      title: locale.value === 'fr' ? 'Erreur' : 'Error',
      description: validationMessage.value,
      color: 'error'
    })
    return
  }

  try {
    isCompleting.value = true
    saveError.value = ''
    const saved = await save()
    if (!saved) {
      return
    }
    const response = await fetch(getClientRequestUrl(`${endpoint.value.replace('/allocations', '/allocation-versions')}/${selectedVersionId.value}/complete`), {
      method: 'POST'
    })
    if (!response.ok) throw new Error(await getResponseErrorMessage(response))
    await refresh()
    toast.add({
      title: locale.value === 'fr' ? 'Succes' : 'Success',
      description: locale.value === 'fr' ? 'Repartition activee.' : 'Cost allocation activated.',
      color: 'success'
    })
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
    toast.add({
      title: locale.value === 'fr' ? 'Erreur' : 'Error',
      description: saveError.value,
      color: 'error'
    })
  } finally {
    isCompleting.value = false
  }
}

const createDraftVersion = async () => {
  if (isCreatingDraft.value) {
    return
  }

  try {
    isCreatingDraft.value = true
    saveError.value = ''
    const fetchResponse = await fetch(getClientRequestUrl(endpoint.value.replace('/allocations', '/allocation-versions')), {
      method: 'POST'
    })
    if (!fetchResponse.ok) throw new Error(await getResponseErrorMessage(fetchResponse))
    const response = await fetchResponse.json() as { version?: CostAllocationVersion }
    await refresh()
    if (response.version?.id) {
      selectedVersionId.value = response.version.id
    }
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isCreatingDraft.value = false
  }
}

const deleteDraftVersion = async (versionId: string) => {
  if (deletingVersionId.value) {
    return
  }

  try {
    deletingVersionId.value = versionId
    saveError.value = ''
    const response = await fetch(getClientRequestUrl(`${endpoint.value.replace('/allocations', '/allocation-versions')}/${versionId}`), {
      method: 'DELETE'
    })
    if (!response.ok) throw new Error(await getResponseErrorMessage(response))
    if (selectedVersionId.value === versionId) {
      selectedVersionId.value = ''
    }
    await refresh()
    toast.add({
      title: locale.value === 'fr' ? 'Succes' : 'Success',
      description: locale.value === 'fr' ? 'Brouillon supprime.' : 'Draft allocation deleted.',
      color: 'success'
    })
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    deletingVersionId.value = ''
  }
}

const canDeleteVersion = (version: CostAllocationVersion) => version.status === 'draft' && deletingVersionId.value !== version.id

const text = {
  title: {
    en: 'Cost allocation',
    fr: 'Repartition des couts'
  },
  empty: {
    en: 'Add agreement activities with outcomes, budget fiscal years, and stream cost allocation configuration before allocating costs.',
    fr: 'Ajoutez des activites avec des resultats, des exercices budgetaires et la configuration de repartition des couts du volet avant de repartir les couts.'
  },
  outcome: {
    en: 'Outcome',
    fr: 'Resultat'
  },
  commitmentLine: {
    en: 'Commitment line',
    fr: 'Ligne d engagement'
  },
  method: {
    en: 'Method',
    fr: 'Methode'
  },
  value: {
    en: 'Value',
    fr: 'Valeur'
  },
  amount: {
    en: 'Amount',
    fr: 'Montant'
  },
  version: {
    en: 'Version',
    fr: 'Version'
  },
  status: {
    en: 'Status',
    fr: 'Statut'
  },
  actions: {
    en: 'Actions',
    fr: 'Actions'
  },
  allocationVersions: {
    en: 'Cost allocations',
    fr: 'Repartitions des couts'
  },
  selectedAllocation: {
    en: 'Selected allocation',
    fr: 'Repartition selectionnee'
  },
  newDraft: {
    en: 'New draft',
    fr: 'Nouveau brouillon'
  },
  complete: {
    en: 'Complete',
    fr: 'Terminer'
  },
  view: {
    en: 'View',
    fr: 'Voir'
  },
  delete: {
    en: 'Delete',
    fr: 'Supprimer'
  },
  selected: {
    en: 'Selected',
    fr: 'Selectionnee'
  },
  readonly: {
    en: 'Only draft allocations can be edited.',
    fr: 'Seules les repartitions en brouillon peuvent etre modifiees.'
  },
  records: {
    en: 'allocations',
    fr: 'repartitions'
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
        icon="i-lucide-plus"
        :label="tLocal('newDraft')"
        color="primary"
        class="cursor-default"
        :loading="isCreatingDraft"
        :disabled="isCreatingDraft || isLoading || hasDraftVersion"
        @click="createDraftVersion" />
    </div>

    <p v-if="outcomes.length === 0 || budgetYears.length === 0 || configuredAssociationRows.length === 0" class="text-sm text-zinc-500">
      {{ tLocal('empty') }}
    </p>

    <p v-if="saveError" class="text-sm text-error">
      {{ saveError }}
    </p>

    <div class="space-y-3">
      <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
        {{ tLocal('allocationVersions') }}
      </h3>
      <div class="overflow-x-auto rounded-sm border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table class="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <caption class="sr-only">
            {{ tLocal('allocationVersions') }}
          </caption>
          <thead>
            <tr class="bg-zinc-100 text-left text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:bg-zinc-900 dark:text-zinc-400">
              <th scope="col" class="min-w-56 px-4 py-4">
                {{ tLocal('version') }}
              </th>
              <th scope="col" class="min-w-48 px-4 py-4">
                {{ tLocal('status') }}
              </th>
              <th scope="col" class="min-w-48 px-4 py-4">
                {{ tLocal('amount') }}
              </th>
              <th scope="col" class="w-40 px-4 py-4 text-right">
                {{ tLocal('actions') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(version, versionIndex) in versions"
              :key="version.id"
              :aria-current="version.id === selectedVersionId ? 'true' : undefined"
              tabindex="0"
              role="button"
              :class="[
                versionIndex > 0 && version.id !== selectedVersionId && versions[versionIndex - 1]?.id !== selectedVersionId ? 'border-t border-zinc-200 dark:border-zinc-800' : '',
                version.id === selectedVersionId ? 'border-l-4 border-primary bg-blue-50/60 dark:bg-blue-950/20' : 'border-l-4 border-transparent',
                'cursor-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary hover:bg-zinc-50 dark:hover:bg-zinc-900/60'
              ]"
              @click="selectVersion(version.id)"
              @keydown.enter.prevent="selectVersion(version.id)"
              @keydown.space.prevent="selectVersion(version.id)">
              <th scope="row" class="px-4 py-4 text-left">
                <div class="flex min-w-0 items-center gap-3">
                  <UIcon
                    v-if="version.id === selectedVersionId"
                    name="i-lucide-check-circle-2"
                    class="size-4 shrink-0 text-primary"
                    aria-hidden="true" />
                  <div class="min-w-0">
                    <div class="font-semibold text-zinc-900 dark:text-white">
                      {{ tLocal('version') }} {{ version.versionNumber }}
                    </div>
                    <div class="text-xs text-zinc-500 dark:text-zinc-400">
                      {{ formatDate(version.completedAt ?? version.createdAt) }}
                    </div>
                  </div>
                </div>
              </th>
              <td class="px-4 py-4">
                <CommonStatusBadge enum-name="statuses" :status="version.status" />
              </td>
              <td class="px-4 py-4 font-semibold">
                <span>
                  {{ formatMoney(getVersionTotal(version.id)) }}
                </span>
              </td>
              <td class="px-4 py-4">
                <div class="flex justify-end gap-2" @click.stop>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    class="cursor-default"
                    :icon="version.id === selectedVersionId ? 'i-lucide-check' : 'i-lucide-panel-top-open'"
                    :disabled="version.id === selectedVersionId"
                    @click="selectVersion(version.id)">
                    {{ version.id === selectedVersionId ? tLocal('selected') : tLocal('view') }}
                  </UButton>
                  <UButton
                    v-if="version.status === 'draft'"
                    color="error"
                    variant="ghost"
                    size="sm"
                    icon="i-lucide-trash-2"
                    class="cursor-default"
                    :loading="deletingVersionId === version.id"
                    :disabled="!canDeleteVersion(version)"
                    @click="deleteDraftVersion(version.id)">
                    {{ tLocal('delete') }}
                  </UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="selectedVersion" class="flex flex-wrap items-start justify-between gap-4">
      <div class="space-y-1">
        <div class="flex flex-wrap items-center gap-3">
          <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
            {{ tLocal('selectedAllocation') }} {{ selectedVersion.versionNumber }}
          </h3>
          <UBadge :color="getStatusColor(selectedVersion.status)" variant="subtle">
            {{ getStatusLabel(selectedVersion.status) }}
          </UBadge>
        </div>
        <p v-if="!canEditSelectedVersion" class="text-sm text-zinc-500 dark:text-zinc-400">
          {{ tLocal('readonly') }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <CommonSaveButton
          v-if="canEditSelectedVersion"
          :label="tLocal('save')"
          :loading="isSaving"
          :disabled="isSaving || isCompleting || isLoading"
          @click="save" />
        <UButton
          v-if="canEditSelectedVersion"
          icon="i-lucide-check"
          :label="tLocal('complete')"
          color="primary"
          class="cursor-default"
          :loading="isCompleting"
          :disabled="isSaving || isCompleting || isLoading"
          @click="completeSelectedVersion" />
      </div>
    </div>

    <div class="overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <UTable
        :data="allocationRows"
        :columns="allocationColumns"
        class="min-w-full">
        <template #commitmentLine-cell="{ row }">
          <div v-if="row.original.rowType === 'commitmentType'" class="flex w-full items-center gap-3 py-1">
            <button type="button" class="group flex min-w-0 items-center gap-3 text-left" @click="toggleGroup(row.original.id)">
              <UIcon :name="isExpanded(row.original.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-zinc-400 transition-colors group-hover:text-primary" />
              <span class="text-sm font-semibold text-zinc-900 dark:text-white">{{ row.original.commitmentTypeLabel }}</span>
              <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {{ row.original.associationCount }}
              </span>
            </button>
          </div>
          <div v-else-if="row.original.rowType === 'fiscalYear'" class="flex w-full items-center gap-3 py-1 pl-6">
            <button type="button" class="group flex min-w-0 items-center gap-3 text-left" @click="toggleGroup(row.original.id)">
              <UIcon :name="isExpanded(row.original.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-zinc-400 transition-colors group-hover:text-primary" />
              <span class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{{ row.original.yearLabel }}</span>
              <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {{ row.original.associationCount }}
              </span>
            </button>
          </div>
          <div v-else class="flex min-w-0 items-center gap-3 py-1 pl-12">
            <UIcon name="i-lucide-corner-down-right" class="size-4 shrink-0 text-zinc-400" />
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                {{ row.original.commitmentLineLabel }}
              </div>
              <div class="text-xs text-zinc-500 dark:text-zinc-400">
                {{ row.original.yearLabel }}
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

        <template #method-cell="{ row }">
          <div v-if="row.original.rowType === 'association' && row.original.association">
            <USelect
              :model-value="getAllocation(row.original.association).allocationMethod"
              value-key="value"
              :items="methodOptions"
              class="w-full min-w-36"
              :disabled="!canEditSelectedVersion"
              @update:model-value="updateAllocationMethod(row.original.association, $event)" />
          </div>
        </template>

        <template #value-cell="{ row }">
          <div v-if="row.original.rowType === 'association' && row.original.association">
            <UInput
              :model-value="getAllocation(row.original.association).allocationValue"
              type="number"
              min="0"
              step="0.01"
              class="w-full min-w-40"
              :disabled="!canEditSelectedVersion"
              @update:model-value="(value: string | number) => updateAllocationRowValue(row.original, value)" />
          </div>
        </template>

        <template #amount-cell="{ row }">
          <span class="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {{ formatMoney(getAmountForRow(row.original)) }}
          </span>
        </template>
      </UTable>
      <div class="border-t border-zinc-200 px-4 py-3 text-xs font-bold tracking-widest text-zinc-400 uppercase dark:border-zinc-800">
        {{ configuredAssociationRows.length }} {{ tLocal('records') }}
      </div>
    </div>
  </div>
</template>
