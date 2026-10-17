<script setup lang="ts">
import { AgreementOutcomeCostAllocationTabErrorMessages, AgreementOutcomeCostAllocationTabStatusMessages, AgreementOutcomeCostAllocationTabMessages } from '../i18n/AgreementOutcomeCostAllocationTab'

import { computed, ref, watch, type Ref } from 'vue'
import type {
  ExtensionEntityTabContext,
  GcsExtensionJsonConfig,
  GcsExtensionRbacRequirement
} from '@gcs-ssc/extensions'
import {
  ExtensionButton,
  ExtensionDetailPage,
  ExtensionDetailWorkspace,
  ExtensionEntityHero,
  ExtensionCompletionPanel,
  ExtensionFormField,
  ExtensionIcon,
  ExtensionInput,
  ExtensionCurrencyInput,
  ExtensionModal,
  ExtensionSaveButton,
  ExtensionSelect,
  ExtensionSelectMenu,
  ExtensionSupplementaryInformationSection,
  ExtensionTable,
  ExtensionWorkflowSection,
  useHostApi,
  useExtensionApi,
  useExtensionConfirmDialog,
  useExtensionI18n,
  useExtensionToast,
  useExtensionUrlTabState
} from '@gcs-ssc/extensions/ui'
import {
  type AllocationMoney,
  type AllocationVersionStatus,
  type CommitmentType,
  type CostAllocationVersion,
  type VersionedOutcomeAllocationInput,
  compareMoney,
  fromCents,
  moneyForPercentage,
  parseAllocationMoney,
  parseExactNumeric19Scale4,
  percentageForMoney,
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
  subtractMoney,
  sumMoney,
  toExactNumeric19Scale4Units,
  toMoney
} from '../shared/allocation'
import {
  buildOutcomeAllocationRows,
  formatCurrencyAmount,
  type AllocationResponse,
  type AllocationTableRow,
  type ConfiguredAssociationRow,
  getOutcomeAllocationToastText,
  saveOutcomeAllocationsRequest
} from '../shared/agreement-outcome-cost-allocation-tab'

type AllocationOutcome = AllocationResponse['outcomes'][number]
type AllocationBudgetYear = AllocationResponse['budgetYears'][number]
type AllocationStreamCommitment = AllocationResponse['streamCommitments'][number]

const {
  extensionKey,
  context,
  config,
  recordId,
  navigation,
  agreementContext,
  canUpdate = false,
  canWork = false
} = defineProps<{
  extensionKey: string
  context: ExtensionEntityTabContext
  config: GcsExtensionJsonConfig
  rbac: GcsExtensionRbacRequirement
  recordId: string
  agreementContext?: { titleEn: string; titleFr: string; agreementNumber: string }
  canUpdate?: boolean
  canDelete?: boolean
  canWork?: boolean
  navigation: { collectionHref: string; recordHref: (recordId: string) => string }
}>()

const { locale, t: tLocal } = useExtensionI18n(AgreementOutcomeCostAllocationTabMessages)
const { t: errorText } = useExtensionI18n(AgreementOutcomeCostAllocationTabErrorMessages)
const { t: statusText } = useExtensionI18n(AgreementOutcomeCostAllocationTabStatusMessages)
const toast = useExtensionToast()
const allocations: Ref<VersionedOutcomeAllocationInput[]> = ref([])
const selectedVersionId = computed(() => recordId)
const isSaving: Ref<boolean> = ref(false)
const workflowRefreshKey: Ref<number> = ref(0)
const collapsed = ref(false)
const views = computed(() => [
  { key: 'summary', value: 'summary', label: tLocal('summary'), icon: 'i-lucide-chart-no-axes-combined' },
  { key: 'allocation', value: 'allocation', label: tLocal('allocation'), icon: 'i-lucide-table' },
  { key: 'supplementary-information', value: 'supplementary-information', label: tLocal('supplementaryInformation'), icon: 'i-lucide-clipboard-list' },
  { key: 'workflows', value: 'workflows', label: tLocal('workflows'), icon: 'i-lucide-workflow' },
  { key: 'completion', value: 'completion', label: tLocal('allocationCompletion'), icon: 'i-lucide-circle-check' }
])
const { selectedTab: selectedView } = useExtensionUrlTabState({ tabs: views, defaultTab: 'summary' })
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
const completionLoading = ref(true)
const completionLoadFailed = ref(false)
const status: Ref<'idle' | 'pending' | 'success' | 'error'> = ref('idle')
let requestGeneration = 0
const refresh = async () => {
  const generation = ++requestGeneration
  try {
    status.value = 'pending'
    const response = await api.get<AllocationResponse>(endpoint.value)
    if (generation !== requestGeneration) return
    data.value = response
    status.value = 'success'
  } catch {
    if (generation !== requestGeneration) return
    data.value = null
    status.value = 'error'
  }
}
await refresh()

const syncAllocationResponse = (value: AllocationResponse | null) => {
  allocations.value = value?.allocations.map((allocation: VersionedOutcomeAllocationInput) => ({ ...allocation })) ?? []
}

watch(() => data.value, value => {
  syncAllocationResponse(value)
}, { immediate: true })

const outcomes = computed<AllocationOutcome[]>(() => data.value?.outcomes ?? [])
const budgetYears = computed<AllocationBudgetYear[]>(() => data.value?.budgetYears ?? [])
const streamCommitments = computed<AllocationStreamCommitment[]>(() => data.value?.streamCommitments ?? [])
const hasPendingEffects = computed(() => data.value?.hasPendingEffects === true)
const warnPendingEffects = () => {
  if (!hasPendingEffects.value) return false
  saveError.value = tLocal('pendingEffects')
  toast.add({ title: getOutcomeAllocationToastText(locale.value, 'error').title, description: saveError.value, color: 'warning' })
  return true
}
const paidCoding = computed(() => (data.value?.codingPaidAmounts ?? []).map(line => {
  const coding = streamCommitments.value.find(item => item.agency_chart_of_account_id === line.agencyChartOfAccountId)
  const year = budgetYears.value.find(item => item.fiscal_year_id === line.agencyFiscalYearId)
  return {
    ...line,
    label: (locale.value === 'fr' ? line.labelFr : line.labelEn) || (coding ? getCommitmentLineLabel(coding.id) : line.agencyChartOfAccountId),
    yearLabel: line.fiscalYearDisplay ?? year?.fiscal_year_display ?? coding?.fiscal_year_display ?? line.agencyFiscalYearId
  }
}))

const versions = computed<CostAllocationVersion[]>(() => data.value?.versions ?? [])
const selectedVersion = computed<CostAllocationVersion | null>(() => versions.value.find((version: CostAllocationVersion) => version.id === selectedVersionId.value) ?? null)
const canEditSelectedVersion = computed(() => selectedVersion.value?.status === 'draft' && !selectedVersionHasCompletion.value)
const warnEditingBlocked = () => {
  if (!canUpdate) return true
  if (completionLoading.value) return true
  if (completionLoadFailed.value) return true
  if (canWork && canEditSelectedVersion.value) return false
  saveError.value = tLocal(canWork ? 'readonly' : 'assignmentRequired')
  toast.add({ title: getOutcomeAllocationToastText(locale.value, 'error').title, description: saveError.value, color: 'warning' })
  return true
}
const isLoading = computed(() => status.value === 'pending')
const streamConfig = computed(() => parseOutcomeCostAllocationConfig(config))

let completionRequestGeneration = 0
const refreshSelectedCompletion = async () => {
  const generation = ++completionRequestGeneration
  const requestedVersionId = selectedVersionId.value
  const requestedIdentity = `${context.agreementId}:${requestedVersionId}`
  const isCurrentRequest = () => generation === completionRequestGeneration
    && requestedIdentity === `${context.agreementId}:${selectedVersionId.value}`
  completionLoading.value = true
  completionLoadFailed.value = false
  if (!requestedVersionId) {
    selectedVersionHasCompletion.value = false
    completionLoading.value = false
    return
  }
  selectedVersionHasCompletion.value = true
  try {
    const query = new URLSearchParams({
      entityType: 'gcs-outcome-cost-allocation:allocation-version',
      entityId: requestedVersionId
    })
    const response = await hostApi.get<{ item: unknown | null }>(`/api/completions/runtime?${query.toString()}`)
    if (!isCurrentRequest()) return
    selectedVersionHasCompletion.value = response.item != null
  } catch {
    if (!isCurrentRequest()) return
    selectedVersionHasCompletion.value = true
    completionLoadFailed.value = true
  } finally {
    if (isCurrentRequest()) completionLoading.value = false
  }
}

watch([selectedVersionId, () => context.agreementId], refreshSelectedCompletion, { immediate: true })

const methodOptions = computed(() => [
  { label: tLocal('amount'), value: 'amount' },
  { label: tLocal('percentage'), value: 'percentage' }
])

const commitmentTypeOptions = computed(() => streamConfig.value.enabledCommitmentTypes.map(commitmentType => ({
  label: getCommitmentTypeLabel(commitmentType),
  value: commitmentType
})))

const fundedBudgetYears = computed(() => budgetYears.value.filter(
  (year: AllocationBudgetYear) => compareMoney((year.remaining_funding ?? year.program_funding), '0') > 0
))

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

const ZERO_MONEY = parseAllocationMoney('0')!
const formatMoney = (value: AllocationMoney) => data.value?.currency
  ? formatCurrencyAmount(value, locale.value, data.value.currency)
  : '—'
/**
 * Displays existing scale-four allocation drafts using the allocation's exact cent rounding.
 * @param value - Unmodified numeric(19,4) draft text.
 * @param language - Current interface locale.
 * @param currency - Owning Agreement denomination.
 * @returns Formatted cents, or null to retain invalid draft text.
 */
const formatAllocationInput = (value: string, language: string, currency: string): string | null => {
  const units = toExactNumeric19Scale4Units(value)
  return units === null ? null : formatCurrencyAmount(fromCents((units + BigInt(50)) / BigInt(100)), language, currency)
}

const getStatusLabel = (statusValue: AllocationVersionStatus) => statusText(statusValue)

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
    || compareMoney((year.remaining_funding ?? year.program_funding), ZERO_MONEY) <= 0
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
    programFunding: (year.remaining_funding ?? year.program_funding),
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
        ? (year.remaining_funding ?? year.program_funding)
        : ZERO_MONEY,
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
  allocationValue: '0'
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

const allocationEditor: Ref<{ association: ConfiguredAssociationRow; allocation: VersionedOutcomeAllocationInput } | null> = ref(null)
const isAllocationModalOpen = ref(false)
const allocationEditorError = ref('')

const closeAllocationEditor = () => {
  isAllocationModalOpen.value = false
  allocationEditor.value = null
  allocationEditorError.value = ''
}

const openAllocationEditor = (association: ConfiguredAssociationRow) => {
  if (warnEditingBlocked()) return
  if (warnPendingEffects() || !canEditSelectedVersion.value || hasPendingDraftMutation.value) return
  allocationEditor.value = { association, allocation: { ...(getAllocation(association) ?? createAllocation(association)) } }
  allocationEditorError.value = ''
  isAllocationModalOpen.value = true
}

const editorResolvedAllocations = computed(() => {
  const editor = allocationEditor.value
  if (!editor) return []
  return resolveAllocationAmounts(activeAllocations.value.map(allocation =>
    getAllocationKey(allocation) === getAssociationKey(editor.association) ? editor.allocation : allocation
  ), allocationYearTotals.value)
})
const editorAmount = computed(() => editorResolvedAllocations.value.find(allocation =>
  allocationEditor.value && getAllocationKey(allocation) === getAssociationKey(allocationEditor.value.association)
)?.amount ?? ZERO_MONEY)
const editorUnallocated = computed(() => allocationEditor.value
  ? subtractMoney(
      allocationEditor.value.association.programFunding,
      sumMoney(editorResolvedAllocations.value.filter(allocation =>
        allocation.agreementBudgetFiscalYearId === allocationEditor.value?.association.yearId
      ).map(allocation => allocation.amount))
    )
  : ZERO_MONEY)

const updateEditorMethod = (value: string | number) => {
  const editor = allocationEditor.value
  if (!editor || (value !== 'amount' && value !== 'percentage') || value === editor.allocation.allocationMethod) return
  const amount = editorAmount.value
  editor.allocation.allocationMethod = value
  editor.allocation.allocationValue = value === 'percentage'
    ? percentageForMoney(amount, editor.association.programFunding)
    : amount
  allocationEditorError.value = ''
}

const applyAllocationEditor = () => {
  if (warnEditingBlocked()) return
  const editor = allocationEditor.value
  if (!editor || warnPendingEffects() || !canEditSelectedVersion.value || hasPendingDraftMutation.value) return
  const parsed = parseExactNumeric19Scale4(editor.allocation.allocationValue)
  if (parsed === null || (editor.allocation.allocationMethod === 'percentage' && toExactNumeric19Scale4Units(parsed)! > BigInt(1_000_000))) {
    allocationEditorError.value = tLocal('invalidValue')
    return
  }
  if (compareMoney(editorUnallocated.value, ZERO_MONEY) < 0) {
    allocationEditorError.value = errorText('GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED')
    return
  }
  Object.assign(ensureAllocation(editor.association), editor.allocation, { allocationValue: parsed })
  closeAllocationEditor()
}

watch(isAllocationModalOpen, open => {
  if (!open) closeAllocationEditor()
})
watch([selectedVersionId, () => context.agreementId, data, canEditSelectedVersion, () => canUpdate, () => canWork], closeAllocationEditor)

const isHistoricalAssociation = (association: ConfiguredAssociationRow) =>
  !configuredAssociationByKey.value.has(getAssociationKey(association))

/**
 * Removes one stale draft allocation locally so config drift can be repaired before saving.
 */
const removeHistoricalDraftAllocation = (association: ConfiguredAssociationRow) => {
  if (warnEditingBlocked()) return
  if (
    !canEditSelectedVersion.value
    || hasPendingEffects.value
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
  programFunding: (year.remaining_funding ?? year.program_funding)
})))

const selectedDraftResolvedAmountByKey = computed(() => {
  if (selectedVersion.value?.status !== 'draft') {
    return new Map<string, AllocationMoney>()
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
  budgetYears.value.find((year: AllocationBudgetYear) => String(year.id) === yearId)?.remaining_funding ?? budgetYears.value.find((year: AllocationBudgetYear) => String(year.id) === yearId)?.program_funding ?? ZERO_MONEY

const getAllocationInputAmount = (allocation: VersionedOutcomeAllocationInput) =>
  allocation.resolvedAmount !== null && allocation.resolvedAmount !== undefined
    ? toMoney(allocation.resolvedAmount)
    : allocation.allocationVersionId === selectedVersionId.value
      && selectedVersion.value?.status === 'draft'
      ? selectedDraftResolvedAmountByKey.value.get(getAllocationKey(allocation)) ?? ZERO_MONEY
      : allocation.allocationMethod === 'percentage'
        ? moneyForPercentage(getProgramFunding(allocation.agreementBudgetFiscalYearId), allocation.allocationValue)
        : toMoney(allocation.allocationValue)

const getAllocationAmount = (association: ConfiguredAssociationRow) => {
  const allocation = getAllocation(association)
  return allocation ? getAllocationInputAmount(allocation) : ZERO_MONEY
}

const getVersionAllocations = (versionId: string) => allocations.value.filter((allocation: VersionedOutcomeAllocationInput) =>
  allocation.allocationVersionId === versionId
)

const getVersionTotal = (versionId: string) => sumMoney(
  getVersionAllocations(versionId).map(getAllocationInputAmount)
)

const getVersionProgramFundingTotal = (versionId: string) => {
  const version = versions.value.find(candidate => candidate.id === versionId)
  if (version?.fundingBasisAmount !== null && version?.fundingBasisAmount !== undefined) {
    return version.fundingBasisAmount
  }

  return sumMoney(budgetYears.value.map(year => (year.remaining_funding ?? year.program_funding)))
}

const getVersionUnallocated = (versionId: string) =>
  subtractMoney(getVersionProgramFundingTotal(versionId), getVersionTotal(versionId))

const getGroupAmountTotal = (rows: ConfiguredAssociationRow[]) =>
  sumMoney(rows.map(getAllocationAmount))

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
  subtractMoney(getProgramFunding(yearId), getFiscalYearAllocatedTotal(yearId))

const getAmountForRow = (row: AllocationTableRow) => {
  if (row.rowType === 'commitmentType' && row.commitmentType) {
    return getCommitmentTypeAmountTotal(row.commitmentType)
  }

  if (row.rowType === 'fiscalYear' && row.commitmentType) {
    return getFiscalYearAmountTotal(row.commitmentType, row.yearId)
  }

  return row.association ? getAllocationAmount(row.association) : ZERO_MONEY
}

const getUnallocatedForRow = (row: AllocationTableRow): AllocationMoney | null => {
  if (row.rowType === 'commitmentType') {
    return getVersionUnallocated(selectedVersionId.value)
  }

  if (row.rowType === 'fiscalYear') {
    return getFiscalYearUnallocated(row.yearId)
  }

  return null
}

const isOverAllocated = (value: AllocationMoney | null) => value !== null && compareMoney(value, ZERO_MONEY) < 0

const getUnallocatedClass = (value: AllocationMoney | null) => [
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
  if (warnEditingBlocked()) return
  if (warnPendingEffects()) return
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
  if (warnEditingBlocked()) return
  if (warnPendingEffects()) return
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
  if (warnEditingBlocked()) return false
  if (warnPendingEffects()) return false
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

const handleWorkflowChanged = async () => {
  await Promise.all([
    refresh(),
    refreshSelectedCompletion()
  ])
}

const hasPendingDraftMutation = computed(() => isSaving.value || isLoading.value || completionLoading.value)
const isDirty = computed(() => JSON.stringify(selectedVersionAllocations.value)
  !== JSON.stringify(data.value?.allocations.filter(allocation => allocation.allocationVersionId === recordId) ?? []))
const completionLabels = computed(() => ({
  title: tLocal('allocationCompletion'),
  description: tLocal('completionDescription'),
  statusComplete: tLocal('completionRecorded'),
  statusLocked: tLocal('completionLocked'),
  commentPlaceholder: tLocal('completionComment'),
  completeAction: tLocal('complete'),
  completedSuccess: tLocal('completionSuccess')
}))
const versionTitle = computed(() => `${tLocal('version')} ${selectedVersion.value?.versionNumber ?? ''}`.trim())
const agreementTitle = computed(() => agreementContext
  ? locale.value === 'fr' ? agreementContext.titleFr : agreementContext.titleEn
  : '')
const breadcrumbItems = computed(() => [
  ...(agreementTitle.value ? [{ label: agreementTitle.value, to: navigation.collectionHref }] : []),
  { label: tLocal('allocationVersions'), to: navigation.collectionHref },
  { label: versionTitle.value }
])
watch(() => context.agreementId, () => {
  data.value = null
  saveError.value = ''
  expandedRows.value = {}
  isGenerateModalOpen.value = false
  refresh()
})
watch(() => recordId, () => {
  saveError.value = ''
  expandedRows.value = {}
  isGenerateModalOpen.value = false
  syncAllocationResponse(data.value)
  closeAllocationEditor()
})
</script>

<template>
  <ExtensionDetailPage id="outcome-cost-allocation-detail" v-model:collapsed="collapsed" :breadcrumb-items="breadcrumbItems">
    <template #body>
      <div class="flex min-w-0 flex-1 flex-col">
        <ExtensionEntityHero
          :is-collapsed="collapsed" icon="i-lucide-chart-no-axes-combined" :title="versionTitle" :description="agreementTitle" :meta-items="[agreementContext?.agreementNumber, tLocal('title')]"
          :badges="selectedVersion ? [{ label: getStatusLabel(selectedVersion.status), uiVariant: 'subtle' }] : []" />
        <ExtensionDetailWorkspace
          v-if="selectedVersion" v-model="selectedView" :items="views" :priority-values="['summary']" content-test-id="allocation-version-detail-content"
          :section-description="selectedView === 'workflows' ? tLocal('workflowsDescription') : undefined">
          <template #actions>
            <template v-if="selectedView === 'allocation' && canUpdate">
              <ExtensionButton
                icon="i-lucide-plus" :label="tLocal('generateRows')" color="neutral" variant="outline"
                :disabled="hasPendingDraftMutation" @click="openGenerateRows" />
              <ExtensionSaveButton :label="tLocal('save')" :loading="isSaving" :disabled="hasPendingDraftMutation" @click="save" />
            </template>
          </template>
          <template #notices>
            <div v-if="completionLoadFailed" role="alert" class="space-y-2">
              <p class="text-sm text-error">
                {{ tLocal('completionLoadError') }}
              </p>
              <ExtensionButton :label="tLocal('retry')" :disabled="completionLoading" @click="saveError = ''; refreshSelectedCompletion()" />
            </div>
            <p v-if="saveError" role="alert" class="text-sm text-error">
              {{ saveError }}
            </p>
            <p v-if="hasPendingEffects" role="status" class="text-sm text-warning">
              {{ tLocal('pendingEffects') }}
            </p>
            <p v-if="selectedView === 'allocation' && !completionLoading && !completionLoadFailed && !canEditSelectedVersion" class="text-sm text-muted">
              {{ tLocal('readonly') }}
            </p>
            <p v-if="selectedView === 'completion' && isDirty" role="status" class="text-sm text-warning">
              {{ tLocal('saveBeforeCompletion') }}
            </p>
          </template>
          <div v-if="selectedView === 'summary'" class="space-y-6">
            <div v-if="budgetYears.length" class="space-y-3 overflow-x-auto">
              <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
                {{ tLocal('currentBalances') }}
              </h3>
              <table class="w-full text-left text-sm">
                <caption class="sr-only">
                  {{ tLocal('currentBalances') }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" class="px-3 py-2">
                      {{ tLocal('fiscalYears') }}
                    </th>
                    <th scope="col" class="px-3 py-2">
                      {{ tLocal('funding') }}
                    </th>
                    <th scope="col" class="px-3 py-2">
                      {{ tLocal('paid') }}
                    </th>
                    <th scope="col" class="px-3 py-2">
                      {{ tLocal('remaining') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="year in budgetYears" :key="year.id" class="border-t border-zinc-200 dark:border-zinc-800">
                    <th scope="row" class="px-3 py-2 font-medium">
                      {{ year.fiscal_year_display }}
                    </th>
                    <td class="px-3 py-2">
                      {{ formatMoney(year.program_funding) }}
                    </td>
                    <td class="px-3 py-2">
                      {{ formatMoney(year.paid_amount ?? ZERO_MONEY) }}
                    </td>
                    <td class="px-3 py-2">
                      {{ formatMoney(year.remaining_funding ?? year.program_funding) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="paidCoding.length" class="space-y-3 overflow-x-auto">
              <h3 class="text-base font-semibold text-zinc-900 dark:text-white">
                {{ tLocal('paidCoding') }}
              </h3>
              <table class="w-full text-left text-sm">
                <caption class="sr-only">
                  {{ tLocal('paidCoding') }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" class="px-3 py-2">
                      {{ tLocal('commitmentLine') }}
                    </th>
                    <th scope="col" class="px-3 py-2">
                      {{ tLocal('fiscalYears') }}
                    </th>
                    <th scope="col" class="px-3 py-2">
                      {{ tLocal('paid') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="line in paidCoding" :key="`${line.agencyFiscalYearId}:${line.agencyChartOfAccountId}`" class="border-t border-zinc-200 dark:border-zinc-800">
                    <th scope="row" class="px-3 py-2 font-medium">
                      {{ line.label }}
                    </th>
                    <td class="px-3 py-2">
                      {{ line.yearLabel }}
                    </td>
                    <td class="px-3 py-2">
                      {{ formatMoney(line.paidAmount) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-else-if="selectedView === 'allocation'" class="space-y-4">
            <p v-if="displayedAssociationRows.length === 0 && (outcomes.length === 0 || budgetYears.length === 0 || configuredAssociationRows.length === 0)" class="text-sm text-muted">
              {{ tLocal('empty') }}
            </p>
            <div
              role="group"
              :aria-label="tLocal('title')"
              tabindex="0"
              class="outcome-cost-allocation-table w-full min-w-0 max-w-full overflow-x-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <div class="w-full min-w-0">
                <ExtensionTable
                  :data="allocationRows"
                  :columns="allocationColumns"
                  :ui="{ root: 'overflow-visible' }"
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
                        <div class="text-sm font-semibold whitespace-normal text-zinc-900 dark:text-white">
                          {{ row.original.commitmentLineLabel }}
                        </div>
                        <div class="text-xs font-medium whitespace-normal text-zinc-500 dark:text-zinc-400">
                          {{ row.original.outcomeLabel }}
                        </div>
                      </div>
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
                      {{ formatMoney(getUnallocatedForRow(row.original) ?? ZERO_MONEY) }}
                    </span>
                  </template>

                  <template #allocationActions-cell="{ row }">
                    <ExtensionButton
                      v-if="canUpdate && row.original.association"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      icon="i-lucide-pencil"
                      class="cursor-default"
                      :aria-label="`${tLocal('editAllocation')}: ${row.original.commitmentLineLabel} — ${row.original.outcomeLabel} (${row.original.yearLabel})`"
                      :disabled="hasPendingDraftMutation"
                      @click="openAllocationEditor(row.original.association)" />
                    <ExtensionButton
                      v-if="canUpdate && row.original.association && isHistoricalAssociation(row.original.association)"
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
          </div>
          <ExtensionSupplementaryInformationSection
            v-else-if="selectedView === 'supplementary-information'" :key="recordId"
            entity-type="gcs-outcome-cost-allocation:allocation-version" :entity-id="recordId" :show-header="false" />
          <ExtensionWorkflowSection
            v-else-if="selectedView === 'workflows'" :key="recordId"
            entity-type="gcs-outcome-cost-allocation:allocation-version" :entity-id="recordId" :can-edit="!hasPendingDraftMutation"
            :refresh-key="workflowRefreshKey" @changed="handleWorkflowChanged" />
          <ExtensionCompletionPanel
            v-else-if="selectedView === 'completion'" :key="recordId"
            entity-type="gcs-outcome-cost-allocation:allocation-version" :entity-id="recordId"
            :can-complete="canUpdate && canWork && canEditSelectedVersion && !isDirty && !hasPendingDraftMutation && !hasPendingEffects"
            :can-work-workflow="!hasPendingDraftMutation" :labels="completionLabels" :show-header="false" :show-divider="false"
            :refresh-key="workflowRefreshKey" @changed="handleWorkflowChanged" />
        </ExtensionDetailWorkspace>
        <div v-else-if="status === 'error'" role="alert" class="space-y-3">
          <p>{{ tLocal('loadError') }}</p>
          <ExtensionButton :label="tLocal('retry')" @click="refresh" />
        </div>
        <p v-else role="status">
          {{ tLocal('missingAllocation') }}
        </p>
        <ExtensionModal
          v-model:open="isAllocationModalOpen"
          :title="tLocal('editAllocation')"
          :ui="{ content: 'sm:max-w-2xl', body: 'max-h-[75vh] overflow-y-auto' }">
          <template #body>
            <form v-if="allocationEditor" novalidate class="space-y-6" @submit.prevent="applyAllocationEditor">
              <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div
                  v-for="item in [
                    { label: tLocal('commitmentType'), value: allocationEditor.association.commitmentTypeLabel },
                    { label: tLocal('fiscalYears'), value: allocationEditor.association.yearLabel },
                    { label: tLocal('commitmentLine'), value: allocationEditor.association.commitmentLineLabel },
                    { label: tLocal('outcome'), value: allocationEditor.association.outcomeLabel }
                  ]" :key="item.label">
                  <dt class="text-sm text-muted">
                    {{ item.label }}
                  </dt>
                  <dd class="font-medium break-words">
                    {{ item.value }}
                  </dd>
                </div>
              </dl>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <ExtensionFormField :label="tLocal('method')" name="allocationMethod" required>
                  <ExtensionSelect
                    :model-value="allocationEditor.allocation.allocationMethod"
                    :items="methodOptions"
                    value-key="value"
                    aria-required="true"
                    :disabled="hasPendingDraftMutation"
                    class="w-full"
                    @update:model-value="updateEditorMethod" />
                </ExtensionFormField>
                <ExtensionFormField
                  :label="tLocal(allocationEditor.allocation.allocationMethod === 'percentage' ? 'percentage' : 'amount')"
                  name="allocationValue"
                  :error="allocationEditorError"
                  required>
                  <component
                    :is="allocationEditor.allocation.allocationMethod === 'percentage' ? ExtensionInput : ExtensionCurrencyInput"
                    v-model="allocationEditor.allocation.allocationValue"
                    :currency="allocationEditor.allocation.allocationMethod === 'percentage' ? undefined : data?.currency"
                    :format-value="allocationEditor.allocation.allocationMethod === 'percentage' ? undefined : formatAllocationInput"
                    inputmode="decimal"
                    required
                    :disabled="hasPendingDraftMutation"
                    class="w-full" />
                </ExtensionFormField>
              </div>
              <dl class="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-live="polite">
                <div>
                  <dt class="text-sm text-muted">
                    {{ tLocal('remaining') }}
                  </dt><dd class="font-medium">
                    {{ formatMoney(toMoney(allocationEditor.association.programFunding)) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-sm text-muted">
                    {{ tLocal('amount') }}
                  </dt><dd class="font-medium">
                    {{ formatMoney(editorAmount) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-sm text-muted">
                    {{ tLocal('unallocated') }}
                  </dt><dd :class="getUnallocatedClass(editorUnallocated)">
                    {{ formatMoney(editorUnallocated) }}
                  </dd>
                </div>
              </dl>
              <p class="text-sm text-muted">
                {{ tLocal('editHint') }}
              </p>
              <div class="flex justify-end gap-2 pt-4">
                <ExtensionButton type="button" :label="tLocal('cancel')" color="neutral" variant="ghost" @click="closeAllocationEditor" />
                <ExtensionSaveButton :label="tLocal('update')" :disabled="hasPendingDraftMutation" />
              </div>
            </form>
          </template>
        </ExtensionModal>

        <ExtensionModal v-model:open="isGenerateModalOpen" :title="tLocal('generateRowsTitle')">
          <template #body>
            <div class="space-y-4">
              <ExtensionFormField :label="tLocal('commitmentType')" required>
                <ExtensionSelect
                  v-model="generationCommitmentType"
                  value-key="value"
                  :items="commitmentTypeOptions"
                  :disabled="hasPendingDraftMutation"
                  class="w-full" />
              </ExtensionFormField>

              <ExtensionFormField :label="tLocal('fiscalYears')" required>
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
  </ExtensionDetailPage>
</template>

<style scoped>
:deep(.outcome-cost-allocation-table table) {
  table-layout: fixed;
  min-width: 48rem;
  width: 100%;
}

:deep(.outcome-cost-allocation-table th),
:deep(.outcome-cost-allocation-table td) {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

:deep(.outcome-cost-allocation-table th:nth-child(1)) {
  width: 46%;
}

:deep(.outcome-cost-allocation-table th:nth-child(2)) {
  width: 20%;
}

:deep(.outcome-cost-allocation-table th:nth-child(3)) {
  width: 20%;
}

:deep(.outcome-cost-allocation-table th:nth-child(4)) {
  width: 14%;
}
</style>
