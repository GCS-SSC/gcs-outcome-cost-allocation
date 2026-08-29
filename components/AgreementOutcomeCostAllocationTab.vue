<script setup lang="ts">
import type { Ref } from 'vue'
import type {
  ExtensionEntityTabContext,
  GcsExtensionJsonConfig,
  GcsExtensionRbacRequirement
} from '@gcs-ssc/extensions'
import {
  ExtensionBadge,
  ExtensionButton,
  ExtensionFormField,
  ExtensionIcon,
  ExtensionInput,
  ExtensionModal,
  ExtensionSaveButton,
  ExtensionSelect,
  ExtensionSelectMenu,
  ExtensionTable,
  ExtensionWorkflowSection,
  useHostApi,
  useExtensionApi,
  useExtensionConfirmDialog,
  useExtensionI18n,
  useExtensionToast
} from '@gcs-ssc/extensions/ui'
import {
  EXACT_NUMERIC_19_4_MAX,
  type AllocationMethod,
  type AllocationVersionStatus,
  type CommitmentType,
  type CostAllocationVersion,
  type VersionedOutcomeAllocationInput,
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
  toMoney,
  validateAllocationTotals
} from '../shared/allocation'
import {
  buildOutcomeAllocationRows,
  deleteOutcomeAllocationDraftVersionRequest,
  type AllocationTableRow,
  type ConfiguredAssociationRow,
  getOutcomeAllocationVersionEndpoint,
  getOutcomeAllocationVersionsEndpoint,
  getOutcomeAllocationToastText,
  resolveCreatedDraftVersionId,
  resolveDeletedDraftVersionId,
  resolveSelectedOutcomeAllocationVersionId,
  saveOutcomeAllocationsRequest
} from '../shared/agreement-outcome-cost-allocation-tab'

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
    label_en?: string
    label_fr?: string
    gl?: number
    gl_description?: string
  }>
  commitmentTypes: Array<{ id: string, label_en: string, label_fr: string }>
}

type AllocationOutcome = AllocationResponse['outcomes'][number]
type AllocationBudgetYear = AllocationResponse['budgetYears'][number]
type AllocationStreamCommitment = AllocationResponse['streamCommitments'][number]

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

const { locale } = useExtensionI18n()
const toast = useExtensionToast()
const allocations: Ref<VersionedOutcomeAllocationInput[]> = ref([])
const selectedVersionId: Ref<string> = ref('')
const isSaving: Ref<boolean> = ref(false)
const isCompleting: Ref<boolean> = ref(false)
const isCreatingDraft: Ref<boolean> = ref(false)
const deletingVersionId: Ref<string> = ref('')
const workflowRefreshKey: Ref<number> = ref(0)
const saveError: Ref<string> = ref('')
const expandedRows: Ref<Record<string, boolean>> = ref({})
const isGenerateModalOpen: Ref<boolean> = ref(false)
const generationCommitmentType: Ref<CommitmentType> = ref('')
const generationYearIds: Ref<string[]> = ref([])
const confirm = useExtensionConfirmDialog()
const api = useExtensionApi(extensionKey)
const hostApi = useHostApi()

const endpoint = computed(() => `/agreements/${context.agreementId}/allocations`)
const data: Ref<AllocationResponse | null> = ref(null)
const selectedVersionHasCompletion: Ref<boolean> = ref(false)
const status: Ref<'idle' | 'pending' | 'success' | 'error'> = ref('idle')
const refresh = async () => {
  try {
    status.value = 'pending'
    data.value = await api.get<AllocationResponse>(endpoint.value)
    status.value = 'success'
  } catch {
    data.value = null
    status.value = 'error'
  }
}
await refresh()

const syncAllocationResponse = (value: AllocationResponse | null) => {
  allocations.value = value?.allocations.map((allocation: VersionedOutcomeAllocationInput) => ({ ...allocation })) ?? []
  const versions = value?.versions ?? []
  selectedVersionId.value = resolveSelectedOutcomeAllocationVersionId(selectedVersionId.value, versions)
}

watch(() => data.value, value => {
  syncAllocationResponse(value)
}, { immediate: true })

const outcomes = computed<AllocationOutcome[]>(() => data.value?.outcomes ?? [])
const budgetYears = computed<AllocationBudgetYear[]>(() => data.value?.budgetYears ?? [])
const streamCommitments = computed<AllocationStreamCommitment[]>(() => data.value?.streamCommitments ?? [])
const versions = computed<CostAllocationVersion[]>(() => data.value?.versions ?? [])
const selectedVersion = computed<CostAllocationVersion | null>(() => versions.value.find((version: CostAllocationVersion) => version.id === selectedVersionId.value) ?? null)
const canEditSelectedVersion = computed(() => selectedVersion.value?.status === 'draft' && !selectedVersionHasCompletion.value)
const hasDraftVersion = computed(() => versions.value.some((version: CostAllocationVersion) => version.status === 'draft'))
const isLoading = computed(() => status.value === 'pending')
const streamConfig = computed(() => parseOutcomeCostAllocationConfig(config))

const refreshSelectedCompletion = async () => {
  const requestedVersionId = selectedVersionId.value
  if (!requestedVersionId) {
    selectedVersionHasCompletion.value = false
    return
  }
  selectedVersionHasCompletion.value = true
  try {
    const query = new URLSearchParams({
      entityType: 'gcs-outcome-cost-allocation:allocation-version',
      entityId: requestedVersionId
    })
    const response = await hostApi.get<{ item: unknown | null }>(`/api/completions/runtime?${query.toString()}`)
    if (requestedVersionId !== selectedVersionId.value) return
    selectedVersionHasCompletion.value = response.item != null
  } catch {
    if (requestedVersionId !== selectedVersionId.value) return
    selectedVersionHasCompletion.value = true
  }
}

watch(selectedVersionId, refreshSelectedCompletion, { immediate: true })

const methodOptions = computed(() => [
  { label: locale.value === 'fr' ? 'Montant' : 'Amount', value: 'amount' },
  { label: locale.value === 'fr' ? 'Pourcentage' : 'Percentage', value: 'percentage' }
])

const commitmentTypeOptions = computed(() => streamConfig.value.enabledCommitmentTypes.map(commitmentType => ({
  label: getCommitmentTypeLabel(commitmentType),
  value: commitmentType
})))

const fundedBudgetYears = computed(() => budgetYears.value.filter((year: AllocationBudgetYear) => Number(year.program_funding) > 0))

const generationYearOptions = computed(() => fundedBudgetYears.value.map((year: AllocationBudgetYear) => ({
  label: year.fiscal_year_display,
  value: String(year.id)
})))

const getOutcomeLabel = (outcome: AllocationOutcome) => locale.value === 'fr'
  ? outcome.label_fr
  : outcome.label_en

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
  },
  {
    id: 'unallocated',
    header: tLocal('unallocated')
  },
  {
    id: 'allocationActions',
    header: tLocal('actions')
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

const getCommitmentTypeLabel = (commitmentType: CommitmentType) => {
  const type = data.value?.commitmentTypes?.find(item => String(item.id) === commitmentType)
  return type ? (locale.value === 'fr' ? type.label_fr : type.label_en) : commitmentType
}

const getOutcomeName = (outcomeId: string) => {
  const outcome = outcomes.value.find((item: AllocationOutcome) => String(item.id) === outcomeId)
  return outcome ? getOutcomeLabel(outcome) : outcomeId
}

const getCommitmentLineLabel = (streamCommitmentId: string) => {
  const commitment = streamCommitments.value.find((item: AllocationStreamCommitment) => String(item.id) === streamCommitmentId)
  if (!commitment) return streamCommitmentId
  const localizedLabel = locale.value === 'fr' ? commitment.label_fr : commitment.label_en
  return localizedLabel || (commitment.gl_description ? `GL ${commitment.gl ?? ''} - ${commitment.gl_description}` : streamCommitmentId)
}

const getYearForStreamBudget = (streamBudgetId: string) =>
  budgetYears.value.find((year: AllocationBudgetYear) => String(year.stream_budget_id ?? '') === streamBudgetId) ?? null

const configuredAssociationRows = computed<ConfiguredAssociationRow[]>(() => streamConfig.value.mappings.flatMap(mapping => {
  const year = getYearForStreamBudget(mapping.streamBudgetId)
  const hasOutcome = outcomes.value.some((outcome: AllocationOutcome) => String(outcome.id) === mapping.outcomeId)
  const streamCommitment = streamCommitments.value.find(commitment =>
    String(commitment.id) === mapping.streamCommitmentId
  )
  if (
    !streamConfig.value.enabledCommitmentTypes.includes(mapping.commitmentType)
    || !year
    || Number(year.program_funding) <= 0
    || !hasOutcome
    || !streamCommitment
    || String(streamCommitment.stream_budget_id) !== mapping.streamBudgetId
  ) {
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
  const typeCompare = getCommitmentTypeLabel(a.commitmentType).localeCompare(getCommitmentTypeLabel(b.commitmentType))
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

const getAllocationKey = (allocation: {
  commitmentType?: CommitmentType
  streamCommitmentId: string
  agreementBudgetFiscalYearId: string
  outcomeId: string
}) => [
  allocation.commitmentType ?? '',
  allocation.agreementBudgetFiscalYearId,
  allocation.streamCommitmentId,
  allocation.outcomeId
].join(':')

const getAssociationKey = (association: ConfiguredAssociationRow) => getAllocationKey({
  commitmentType: association.commitmentType,
  streamCommitmentId: association.streamCommitmentId,
  agreementBudgetFiscalYearId: association.yearId,
  outcomeId: association.outcomeId
})

const configuredAssociationByKey = computed(() => new Map(configuredAssociationRows.value.map((association: ConfiguredAssociationRow) => [
  getAssociationKey(association),
  association
])))

const selectedVersionAllocations = computed<VersionedOutcomeAllocationInput[]>(() => allocations.value.filter((allocation: VersionedOutcomeAllocationInput) =>
  allocation.allocationVersionId === selectedVersionId.value
))

/**
 * Builds a display row from immutable saved coordinates when current configuration no longer contains them.
 */
const createHistoricalAssociationRow = (
  allocation: VersionedOutcomeAllocationInput
): ConfiguredAssociationRow => {
  const year = budgetYears.value.find(candidate =>
    String(candidate.id) === allocation.agreementBudgetFiscalYearId
  )
  const useSnapshot = selectedVersion.value?.status === 'active'
    || selectedVersion.value?.status === 'inactive'
  const outcomeLabel = useSnapshot
    ? locale.value === 'fr'
      ? allocation.outcomeLabelFr
      : allocation.outcomeLabelEn
    : null
  const commitmentLabel = useSnapshot
    ? locale.value === 'fr'
      ? allocation.commitmentLabelFr
      : allocation.commitmentLabelEn
    : null

  return {
    id: `historical:${allocation.allocationVersionId}:${getAllocationKey(allocation)}`,
    commitmentType: allocation.commitmentType ?? '',
    commitmentTypeLabel: getCommitmentTypeLabel(allocation.commitmentType ?? ''),
    yearId: allocation.agreementBudgetFiscalYearId,
    yearLabel: useSnapshot && allocation.fiscalYearDisplay
      ? allocation.fiscalYearDisplay
      : year
        ? year.fiscal_year_display
        : allocation.agreementBudgetFiscalYearId,
    programFunding: useSnapshot && allocation.fundingBasisAmount !== null
      && allocation.fundingBasisAmount !== undefined
      ? allocation.fundingBasisAmount
      : year
        ? Number(year.program_funding)
        : 0,
    streamBudgetId: year && year.stream_budget_id ? String(year.stream_budget_id) : '',
    streamCommitmentId: allocation.streamCommitmentId,
    commitmentLineLabel: commitmentLabel || getCommitmentLineLabel(allocation.streamCommitmentId),
    outcomeId: allocation.outcomeId,
    outcomeLabel: outcomeLabel || getOutcomeName(allocation.outcomeId)
  }
}

const displayedAssociationRows = computed<ConfiguredAssociationRow[]>(() => selectedVersionAllocations.value.map((allocation: VersionedOutcomeAllocationInput) => {
  const association = configuredAssociationByKey.value.get(getAllocationKey(allocation))
  if (selectedVersion.value?.status === 'draft' && association) {
    return association
  }

  return createHistoricalAssociationRow(allocation)
}))

const isExpanded = (groupId: string) => expandedRows.value[groupId] !== false
const toggleGroup = (groupId: string) => {
  expandedRows.value = {
    ...expandedRows.value,
    [groupId]: !isExpanded(groupId)
  }
}

const allocationRows = computed<AllocationTableRow[]>(() => buildOutcomeAllocationRows(displayedAssociationRows.value, {
  isExpanded,
  recordsLabel: tLocal('records')
}))

const getAllocation = (association: ConfiguredAssociationRow): VersionedOutcomeAllocationInput | null => allocations.value.find(allocation =>
  allocation.allocationVersionId === selectedVersionId.value
  && (allocation.commitmentType ?? '') === (association.commitmentType ?? '')
  && allocation.streamCommitmentId === association.streamCommitmentId
  && allocation.agreementBudgetFiscalYearId === association.yearId
  && allocation.outcomeId === association.outcomeId
) ?? null

const createAllocation = (association: ConfiguredAssociationRow): VersionedOutcomeAllocationInput => ({
  allocationVersionId: selectedVersionId.value,
  commitmentType: association.commitmentType,
  streamCommitmentId: association.streamCommitmentId,
  agreementBudgetFiscalYearId: association.yearId,
  outcomeId: association.outcomeId,
  allocationMethod: 'amount',
  allocationValue: 0
})

const ensureAllocation = (association: ConfiguredAssociationRow) => {
  const existing = getAllocation(association)
  if (existing) {
    return existing
  }

  const created = createAllocation(association)
  allocations.value = [...allocations.value, created]
  return created
}

const setAllocationMethod = (association: ConfiguredAssociationRow, allocationMethod: AllocationMethod) => {
  const allocation = ensureAllocation(association)
  if (allocation.allocationMethod === allocationMethod) {
    return
  }
  const resolvedAmount = getAllocationAmount(association)
  allocation.allocationMethod = allocationMethod
  const convertedValue = allocationMethod === 'percentage'
    ? association.programFunding > 0
      ? resolvedAmount / association.programFunding * 100
      : 0
    : resolvedAmount
  allocation.allocationValue = Math.min(convertedValue, getAllocationValueMaximum(association))
}

const setAllocationValue = (association: ConfiguredAssociationRow, value: string | number) => {
  const allocation = ensureAllocation(association)
  allocation.allocationValue = Math.min(Math.max(Number(value || 0), 0), getAllocationValueMaximum(association))
}

const updateAllocationMethod = (association: ConfiguredAssociationRow, value: string | number) => {
  if (value !== 'amount' && value !== 'percentage') {
    return
  }

  setAllocationMethod(association, value)
}

const updateAllocationRowValue = (row: AllocationTableRow, value: string | number) => {
  if (!row.association) {
    return
  }

  setAllocationValue(row.association, value)
}

const isHistoricalAssociation = (association: ConfiguredAssociationRow) =>
  !configuredAssociationByKey.value.has(getAssociationKey(association))

/**
 * Removes one stale draft allocation locally so config drift can be repaired before saving.
 */
const removeHistoricalDraftAllocation = (association: ConfiguredAssociationRow) => {
  if (
    !canEditSelectedVersion.value
    || hasPendingDraftMutation.value
    || !isHistoricalAssociation(association)
  ) {
    return
  }

  const allocationKey = getAssociationKey(association)
  allocations.value = allocations.value.filter(allocation =>
    allocation.allocationVersionId !== selectedVersionId.value
    || getAllocationKey(allocation) !== allocationKey
  )
}

const updateGenerationYearIds = (value: unknown) => {
  generationYearIds.value = Array.isArray(value)
    ? value.map(item => String(item))
    : []
}

const activeAllocations = computed<VersionedOutcomeAllocationInput[]>(() => selectedVersionAllocations.value)

const allocationYearTotals = computed(() => budgetYears.value.map((year: AllocationBudgetYear) => ({
  agreementBudgetFiscalYearId: String(year.id),
  programFunding: Number(year.program_funding)
})))

const selectedDraftResolvedAmountByKey = computed(() => {
  if (selectedVersion.value?.status !== 'draft') {
    return new Map<string, number>()
  }

  return new Map(resolveAllocationAmounts(
    activeAllocations.value,
    allocationYearTotals.value
  ).map(allocation => [
    getAllocationKey(allocation),
    allocation.amount
  ]))
})

const getProgramFunding = (yearId: string) =>
  Number(budgetYears.value.find((year: AllocationBudgetYear) => String(year.id) === yearId)?.program_funding ?? 0)

const getAllocationInputAmount = (allocation: VersionedOutcomeAllocationInput) =>
  allocation.resolvedAmount !== null && allocation.resolvedAmount !== undefined
    ? toMoney(allocation.resolvedAmount)
    : allocation.allocationVersionId === selectedVersionId.value
      && selectedVersion.value?.status === 'draft'
      ? selectedDraftResolvedAmountByKey.value.get(getAllocationKey(allocation)) ?? 0
      : allocation.allocationMethod === 'percentage'
        ? toMoney(getProgramFunding(allocation.agreementBudgetFiscalYearId) * allocation.allocationValue / 100)
        : toMoney(allocation.allocationValue)

const getAllocationAmount = (association: ConfiguredAssociationRow) => {
  const allocation = getAllocation(association)
  return allocation ? getAllocationInputAmount(allocation) : 0
}

const getVersionAllocations = (versionId: string) => allocations.value.filter((allocation: VersionedOutcomeAllocationInput) =>
  allocation.allocationVersionId === versionId
)

const getVersionTotal = (versionId: string) => getVersionAllocations(versionId)
  .reduce((sum: number, allocation: VersionedOutcomeAllocationInput) => toMoney(sum + getAllocationInputAmount(allocation)), 0)

const getVersionProgramFundingTotal = (versionId: string) => {
  const version = versions.value.find(candidate => candidate.id === versionId)
  if (version?.fundingBasisAmount !== null && version?.fundingBasisAmount !== undefined) {
    return version.fundingBasisAmount
  }

  return budgetYears.value.reduce(
    (sum, year) => toMoney(sum + Number(year.program_funding)),
    0
  )
}

const getVersionUnallocated = (versionId: string) =>
  toMoney(getVersionProgramFundingTotal(versionId) - getVersionTotal(versionId))

const selectVersion = (versionId: string) => {
  selectedVersionId.value = versionId
}

const validationIssues = computed(() => validateAllocationTotals(
  activeAllocations.value,
  allocationYearTotals.value,
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
    GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID: {
      en: 'Each fiscal year must be fully allocated to its own budget value.',
      fr: 'Chaque exercice doit etre entierement reparti selon sa propre valeur budgetaire.'
    },
    GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED: {
      en: 'An allocation cannot exceed its fiscal-year budget value.',
      fr: 'Une repartition ne peut pas depasser la valeur budgetaire de son exercice.'
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
  getGroupAmountTotal(displayedAssociationRows.value.filter((row: ConfiguredAssociationRow) => row.commitmentType === commitmentType))

const getFiscalYearAmountTotal = (commitmentType: CommitmentType, yearId: string) =>
  getGroupAmountTotal(displayedAssociationRows.value.filter((row: ConfiguredAssociationRow) =>
    row.commitmentType === commitmentType && row.yearId === yearId
  ))

const getFiscalYearAllocatedTotal = (yearId: string) => getGroupAmountTotal(
  displayedAssociationRows.value.filter((row: ConfiguredAssociationRow) => row.yearId === yearId)
)

const getFiscalYearUnallocated = (yearId: string) =>
  toMoney(getProgramFunding(yearId) - getFiscalYearAllocatedTotal(yearId))

const getAllocationValueMaximum = (association: ConfiguredAssociationRow) => {
  const allocation = getAllocation(association) ?? createAllocation(association)
  const currentAmount = getAllocationAmount(association)
  const remainingIncludingCurrent = Math.max(0, toMoney(getFiscalYearUnallocated(association.yearId) + currentAmount))
  if (allocation.allocationMethod === 'percentage') {
    const funding = getProgramFunding(association.yearId)
    return funding > 0 ? Math.min(100, remainingIncludingCurrent / funding * 100) : 0
  }
  return Math.min(EXACT_NUMERIC_19_4_MAX, remainingIncludingCurrent)
}

const getAmountForRow = (row: AllocationTableRow) => {
  if (row.rowType === 'commitmentType' && row.commitmentType) {
    return getCommitmentTypeAmountTotal(row.commitmentType)
  }

  if (row.rowType === 'fiscalYear' && row.commitmentType) {
    return getFiscalYearAmountTotal(row.commitmentType, row.yearId)
  }

  return row.association ? getAllocationAmount(row.association) : 0
}

const getUnallocatedForRow = (row: AllocationTableRow): number | null => {
  if (row.rowType === 'commitmentType') {
    return getVersionUnallocated(selectedVersionId.value)
  }

  if (row.rowType === 'fiscalYear') {
    return getFiscalYearUnallocated(row.yearId)
  }

  return null
}

const isOverAllocated = (value: number | null) => value !== null && value < -0.01

const getUnallocatedClass = (value: number | null) => [
  'text-sm font-medium',
  isOverAllocated(value) ? 'text-error' : 'text-zinc-700 dark:text-zinc-200'
]

const getGenerationCandidates = () => {
  const selectedYearIds = new Set(generationYearIds.value)
  return configuredAssociationRows.value.filter((association: ConfiguredAssociationRow) =>
    association.commitmentType === generationCommitmentType.value
    && selectedYearIds.has(association.yearId)
  )
}

const openGenerateRows = () => {
  if (!canEditSelectedVersion.value || hasPendingDraftMutation.value) {
    return
  }

  generationCommitmentType.value = streamConfig.value.enabledCommitmentTypes[0] ?? ''
  generationYearIds.value = fundedBudgetYears.value.map((year: AllocationBudgetYear) => String(year.id))
  isGenerateModalOpen.value = true
}

/**
 * Reconciles generated rows for the selected type and years, confirming before removing stale allocations.
 */
const applyGeneratedRows = async () => {
  if (!canEditSelectedVersion.value || hasPendingDraftMutation.value) {
    return
  }

  const candidates = getGenerationCandidates()
  const candidateKeys = new Set(candidates.map(getAssociationKey))
  const existingKeys = new Set(selectedVersionAllocations.value.map(getAllocationKey))
  const additions = candidates
    .filter((association: ConfiguredAssociationRow) => !existingKeys.has(getAssociationKey(association)))
    .map(createAllocation)
  const selectedYearIds = new Set(generationYearIds.value)
  const deletions = selectedVersionAllocations.value.filter((allocation: VersionedOutcomeAllocationInput) =>
    allocation.commitmentType === generationCommitmentType.value
    && selectedYearIds.has(allocation.agreementBudgetFiscalYearId)
    && !candidateKeys.has(getAllocationKey(allocation))
  )

  if (deletions.length > 0) {
    const confirmed = await confirm({
      title: tLocal('removeRowsTitle'),
      description: tLocal('removeRowsDescription'),
      confirmLabel: tLocal('generateRows'),
      confirmColor: 'warning'
    })
    if (!confirmed) {
      return
    }
  }

  const deletionKeys = new Set(deletions.map(getAllocationKey))
  allocations.value = [
    ...allocations.value.filter((allocation: VersionedOutcomeAllocationInput) =>
      allocation.allocationVersionId !== selectedVersionId.value || !deletionKeys.has(getAllocationKey(allocation))
    ),
    ...additions
  ]
  isGenerateModalOpen.value = false
}

/**
 * Persists the editable version, refreshes server state, and reports success without throwing UI errors.
 */
const save = async () => {
  if (hasPendingDraftMutation.value || !canEditSelectedVersion.value || !selectedVersionId.value) {
    return false
  }

  try {
    isSaving.value = true
    saveError.value = ''
    await saveOutcomeAllocationsRequest(
      api.path(endpoint.value),
      selectedVersionId.value,
      activeAllocations.value
    )
    await refresh()
    toast.add({ ...getOutcomeAllocationToastText(locale.value, 'saved'), color: 'success' })
    return true
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    isSaving.value = false
  }
}

const completeSelectedVersion = async () => {
  if (isCompleting.value || hasPendingDraftMutation.value || !canEditSelectedVersion.value || !selectedVersionId.value) return
  if (validationIssues.value.length > 0) {
    toast.add({ title: getOutcomeAllocationToastText(locale.value, 'error').title, description: validationMessage.value, color: 'error' })
    return
  }
  try {
    isCompleting.value = true
    saveError.value = ''
    await saveOutcomeAllocationsRequest(api.path(endpoint.value), selectedVersionId.value, activeAllocations.value)
    await hostApi.post('/api/completions/complete', {
      entityType: 'gcs-outcome-cost-allocation:allocation-version',
      entityId: selectedVersionId.value,
      comments: null
    })
    selectedVersionHasCompletion.value = true
    await refresh()
    workflowRefreshKey.value += 1
    toast.add({ ...getOutcomeAllocationToastText(locale.value, 'submitted'), color: 'success' })
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
    toast.add({ title: getOutcomeAllocationToastText(locale.value, 'error').title, description: saveError.value, color: 'error' })
  } finally {
    isCompleting.value = false
  }
}

const handleWorkflowChanged = async () => {
  await Promise.all([
    refresh(),
    refreshSelectedCompletion()
  ])
}

const createDraftVersion = async () => {
  if (isCreatingDraft.value) {
    return
  }

  try {
    isCreatingDraft.value = true
    saveError.value = ''
    const response = await api.post<{ version?: CostAllocationVersion }>(getOutcomeAllocationVersionsEndpoint(endpoint.value))
    await refresh()
    selectedVersionId.value = resolveCreatedDraftVersionId(selectedVersionId.value, response)
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isCreatingDraft.value = false
  }
}

/**
 * Deletes one draft version, clears it when selected, refreshes data, and surfaces failures in save state.
 */
const deleteDraftVersion = async (versionId: string) => {
  if (hasPendingDraftMutation.value) {
    return
  }

  try {
    deletingVersionId.value = versionId
    saveError.value = ''
    await deleteOutcomeAllocationDraftVersionRequest(
      api.path(getOutcomeAllocationVersionEndpoint(endpoint.value, versionId))
    )
    selectedVersionId.value = resolveDeletedDraftVersionId(selectedVersionId.value, versionId)
    await refresh()
    toast.add({ ...getOutcomeAllocationToastText(locale.value, 'deleted'), color: 'success' })
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    deletingVersionId.value = ''
  }
}

const hasPendingDraftMutation = computed(() =>
  isSaving.value
  || isCompleting.value
  || isCreatingDraft.value
  || Boolean(deletingVersionId.value)
)

const canDeleteVersion = (version: CostAllocationVersion) =>
  version.status === 'draft'
  && !hasPendingDraftMutation.value

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
  unallocated: {
    en: 'Unallocated',
    fr: 'Non reparti'
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
  generateRows: {
    en: 'Generate rows',
    fr: 'Generer les lignes'
  },
  generateRowsTitle: {
    en: 'Generate allocation rows',
    fr: 'Generer des lignes de repartition'
  },
  commitmentType: {
    en: 'Commitment type',
    fr: 'Type d engagement'
  },
  fiscalYears: {
    en: 'Fiscal years',
    fr: 'Exercices'
  },
  removeRowsTitle: {
    en: 'Remove stale allocation rows?',
    fr: 'Supprimer les lignes de repartition obsoletes?'
  },
  removeRowsDescription: {
    en: 'Generating will remove rows that no longer match the selected commitment type, fiscal years, and agreement outcomes.',
    fr: 'La generation supprimera les lignes qui ne correspondent plus au type d engagement, aux exercices et aux resultats de l entente selectionnes.'
  },
  removeAllocation: {
    en: 'Remove allocation',
    fr: 'Retirer la repartition'
  },
  noRows: {
    en: 'No allocation rows have been added to this draft.',
    fr: 'Aucune ligne de repartition n a ete ajoutee a ce brouillon.'
  },
  newDraft: {
    en: 'New draft',
    fr: 'Nouveau brouillon'
  },
  complete: {
    en: 'Submit for approval',
    fr: 'Soumettre pour approbation'
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
  },
  workflows: {
    en: 'Workflows',
    fr: 'Flux de travail'
  },
  workflowsDescription: {
    en: 'Start and complete a standard workflow for the selected allocation version.',
    fr: 'Demarrez et terminez un flux de travail standard pour la version de repartition selectionnee.'
  }
}

const tLocal = (key: keyof typeof text) => locale.value === 'fr' ? text[key].fr : text[key].en
</script>

<template>
  <div class="w-full min-w-0 max-w-full space-y-6 overflow-hidden">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold text-zinc-900 dark:text-white">
        {{ tLocal('title') }}
      </h2>
      <ExtensionButton
        icon="i-lucide-plus"
        :label="tLocal('newDraft')"
        color="primary"
        class="cursor-default"
        :loading="isCreatingDraft"
        :disabled="isCreatingDraft || isLoading || hasDraftVersion"
        @click="createDraftVersion" />
    </div>

    <p
      v-if="displayedAssociationRows.length === 0 && (outcomes.length === 0 || budgetYears.length === 0 || configuredAssociationRows.length === 0)"
      class="text-sm text-zinc-500">
      {{ tLocal('empty') }}
    </p>

    <p v-if="saveError" class="text-sm text-error">
      {{ saveError }}
    </p>

    <div class="space-y-3">
      <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
        {{ tLocal('allocationVersions') }}
      </h3>
      <div class="w-full min-w-0 overflow-x-auto rounded-sm border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table class="w-full min-w-0 table-fixed divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <caption class="sr-only">
            {{ tLocal('allocationVersions') }}
          </caption>
          <thead>
            <tr class="bg-zinc-100 text-left text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:bg-zinc-900 dark:text-zinc-400">
              <th scope="col" class="w-[28%] px-4 py-4">
                {{ tLocal('version') }}
              </th>
              <th scope="col" class="w-[18%] px-4 py-4">
                {{ tLocal('status') }}
              </th>
              <th scope="col" class="w-[20%] px-4 py-4">
                {{ tLocal('amount') }}
              </th>
              <th scope="col" class="w-[20%] px-4 py-4">
                {{ tLocal('unallocated') }}
              </th>
              <th scope="col" class="w-[14%] px-4 py-4 text-right">
                {{ tLocal('actions') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(version, versionIndex) in versions"
              :key="version.id"
              :aria-current="version.id === selectedVersionId ? 'true' : undefined"
              :aria-disabled="hasPendingDraftMutation ? 'true' : undefined"
              :tabindex="hasPendingDraftMutation ? -1 : 0"
              role="button"
              :class="[
                versionIndex > 0 && version.id !== selectedVersionId && versions[versionIndex - 1]?.id !== selectedVersionId ? 'border-t border-zinc-200 dark:border-zinc-800' : '',
                version.id === selectedVersionId ? 'border-l-4 border-primary bg-blue-50/60 dark:bg-blue-950/20' : 'border-l-4 border-transparent',
                'cursor-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary hover:bg-zinc-50 dark:hover:bg-zinc-900/60'
              ]"
              @click="!hasPendingDraftMutation && selectVersion(version.id)"
              @keydown.enter.prevent="!hasPendingDraftMutation && selectVersion(version.id)"
              @keydown.space.prevent="!hasPendingDraftMutation && selectVersion(version.id)">
              <th scope="row" class="px-4 py-4 text-left">
                <div class="flex min-w-0 items-center gap-3">
                  <ExtensionIcon
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
                <ExtensionBadge :color="getStatusColor(version.status)" variant="subtle">
                  {{ getStatusLabel(version.status) }}
                </ExtensionBadge>
              </td>
              <td class="px-4 py-4 font-semibold">
                <span>
                  {{ formatMoney(getVersionTotal(version.id)) }}
                </span>
              </td>
              <td class="px-4 py-4 font-semibold">
                <span :class="getUnallocatedClass(getVersionUnallocated(version.id))">
                  {{ formatMoney(getVersionUnallocated(version.id)) }}
                </span>
              </td>
              <td class="px-4 py-4">
                <div class="flex justify-end gap-2" @click.stop>
                  <ExtensionButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    class="cursor-default"
                    :icon="version.id === selectedVersionId ? 'i-lucide-check' : 'i-lucide-panel-top-open'"
                    :disabled="version.id === selectedVersionId || hasPendingDraftMutation"
                    @click="selectVersion(version.id)">
                    {{ version.id === selectedVersionId ? tLocal('selected') : tLocal('view') }}
                  </ExtensionButton>
                  <ExtensionButton
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
                  </ExtensionButton>
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
          <ExtensionBadge :color="getStatusColor(selectedVersion.status)" variant="subtle">
            {{ getStatusLabel(selectedVersion.status) }}
          </ExtensionBadge>
        </div>
        <p v-if="!canEditSelectedVersion" class="text-sm text-zinc-500 dark:text-zinc-400">
          {{ tLocal('readonly') }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <ExtensionButton
          v-if="canEditSelectedVersion"
          icon="i-lucide-plus"
          :label="tLocal('generateRows')"
          color="neutral"
          variant="outline"
          class="cursor-default"
          :disabled="hasPendingDraftMutation || isLoading"
          @click="openGenerateRows" />
        <ExtensionSaveButton
          v-if="canEditSelectedVersion"
          :label="tLocal('save')"
          :loading="isSaving"
          :disabled="hasPendingDraftMutation || isLoading"
          @click="save" />
        <ExtensionButton
          v-if="canEditSelectedVersion"
          icon="i-lucide-check"
          :label="tLocal('complete')"
          color="primary"
          class="cursor-default"
          :loading="isCompleting"
          :disabled="hasPendingDraftMutation || isLoading"
          @click="completeSelectedVersion" />
      </div>
    </div>

    <div class="outcome-cost-allocation-table w-full min-w-0 max-w-full overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div class="w-full min-w-0 overflow-hidden">
        <ExtensionTable
          :data="allocationRows"
          :columns="allocationColumns"
          class="w-full max-w-full table-fixed">
          <template #commitmentLine-cell="{ row }">
            <div v-if="row.original.rowType === 'commitmentType'" class="flex w-full items-center gap-3 py-1">
              <button type="button" class="group flex min-w-0 items-center gap-3 text-left" @click="toggleGroup(row.original.id)">
                <ExtensionIcon :name="isExpanded(row.original.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-zinc-400 transition-colors group-hover:text-primary" />
                <span class="text-sm font-semibold text-zinc-900 dark:text-white">{{ row.original.commitmentTypeLabel }}</span>
                <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {{ row.original.associationCount }}
                </span>
              </button>
            </div>
            <div v-else-if="row.original.rowType === 'fiscalYear'" class="flex w-full items-center gap-3 py-1 pl-6">
              <button type="button" class="group flex min-w-0 items-center gap-3 text-left" @click="toggleGroup(row.original.id)">
                <ExtensionIcon :name="isExpanded(row.original.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-zinc-400 transition-colors group-hover:text-primary" />
                <span class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{{ row.original.yearLabel }}</span>
                <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {{ row.original.associationCount }}
                </span>
              </button>
            </div>
            <div v-else class="flex min-w-0 items-center gap-3 py-1 pl-12">
              <ExtensionIcon name="i-lucide-corner-down-right" class="size-4 shrink-0 text-zinc-400" />
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
              <ExtensionSelect
                :model-value="getAllocation(row.original.association)?.allocationMethod ?? 'amount'"
                value-key="value"
                :items="methodOptions"
                class="w-full min-w-0"
                :disabled="!canEditSelectedVersion || hasPendingDraftMutation"
                @update:model-value="updateAllocationMethod(row.original.association, $event)" />
            </div>
          </template>

          <template #value-cell="{ row }">
            <div v-if="row.original.rowType === 'association' && row.original.association">
              <ExtensionInput
                :model-value="getAllocation(row.original.association)?.allocationValue ?? 0"
                type="number"
                min="0"
                :max="getAllocationValueMaximum(row.original.association)"
                step="0.01"
                class="w-full min-w-0"
                :disabled="!canEditSelectedVersion || hasPendingDraftMutation"
                @update:model-value="(value: string | number) => updateAllocationRowValue(row.original, value)" />
            </div>
          </template>

          <template #amount-cell="{ row }">
            <span class="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {{ formatMoney(getAmountForRow(row.original)) }}
            </span>
          </template>

          <template #unallocated-cell="{ row }">
            <span
              v-if="getUnallocatedForRow(row.original) !== null"
              :class="getUnallocatedClass(getUnallocatedForRow(row.original))">
              {{ formatMoney(getUnallocatedForRow(row.original) ?? 0) }}
            </span>
          </template>

          <template #allocationActions-cell="{ row }">
            <ExtensionButton
              v-if="canEditSelectedVersion && row.original.association && isHistoricalAssociation(row.original.association)"
              color="error"
              variant="ghost"
              size="sm"
              icon="i-lucide-trash-2"
              class="cursor-default"
              :label="tLocal('removeAllocation')"
              :disabled="hasPendingDraftMutation"
              @click="removeHistoricalDraftAllocation(row.original.association)" />
          </template>
        </ExtensionTable>
      </div>
      <div class="border-t border-zinc-200 px-4 py-3 text-xs font-bold tracking-widest text-zinc-400 uppercase dark:border-zinc-800">
        <span v-if="displayedAssociationRows.length > 0">
          {{ displayedAssociationRows.length }} {{ tLocal('records') }}
        </span>
        <span v-else>
          {{ tLocal('noRows') }}
        </span>
      </div>
    </div>

    <div v-if="selectedVersion" class="min-w-0 space-y-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <div class="space-y-1">
        <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
          {{ tLocal('workflows') }}
        </h3>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          {{ tLocal('workflowsDescription') }}
        </p>
      </div>
      <ExtensionWorkflowSection
        :key="selectedVersion.id"
        entity-type="gcs-outcome-cost-allocation:allocation-version"
        :entity-id="selectedVersion.id"
        :can-edit="!hasPendingDraftMutation"
        :refresh-key="workflowRefreshKey"
        @changed="handleWorkflowChanged" />
    </div>

    <ExtensionModal v-model:open="isGenerateModalOpen" :title="tLocal('generateRowsTitle')">
      <template #body>
        <div class="space-y-4">
          <ExtensionFormField :label="tLocal('commitmentType')">
            <ExtensionSelect
              v-model="generationCommitmentType"
              value-key="value"
              :items="commitmentTypeOptions"
              :disabled="hasPendingDraftMutation"
              class="w-full" />
          </ExtensionFormField>

          <ExtensionFormField :label="tLocal('fiscalYears')">
            <ExtensionSelectMenu
              :model-value="generationYearIds"
              multiple
              value-key="value"
              label-key="label"
              :items="generationYearOptions"
              :disabled="hasPendingDraftMutation"
              class="w-full"
              @update:model-value="updateGenerationYearIds" />
          </ExtensionFormField>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <ExtensionButton
            :label="locale === 'fr' ? 'Annuler' : 'Cancel'"
            color="neutral"
            variant="ghost"
            class="cursor-default"
            @click="isGenerateModalOpen = false" />
          <ExtensionButton
            :label="tLocal('generateRows')"
            color="primary"
            class="cursor-default"
            :disabled="hasPendingDraftMutation || generationYearIds.length === 0"
            @click="applyGeneratedRows" />
        </div>
      </template>
    </ExtensionModal>
  </div>
</template>

<style scoped>
:deep(.outcome-cost-allocation-table table) {
  table-layout: fixed;
  min-width: 0;
  width: 100%;
}

:deep(.outcome-cost-allocation-table th),
:deep(.outcome-cost-allocation-table td) {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

:deep(.outcome-cost-allocation-table th:nth-child(1)) {
  width: 24%;
}

:deep(.outcome-cost-allocation-table th:nth-child(2)) {
  width: 16%;
}

:deep(.outcome-cost-allocation-table th:nth-child(3)) {
  width: 13%;
}

:deep(.outcome-cost-allocation-table th:nth-child(4)) {
  width: 13%;
}

:deep(.outcome-cost-allocation-table th:nth-child(5)) {
  width: 11%;
}

:deep(.outcome-cost-allocation-table th:nth-child(6)) {
  width: 11%;
}

:deep(.outcome-cost-allocation-table th:nth-child(7)) {
  width: 12%;
}
</style>
