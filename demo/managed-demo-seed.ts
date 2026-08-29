import { EXTENSION_KEY, parseOutcomeCostAllocationConfig } from '../shared/allocation.ts'

export const MANAGED_DEMO_AGREEMENT_TITLE = 'Health Canada Cost Agreement 1 - Showcase'
export const ALLOCATION_VERSION_ENTITY_TYPE = `${EXTENSION_KEY}:allocation-version`

export interface ManagedDemoResponse {
  json: () => Promise<unknown>
  ok: () => boolean
  status: () => number
  text: () => Promise<string>
}

export interface ManagedDemoRequest {
  get: (url: string) => Promise<ManagedDemoResponse>
  post: (url: string, options?: { data?: unknown }) => Promise<ManagedDemoResponse>
  put: (url: string, options?: { data?: unknown }) => Promise<ManagedDemoResponse>
}

type AgreementCollection = {
  items: Array<{ id: string | number, egcs_fc_title_en: string }>
}

type EntityTabsResponse = {
  items: Array<{ extensionKey: string, config: unknown }>
}

export type ManagedDemoAllocationResponse = {
  outcomes: Array<{ id: string | number }>
  budgetYears: Array<{
    id: string
    stream_budget_id?: string | number | null
    program_funding: number | string
  }>
  versions: Array<{
    id: string
    status: 'draft' | 'active' | 'inactive'
    versionNumber: number
  }>
  allocations: unknown[]
  streamCommitments: Array<{ id: string | number }>
}

type CreatedVersionResponse = {
  version: { id: string, versionNumber: number }
}

const readJson = async <T>(response: ManagedDemoResponse, operation: string): Promise<T> => {
  if (!response.ok()) {
    throw new Error(`${operation} failed with ${response.status()}: ${await response.text()}`)
  }
  return await response.json() as T
}

/** Finds the exact Agreement provided by the host-managed demo migration. */
export const findManagedDemoAgreement = async (request: ManagedDemoRequest): Promise<string> => {
  const query = new URLSearchParams({
    page: '1',
    limit: '10',
    search: MANAGED_DEMO_AGREEMENT_TITLE
  })
  const agreements = await readJson<AgreementCollection>(
    await request.get(`/api/agreements?${query.toString()}`),
    'Managed demo Agreement lookup'
  )
  const matches = agreements.items.filter(agreement =>
    agreement.egcs_fc_title_en === MANAGED_DEMO_AGREEMENT_TITLE
  )
  if (matches.length !== 1) {
    throw new Error(`Expected one managed demo Agreement, found ${matches.length}.`)
  }
  return String(matches[0]!.id)
}

/** Proves production extension migrations created schema only and no OCA business rows. */
export const assertManagedDemoProductionBaseline = async (
  request: ManagedDemoRequest,
  agreementId: string
): Promise<ManagedDemoAllocationResponse> => {
  const response = await readJson<ManagedDemoAllocationResponse>(
    await request.get(`/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocations`),
    'Production OCA baseline lookup'
  )
  if (response.versions.length !== 0 || response.allocations.length !== 0) {
    throw new Error('Production OCA migrations must not create allocation business rows.')
  }
  return response
}

/**
 * Creates the OCA showcase only after managed startup, through the same extension and host lifecycle APIs as a user.
 */
export const seedManagedOutcomeCostAllocationDemo = async (
  request: ManagedDemoRequest,
  agreementId: string
): Promise<{ agreementId: string, versionId: string, versionNumber: number }> => {
  const baseline = await assertManagedDemoProductionBaseline(request, agreementId)
  const tabs = await readJson<EntityTabsResponse>(
    await request.get(`/api/extensions/entity-tabs?target=agreement&agreementId=${encodeURIComponent(agreementId)}`),
    'Managed demo extension configuration lookup'
  )
  const tab = tabs.items.find(item => item.extensionKey === EXTENSION_KEY)
  if (!tab) {
    throw new Error('Outcome cost allocation is not enabled for the managed demo Agreement.')
  }
  const config = parseOutcomeCostAllocationConfig(tab.config)
  const activeOutcomeIds = new Set(baseline.outcomes.map(outcome => String(outcome.id)))
  const activeCommitmentIds = new Set(baseline.streamCommitments.map(commitment => String(commitment.id)))
  const allocations = baseline.budgetYears
    .filter(year => Number(year.program_funding) > 0)
    .map(year => {
      const streamBudgetId = String(year.stream_budget_id ?? '')
      const mapping = config.mappings.find(candidate =>
        config.enabledCommitmentTypes.includes(candidate.commitmentType)
        && candidate.streamBudgetId === streamBudgetId
        && activeOutcomeIds.has(candidate.outcomeId)
        && activeCommitmentIds.has(candidate.streamCommitmentId)
      )
      if (!mapping) {
        throw new Error(`Managed demo OCA mapping is unavailable for budget year ${year.id}.`)
      }
      return {
        commitmentType: mapping.commitmentType,
        streamCommitmentId: mapping.streamCommitmentId,
        agreementBudgetFiscalYearId: String(year.id),
        outcomeId: mapping.outcomeId,
        allocationMethod: 'amount' as const,
        allocationValue: Number(year.program_funding)
      }
    })
  if (allocations.length === 0) {
    throw new Error('Managed demo OCA requires at least one funded Agreement budget year.')
  }

  const created = await readJson<CreatedVersionResponse>(
    await request.post(`/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocation-versions`),
    'Managed demo OCA draft creation'
  )
  await readJson(
    await request.put(`/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocations`, {
      data: {
        allocationVersionId: created.version.id,
        allocations
      }
    }),
    'Managed demo OCA allocation save'
  )
  await readJson(
    await request.post('/api/completions/complete', {
      data: {
        entityType: ALLOCATION_VERSION_ENTITY_TYPE,
        entityId: created.version.id,
        comments: null
      }
    }),
    'Managed demo OCA Completion'
  )

  const completed = await readJson<ManagedDemoAllocationResponse>(
    await request.get(`/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocations`),
    'Managed demo OCA completed reload'
  )
  const activeVersion = completed.versions.find(version => version.id === created.version.id)
  if (activeVersion?.status !== 'active') {
    throw new Error('Managed demo OCA Completion did not activate the allocation version.')
  }
  const completionQuery = new URLSearchParams({
    entityType: ALLOCATION_VERSION_ENTITY_TYPE,
    entityId: created.version.id
  })
  const completion = await readJson<{ item: unknown | null }>(
    await request.get(`/api/completions/runtime?${completionQuery.toString()}`),
    'Managed demo OCA Completion evidence reload'
  )
  if (completion.item === null) {
    throw new Error('Managed demo OCA Completion evidence is missing.')
  }

  return {
    agreementId,
    versionId: created.version.id,
    versionNumber: created.version.versionNumber
  }
}
