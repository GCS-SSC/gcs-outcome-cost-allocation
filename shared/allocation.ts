/* eslint-disable jsdoc/require-jsdoc */
export const EXTENSION_KEY = 'gcs-outcome-cost-allocation'

export const COMMITMENT_TYPES = ['commitment', 'paye', 'paye2', 'pyp'] as const
export type CommitmentType = typeof COMMITMENT_TYPES[number]

export const ALLOCATION_METHODS = ['amount', 'percentage'] as const
export type AllocationMethod = typeof ALLOCATION_METHODS[number]

export interface OutcomeAllocationInput {
  agreementBudgetFiscalYearId: string
  outcomeId: string
  allocationMethod: AllocationMethod
  allocationValue: number
}

export interface OutcomeAllocationResolved extends OutcomeAllocationInput {
  amount: number
}

export interface YearFundingTotal {
  agreementBudgetFiscalYearId: string
  programFunding: number
}

export interface StreamCommitmentMapping {
  commitmentType: CommitmentType
  outcomeId: string
  streamBudgetId: string
  streamCommitmentId: string
}

export interface OutcomeCostAllocationConfig {
  enabledCommitmentTypes: CommitmentType[]
  mappings: StreamCommitmentMapping[]
}

export interface AllocationValidationIssue {
  code: string
  path: string
  message: string
}

export const isCommitmentType = (value: unknown): value is CommitmentType =>
  typeof value === 'string' && COMMITMENT_TYPES.includes(value as CommitmentType)

export const toMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100

export const parseOutcomeCostAllocationConfig = (value: unknown): OutcomeCostAllocationConfig => {
  if (!value || typeof value !== 'object') {
    return {
      enabledCommitmentTypes: [],
      mappings: []
    }
  }

  const source = value as Record<string, unknown>
  const enabledCommitmentTypes = Array.isArray(source.enabledCommitmentTypes)
    ? source.enabledCommitmentTypes.filter(isCommitmentType)
    : []

  const mappings = Array.isArray(source.mappings)
    ? source.mappings.flatMap(item => {
        if (!item || typeof item !== 'object') {
          return []
        }

        const mapping = item as Record<string, unknown>
        if (!isCommitmentType(mapping.commitmentType)) {
          return []
        }

        const outcomeId = typeof mapping.outcomeId === 'string' ? mapping.outcomeId : ''
        const streamBudgetId = typeof mapping.streamBudgetId === 'string' ? mapping.streamBudgetId : ''
        const streamCommitmentId = typeof mapping.streamCommitmentId === 'string' ? mapping.streamCommitmentId : ''
        if (!outcomeId || !streamBudgetId || !streamCommitmentId) {
          return []
        }

        return [{
          commitmentType: mapping.commitmentType,
          outcomeId,
          streamBudgetId,
          streamCommitmentId
        }]
      })
    : []

  return {
    enabledCommitmentTypes,
    mappings
  }
}

export const validateAllocationTotals = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[],
  activeOutcomeIds: Set<string>
): AllocationValidationIssue[] => {
  const issues: AllocationValidationIssue[] = []
  const totalsByYearId = new Map(yearTotals.map(total => [total.agreementBudgetFiscalYearId, total.programFunding]))
  const allocationsByYearId = new Map<string, OutcomeAllocationInput[]>()

  for (const [index, allocation] of allocations.entries()) {
    if (!activeOutcomeIds.has(allocation.outcomeId)) {
      issues.push({
        code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME',
        path: `allocations.${index}.outcomeId`,
        message: 'apiErrors.extensions.outcome_cost_allocation.stale_outcome'
      })
    }

    if (!totalsByYearId.has(allocation.agreementBudgetFiscalYearId)) {
      issues.push({
        code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR',
        path: `allocations.${index}.agreementBudgetFiscalYearId`,
        message: 'apiErrors.extensions.outcome_cost_allocation.stale_budget_year'
      })
    }

    const current = allocationsByYearId.get(allocation.agreementBudgetFiscalYearId) ?? []
    current.push(allocation)
    allocationsByYearId.set(allocation.agreementBudgetFiscalYearId, current)
  }

  for (const total of yearTotals) {
    const yearAllocations = allocationsByYearId.get(total.agreementBudgetFiscalYearId) ?? []
    if (yearAllocations.length === 0) {
      issues.push({
        code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
        path: `years.${total.agreementBudgetFiscalYearId}`,
        message: 'apiErrors.extensions.outcome_cost_allocation.year_missing'
      })
      continue
    }

    const methods = new Set(yearAllocations.map(allocation => allocation.allocationMethod))
    if (methods.size > 1) {
      issues.push({
        code: 'GCS_OUTCOME_COST_ALLOCATION_MIXED_METHODS',
        path: `years.${total.agreementBudgetFiscalYearId}`,
        message: 'apiErrors.extensions.outcome_cost_allocation.mixed_methods'
      })
      continue
    }

    const method = yearAllocations[0]?.allocationMethod
    const sum = toMoney(yearAllocations.reduce((value, allocation) => value + allocation.allocationValue, 0))
    const expected = method === 'percentage' ? 100 : toMoney(total.programFunding)
    if (Math.abs(sum - expected) > 0.01) {
      issues.push({
        code: method === 'percentage'
          ? 'GCS_OUTCOME_COST_ALLOCATION_PERCENTAGE_TOTAL_INVALID'
          : 'GCS_OUTCOME_COST_ALLOCATION_AMOUNT_TOTAL_INVALID',
        path: `years.${total.agreementBudgetFiscalYearId}`,
        message: method === 'percentage'
          ? 'apiErrors.extensions.outcome_cost_allocation.percentage_total_invalid'
          : 'apiErrors.extensions.outcome_cost_allocation.amount_total_invalid'
      })
    }
  }

  return issues
}

export const resolveAllocationAmounts = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[]
): OutcomeAllocationResolved[] => {
  const totalsByYearId = new Map(yearTotals.map(total => [total.agreementBudgetFiscalYearId, total.programFunding]))
  const percentageAllocationsByYearId = new Map<string, OutcomeAllocationInput[]>()
  const resolved: OutcomeAllocationResolved[] = []

  for (const allocation of allocations) {
    if (allocation.allocationMethod === 'amount') {
      resolved.push({
        ...allocation,
        amount: toMoney(allocation.allocationValue)
      })
      continue
    }

    const current = percentageAllocationsByYearId.get(allocation.agreementBudgetFiscalYearId) ?? []
    current.push(allocation)
    percentageAllocationsByYearId.set(allocation.agreementBudgetFiscalYearId, current)
  }

  for (const [yearId, yearAllocations] of percentageAllocationsByYearId.entries()) {
    const total = totalsByYearId.get(yearId) ?? 0
    let allocated = 0

    yearAllocations.forEach((allocation, index) => {
      const isLast = index === yearAllocations.length - 1
      const amount = isLast
        ? toMoney(total - allocated)
        : toMoney(total * allocation.allocationValue / 100)
      allocated = toMoney(allocated + amount)
      resolved.push({
        ...allocation,
        amount
      })
    })
  }

  return resolved
}

export const validateCommitmentMappings = (
  commitmentType: CommitmentType,
  allocations: OutcomeAllocationResolved[],
  config: OutcomeCostAllocationConfig,
  streamBudgetIdsByAgreementBudgetFiscalYearId: Map<string, string>,
  activeStreamCommitmentIds: Set<string>
): AllocationValidationIssue[] => {
  const issues: AllocationValidationIssue[] = []
  const mappingKeys = new Set(config.mappings
    .filter(mapping => mapping.commitmentType === commitmentType)
    .map(mapping => `${mapping.outcomeId}:${mapping.streamBudgetId}:${mapping.streamCommitmentId}`))

  allocations
    .filter(allocation => allocation.amount > 0)
    .forEach((allocation, index) => {
      const streamBudgetId = streamBudgetIdsByAgreementBudgetFiscalYearId.get(allocation.agreementBudgetFiscalYearId)
      if (!streamBudgetId) {
        issues.push({
          code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_BUDGET_MISSING',
          path: `allocations.${index}.agreementBudgetFiscalYearId`,
          message: 'apiErrors.extensions.outcome_cost_allocation.stream_budget_missing'
        })
        return
      }

      const mapping = config.mappings.find(candidate =>
        candidate.commitmentType === commitmentType
        && candidate.outcomeId === allocation.outcomeId
        && candidate.streamBudgetId === streamBudgetId
      )

      if (!mapping || !mappingKeys.has(`${allocation.outcomeId}:${streamBudgetId}:${mapping.streamCommitmentId}`)) {
        issues.push({
          code: 'GCS_OUTCOME_COST_ALLOCATION_MAPPING_MISSING',
          path: `allocations.${index}.outcomeId`,
          message: 'apiErrors.extensions.outcome_cost_allocation.mapping_missing'
        })
        return
      }

      if (!activeStreamCommitmentIds.has(mapping.streamCommitmentId)) {
        issues.push({
          code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE',
          path: `allocations.${index}.outcomeId`,
          message: 'apiErrors.extensions.outcome_cost_allocation.stream_commitment_inactive'
        })
      }
    })

  return issues
}
