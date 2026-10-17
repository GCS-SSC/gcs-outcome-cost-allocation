import { h, type VNode } from 'vue'
import { translateGcsExtensionMessage } from '@gcs-ssc/extensions'
import { notifications } from '../i18n/notifications'
import type {
  CommitmentType,
  CostAllocationVersion,
  AllocationDecimalInput,
  AllocationMoney,
  VersionedOutcomeAllocationInput
} from './allocation'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ConfiguredAssociationRow {
  id: string
  commitmentType: CommitmentType
  commitmentTypeLabel: string
  yearId: string
  yearLabel: string
  /** Canonical strings are authoritative; safe numbers remain deprecated input compatibility. */
  programFunding: AllocationDecimalInput
  streamBudgetId: string
  streamCommitmentId: string
  commitmentLineLabel: string
  outcomeId: string
  outcomeLabel: string
}

export interface AllocationTableRow {
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
  programFunding: AllocationDecimalInput
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

/**
 * Extracts the most specific API error message available, falling back to the response status text.
 */
export const getOutcomeAllocationResponseErrorMessage = async (response: Response) => {
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

const getCommitmentTypeGroupId = (commitmentType: CommitmentType) => `type:${commitmentType}`
const getFiscalYearGroupId = (commitmentType: CommitmentType, yearId: string) => `year:${commitmentType}:${yearId}`

/**
 * Builds commitment-type and fiscal-year groups, adding association rows only for expanded ancestors.
 */
export const buildOutcomeAllocationRows = (
  associations: ConfiguredAssociationRow[],
  options: {
    isExpanded: (groupId: string) => boolean
    recordsLabel: string
  }
): AllocationTableRow[] => {
  const rows: AllocationTableRow[] = []

  for (const commitmentType of [...new Set(associations.map(row => row.commitmentType))]) {
    const typeRows = associations.filter((row: ConfiguredAssociationRow) => row.commitmentType === commitmentType)
    if (typeRows.length === 0) {
      continue
    }

    const commitmentTypeLabel = typeRows[0]?.commitmentTypeLabel ?? commitmentType
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
      outcomeLabel: `${typeRows.length} ${options.recordsLabel}`,
      associationCount: typeRows.length,
      programFunding: '0.00' as AllocationMoney
    })

    if (!options.isExpanded(typeGroupId)) {
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
        outcomeLabel: `${yearRows.length} ${options.recordsLabel}`,
        associationCount: yearRows.length,
        programFunding: firstYearRow.programFunding
      })

      if (!options.isExpanded(yearGroupId)) {
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
}

/**
 * Derives the allocation-version collection endpoint from the allocations endpoint.
 */
export const getOutcomeAllocationVersionsEndpoint = (allocationsEndpoint: string) =>
  allocationsEndpoint.replace('/allocations', '/allocation-versions')

/**
 * Appends a caller-encoded version id to the derived allocation-version collection endpoint.
 */
export const getOutcomeAllocationVersionEndpoint = (allocationsEndpoint: string, versionId: string) =>
  `${getOutcomeAllocationVersionsEndpoint(allocationsEndpoint)}/${versionId}`

/**
 * Builds the version-scoped allocation replacement request body.
 */
export const buildSaveOutcomeAllocationsRequestBody = (
  allocationVersionId: string,
  allocations: VersionedOutcomeAllocationInput[]
) => ({
  allocationVersionId,
  allocations
})

/**
 * Replaces one version's allocations and throws the server-provided message for a non-success response.
 */
export const saveOutcomeAllocationsRequest = async (
  requestUrl: RequestInfo | URL,
  allocationVersionId: string,
  allocations: VersionedOutcomeAllocationInput[],
  fetcher: Fetcher = fetch
) => {
  const response = await fetcher(requestUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildSaveOutcomeAllocationsRequestBody(allocationVersionId, allocations))
  })
  if (!response.ok) {
    throw new Error(await getOutcomeAllocationResponseErrorMessage(response))
  }
}

/**
 * Deletes a draft allocation version and throws the server-provided message for a non-success response.
 */
export const deleteOutcomeAllocationDraftVersionRequest = async (
  requestUrl: RequestInfo | URL,
  fetcher: Fetcher = fetch
) => {
  const response = await fetcher(requestUrl, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await getOutcomeAllocationResponseErrorMessage(response))
  }
}

/**
 * Returns callbacks that resolve allocation feedback in the current locale.
 */
export const getOutcomeAllocationToastText = (
  locale: () => string,
  key: 'saved' | 'deleted' | 'error'
): { title: () => VNode; description: () => VNode } => {
  return {
    title: () => h('span', translateGcsExtensionMessage(notifications, locale(), key === 'error' ? 'error' : 'success')),
    description: () => h('span', key === 'error' ? '' : translateGcsExtensionMessage(notifications, locale(), key))
  }
}

export interface AllocationResponse {
  currency: string
  outcomes: Array<{
    id: string
    label_en: string
    label_fr: string
  }>
  budgetYears: Array<{
    id: string
    stream_budget_id?: string | null
    fiscal_year_id: string
    fiscal_year_display: string
    program_funding: AllocationMoney
    paid_amount: AllocationMoney
    remaining_funding: AllocationMoney
  }>
  codingPaidAmounts: Array<{ agencyChartOfAccountId: string; agencyFiscalYearId: string; paidAmount: AllocationMoney; labelEn?: string; labelFr?: string; fiscalYearDisplay?: string }>
  hasPendingEffects: boolean
  versions: CostAllocationVersion[]
  allocations: VersionedOutcomeAllocationInput[]
  streamCommitments: Array<{
    id: string
    stream_budget_id: string
    agency_chart_of_account_id: string
    fiscal_year_id: string
    fiscal_year_display: string
    label_en?: string
    label_fr?: string
    gl?: number
    gl_description?: string
  }>
  commitmentTypes: Array<{ id: string, label_en: string, label_fr: string }>
}

/**
 * Formats exact allocated cents in the owning denomination.
 * @param value - Canonical allocated money.
 * @param language - Current interface locale.
 * @param currency - Owning Agreement denomination.
 * @returns Localized currency text without numeric coercion.
 */
export const formatCurrencyAmount = (value: AllocationMoney, language: string, currency: string) => {
  const [integer = '0', fraction = '00'] = value.split('.')
  const units = integer === '-0' ? -0 : BigInt(integer)
  return new Intl.NumberFormat(language, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2
  }).formatToParts(units).map(part => part.type === 'fraction' ? fraction : part.value).join('')
}
