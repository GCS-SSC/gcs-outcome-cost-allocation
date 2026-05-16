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
import {
  buildOutcomeAllocationRows,
  completeOutcomeAllocationSelectedVersion,
  completeOutcomeAllocationVersionRequest,
  deleteOutcomeAllocationDraftVersionRequest,
  type AllocationTableRow,
  type ConfiguredAssociationRow,
  getOutcomeAllocationVersionEndpoint,
  getOutcomeAllocationVersionsEndpoint,
  getOutcomeAllocationResponseErrorMessage,
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
    gl: number
    gl_description: string
  }>
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
const isGenerateModalOpen: Ref<boolean> = ref(false)
const generationCommitmentType: Ref<CommitmentType> = ref('commitment')
const generationYearIds: Ref<string[]> = ref([])
const confirm = useConfirmDialog()

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
const canEditSelectedVersion = computed(() => selectedVersion.value?.status === 'draft')
const hasDraftVersion = computed(() => versions.value.some((version: CostAllocationVersion) => version.status === 'draft'))
const isLoading = computed(() => status.value === 'pending')
const streamConfig = computed(() => parseOutcomeCostAllocationConfig(config))

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
  },
  {
    id: 'unallocated',
    header: tLocal('unallocated')
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
  if (!year || Number(year.program_funding) <= 0 || !hasOutcome) {
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

const getAllocationKey = (allocation: {
  commitmentType?: CommitmentType
  streamCommitmentId?: string
  agreementBudgetFiscalYearId: string
  outcomeId: string
}) => [
  allocation.commitmentType ?? 'commitment',
  allocation.agreementBudgetFiscalYearId,
  allocation.streamCommitmentId ?? '',
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

const displayedAssociationRows = computed<ConfiguredAssociationRow[]>(() => selectedVersionAllocations.value.flatMap((allocation: VersionedOutcomeAllocationInput) => {
  const association = configuredAssociationByKey.value.get(getAllocationKey(allocation))
  return association ? [association] : []
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
    && allocation.commitmentType === association.commitmentType
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
  allocation.allocationMethod = allocationMethod
}

const setAllocationValue = (association: ConfiguredAssociationRow, value: string | number) => {
  const allocation = ensureAllocation(association)
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

const updateGenerationYearIds = (value: unknown) => {
  generationYearIds.value = Array.isArray(value)
    ? value.map(item => String(item))
    : []
}

const activeAllocations = computed<VersionedOutcomeAllocationInput[]>(() => selectedVersionAllocations.value)

const getProgramFunding = (yearId: string) =>
  Number(budgetYears.value.find((year: AllocationBudgetYear) => String(year.id) === yearId)?.program_funding ?? 0)

const agreementProgramFundingTotal = computed(() => budgetYears.value
  .reduce((sum: number, year: AllocationBudgetYear) => toMoney(sum + Number(year.program_funding)), 0)
)

const getAllocationInputAmount = (allocation: OutcomeAllocationInput) => allocation.allocationMethod === 'percentage'
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

const getVersionUnallocated = (versionId: string) =>
  toMoney(agreementProgramFundingTotal.value - getVersionTotal(versionId))

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
  getGroupAmountTotal(displayedAssociationRows.value.filter((row: ConfiguredAssociationRow) => row.commitmentType === commitmentType))

const getFiscalYearAmountTotal = (commitmentType: CommitmentType, yearId: string) =>
  getGroupAmountTotal(displayedAssociationRows.value.filter((row: ConfiguredAssociationRow) =>
    row.commitmentType === commitmentType && row.yearId === yearId
  ))

const getCommitmentTypeUnallocated = (commitmentType: CommitmentType) =>
  toMoney(agreementProgramFundingTotal.value - getCommitmentTypeAmountTotal(commitmentType))

const getFiscalYearUnallocated = (commitmentType: CommitmentType, yearId: string) =>
  toMoney(getProgramFunding(yearId) - getFiscalYearAmountTotal(commitmentType, yearId))

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
  if (row.rowType === 'commitmentType' && row.commitmentType) {
    return getCommitmentTypeUnallocated(row.commitmentType)
  }

  if (row.rowType === 'fiscalYear' && row.commitmentType) {
    return getFiscalYearUnallocated(row.commitmentType, row.yearId)
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
  generationCommitmentType.value = streamConfig.value.enabledCommitmentTypes[0] ?? 'commitment'
  generationYearIds.value = fundedBudgetYears.value.map((year: AllocationBudgetYear) => String(year.id))
  isGenerateModalOpen.value = true
}

const applyGeneratedRows = async () => {
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

const save = async () => {
  if (isSaving.value || !canEditSelectedVersion.value || !selectedVersionId.value) {
    return false
  }

  try {
    isSaving.value = true
    saveError.value = ''
    await saveOutcomeAllocationsRequest(
      getClientRequestUrl(endpoint.value),
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

const completeSelectedVersion = async () => completeOutcomeAllocationSelectedVersion({
  isCompleting,
  canEditSelectedVersion: canEditSelectedVersion.value,
  selectedVersionId: selectedVersionId.value,
  validationIssueCount: validationIssues.value.length,
  validationMessage: validationMessage.value,
  locale: locale.value,
  saveError,
  save,
  refresh,
  buildCompleteRequestUrl: versionId => getClientRequestUrl(`${getOutcomeAllocationVersionEndpoint(endpoint.value, versionId)}/complete`),
  toast,
  completeRequest: completeOutcomeAllocationVersionRequest
})

const createDraftVersion = async () => {
  if (isCreatingDraft.value) {
    return
  }

  try {
    isCreatingDraft.value = true
    saveError.value = ''
    const fetchResponse = await fetch(getClientRequestUrl(getOutcomeAllocationVersionsEndpoint(endpoint.value)), {
      method: 'POST'
    })
    if (!fetchResponse.ok) throw new Error(await getOutcomeAllocationResponseErrorMessage(fetchResponse))
    const response = await fetchResponse.json() as { version?: CostAllocationVersion }
    await refresh()
    selectedVersionId.value = resolveCreatedDraftVersionId(selectedVersionId.value, response)
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
    await deleteOutcomeAllocationDraftVersionRequest(
      getClientRequestUrl(getOutcomeAllocationVersionEndpoint(endpoint.value, versionId))
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
  noRows: {
    en: 'No allocation rows have been added to this draft.',
    fr: 'Aucune ligne de repartition n a ete ajoutee a ce brouillon.'
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
  <div class="w-full min-w-0 max-w-full space-y-6 overflow-hidden">
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
              <td class="px-4 py-4 font-semibold">
                <span :class="getUnallocatedClass(getVersionUnallocated(version.id))">
                  {{ formatMoney(getVersionUnallocated(version.id)) }}
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
        <UButton
          v-if="canEditSelectedVersion"
          icon="i-lucide-plus"
          :label="tLocal('generateRows')"
          color="neutral"
          variant="outline"
          class="cursor-default"
          :disabled="isSaving || isCompleting || isLoading"
          @click="openGenerateRows" />
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

    <div class="outcome-cost-allocation-table w-full min-w-0 max-w-full overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div class="w-full min-w-0 overflow-hidden">
        <UTable
          :data="allocationRows"
          :columns="allocationColumns"
          class="w-full max-w-full table-fixed">
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
              :model-value="getAllocation(row.original.association)?.allocationMethod ?? 'amount'"
              value-key="value"
              :items="methodOptions"
              class="w-full min-w-0"
              :disabled="!canEditSelectedVersion"
              @update:model-value="updateAllocationMethod(row.original.association, $event)" />
          </div>
        </template>

        <template #value-cell="{ row }">
          <div v-if="row.original.rowType === 'association' && row.original.association">
            <UInput
              :model-value="getAllocation(row.original.association)?.allocationValue ?? 0"
              type="number"
              min="0"
              step="0.01"
              class="w-full min-w-0"
              :disabled="!canEditSelectedVersion"
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
        </UTable>
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

    <UModal v-model:open="isGenerateModalOpen" :title="tLocal('generateRowsTitle')">
      <template #body>
        <div class="space-y-4">
          <UFormField :label="tLocal('commitmentType')">
            <USelect
              v-model="generationCommitmentType"
              value-key="value"
              :items="commitmentTypeOptions"
              class="w-full" />
          </UFormField>

          <UFormField :label="tLocal('fiscalYears')">
            <USelectMenu
              :model-value="generationYearIds as never"
              multiple
              value-key="value"
              label-key="label"
              :items="generationYearOptions"
              class="w-full"
              @update:model-value="updateGenerationYearIds" />
          </UFormField>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="locale === 'fr' ? 'Annuler' : 'Cancel'"
            color="neutral"
            variant="ghost"
            class="cursor-default"
            @click="isGenerateModalOpen = false" />
          <UButton
            :label="tLocal('generateRows')"
            color="primary"
            class="cursor-default"
            :disabled="generationYearIds.length === 0"
            @click="applyGeneratedRows" />
        </div>
      </template>
    </UModal>
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
  width: 28%;
}

:deep(.outcome-cost-allocation-table th:nth-child(2)) {
  width: 18%;
}

:deep(.outcome-cost-allocation-table th:nth-child(3)) {
  width: 14%;
}

:deep(.outcome-cost-allocation-table th:nth-child(4)) {
  width: 14%;
}

:deep(.outcome-cost-allocation-table th:nth-child(5)) {
  width: 13%;
}

:deep(.outcome-cost-allocation-table th:nth-child(6)) {
  width: 13%;
}
</style>
