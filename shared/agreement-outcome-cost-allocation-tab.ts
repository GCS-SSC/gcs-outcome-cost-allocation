import type { Ref } from 'vue'
import {
  type CommitmentType,
  type CostAllocationVersion,
  type VersionedOutcomeAllocationInput
} from './allocation'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface ToastLike {
  add: (notification: { title: string, description: string, color: 'error' | 'success' }) => void
}

export interface CompleteOutcomeAllocationSelectedVersionOptions {
  isCompleting: Ref<boolean>
  hasPendingMutation: boolean
  canEditSelectedVersion: boolean
  selectedVersionId: string
  validationIssueCount: number
  validationMessage: string
  locale: string
  saveError: Ref<string>
  allocations: VersionedOutcomeAllocationInput[]
  refresh: () => Promise<void>
  buildCompleteRequestUrl: (versionId: string) => RequestInfo | URL
  toast: ToastLike
  completeRequest?: (
    requestUrl: RequestInfo | URL,
    allocations: VersionedOutcomeAllocationInput[]
  ) => Promise<void>
}

export interface ConfiguredAssociationRow {
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

/**
 * Preserves an available selection, otherwise preferring a draft, active, then first version.
 */
export const resolveSelectedOutcomeAllocationVersionId = (
  currentVersionId: string,
  availableVersions: CostAllocationVersion[]
) => {
  if (currentVersionId && availableVersions.some((version: CostAllocationVersion) => version.id === currentVersionId)) {
    return currentVersionId
  }

  return availableVersions.find((version: CostAllocationVersion) => version.status === 'draft')?.id
    ?? availableVersions.find((version: CostAllocationVersion) => version.status === 'active')?.id
    ?? availableVersions[0]?.id
    ?? ''
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
      programFunding: 0
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
 * Selects the created draft id when returned, otherwise preserving the current version id.
 */
export const resolveCreatedDraftVersionId = (
  currentVersionId: string,
  response: { version?: CostAllocationVersion }
) => response.version?.id ? response.version.id : currentVersionId

/**
 * Clears the selected id only when the deleted draft was selected.
 */
export const resolveDeletedDraftVersionId = (
  currentVersionId: string,
  deletedVersionId: string
) => currentVersionId === deletedVersionId ? '' : currentVersionId

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
 * Completes an allocation version and throws the server-provided message for a non-success response.
 */
export const completeOutcomeAllocationVersionRequest = async (
  requestUrl: RequestInfo | URL,
  allocations: VersionedOutcomeAllocationInput[],
  fetcher: Fetcher = fetch
) => {
  const response = await fetcher(requestUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allocations })
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
 * Runs the selected outcome allocation version completion flow.
 *
 * @param options - Completion state, callbacks, and UI dependencies.
 */
export const completeOutcomeAllocationSelectedVersion = async (
  options: CompleteOutcomeAllocationSelectedVersionOptions
) => {
  if (
    options.isCompleting.value
    || options.hasPendingMutation
    || !options.canEditSelectedVersion
    || !options.selectedVersionId
  ) {
    return
  }

  if (options.validationIssueCount > 0) {
    options.toast.add({
      title: getOutcomeAllocationToastText(options.locale, 'error').title,
      description: options.validationMessage,
      color: 'error'
    })
    return
  }

  try {
    options.isCompleting.value = true
    options.saveError.value = ''
    await (options.completeRequest ?? completeOutcomeAllocationVersionRequest)(
      options.buildCompleteRequestUrl(options.selectedVersionId),
      options.allocations
    )
    await options.refresh()
    options.toast.add({
      ...getOutcomeAllocationToastText(options.locale, 'submitted'),
      color: 'success'
    })
  } catch (error: unknown) {
    options.saveError.value = error instanceof Error ? error.message : String(error)
    options.toast.add({
      title: getOutcomeAllocationToastText(options.locale, 'error').title,
      description: options.saveError.value,
      color: 'error'
    })
  } finally {
    options.isCompleting.value = false
  }
}

/**
 * Returns the locale-selected title and description for allocation save, activation, deletion, or error feedback.
 */
export const getOutcomeAllocationToastText = (
  locale: string,
  key: 'saved' | 'submitted' | 'deleted' | 'error'
) => {
  const labels = {
    saved: {
      title: locale === 'fr' ? 'Succes' : 'Success',
      description: locale === 'fr' ? 'Repartition enregistree.' : 'Allocation saved.'
    },
    submitted: {
      title: locale === 'fr' ? 'Succes' : 'Success',
      description: locale === 'fr' ? 'Repartition soumise au processus d approbation.' : 'Cost allocation submitted for approval.'
    },
    deleted: {
      title: locale === 'fr' ? 'Succes' : 'Success',
      description: locale === 'fr' ? 'Brouillon supprime.' : 'Draft allocation deleted.'
    },
    error: {
      title: locale === 'fr' ? 'Erreur' : 'Error',
      description: ''
    }
  }

  return labels[key]
}
