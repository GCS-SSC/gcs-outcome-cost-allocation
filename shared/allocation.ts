/* eslint-disable jsdoc/require-jsdoc */
export const EXTENSION_KEY = 'gcs-outcome-cost-allocation'

export const COMMITMENT_TYPES = ['commitment', 'paye', 'paye2', 'pyp'] as const
export type CommitmentType = typeof COMMITMENT_TYPES[number]

export const ALLOCATION_METHODS = ['amount', 'percentage'] as const
export type AllocationMethod = typeof ALLOCATION_METHODS[number]
export const ALLOCATION_VERSION_STATUSES = ['draft', 'active', 'inactive'] as const
export type AllocationVersionStatus = typeof ALLOCATION_VERSION_STATUSES[number]

export interface OutcomeAllocationInput {
  commitmentType?: CommitmentType
  streamCommitmentId?: string
  agreementBudgetFiscalYearId: string
  outcomeId: string
  allocationMethod: AllocationMethod
  allocationValue: number
}

export interface VersionedOutcomeAllocationInput extends OutcomeAllocationInput {
  allocationVersionId: string
}

export interface CostAllocationVersion {
  id: string
  agreementId: string
  status: AllocationVersionStatus
  versionNumber: number
  createdAt?: string | null
  completedAt?: string | null
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

export interface GeneratedCommitmentLineCoverage {
  commitmentType: CommitmentType
  agreementBudgetFiscalYearId: string
  outcomeId: string
  streamCommitmentId: string
  amount: number
}

export interface PaidCommitmentLineCoverage {
  commitmentType: CommitmentType
  agreementBudgetFiscalYearId: string
  streamCommitmentId: string
  paidAmount: number
}

export interface PaymentLineAllocationInput {
  commitmentLineId: string
  weightAmount: number
  remainingAmount: number
}

export interface PaymentLineAllocationResolved extends PaymentLineAllocationInput {
  paymentAmount: number
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

export const validateAllocationReferences = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[],
  activeOutcomeIds: Set<string>
): AllocationValidationIssue[] => {
  const issues: AllocationValidationIssue[] = []
  const totalsByYearId = new Map(yearTotals.map(total => [total.agreementBudgetFiscalYearId, total.programFunding]))

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
  }

  return issues
}

export const validateAllocationTotals = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[],
  activeOutcomeIds: Set<string>
): AllocationValidationIssue[] => {
  const issues: AllocationValidationIssue[] = validateAllocationReferences(allocations, yearTotals, activeOutcomeIds)
  const totalsByYearId = new Map(yearTotals.map(total => [total.agreementBudgetFiscalYearId, total.programFunding]))
  let allocatedTotal = 0

  for (const allocation of allocations) {
    const yearTotal = totalsByYearId.get(allocation.agreementBudgetFiscalYearId) ?? 0
    if (allocation.allocationMethod === 'percentage') {
      allocatedTotal = toMoney(allocatedTotal + yearTotal * allocation.allocationValue / 100)
    } else {
      allocatedTotal = toMoney(allocatedTotal + allocation.allocationValue)
    }
  }

  const agreementBudgetTotal = toMoney(yearTotals.reduce((sum, total) => sum + total.programFunding, 0))
  if (Math.abs(toMoney(allocatedTotal) - agreementBudgetTotal) > 0.01) {
    issues.push({
      code: 'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID',
      path: 'allocations',
      message: 'apiErrors.extensions.outcome_cost_allocation.total_invalid'
    })
  }

  return issues
}

export const resolveAllocationAmounts = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[]
): OutcomeAllocationResolved[] => {
  const totalsByYearId = new Map(yearTotals.map(total => [total.agreementBudgetFiscalYearId, total.programFunding]))
  const resolved: OutcomeAllocationResolved[] = []

  for (const allocation of allocations) {
    if (allocation.allocationMethod === 'amount') {
      resolved.push({
        ...allocation,
        amount: toMoney(allocation.allocationValue)
      })
      continue
    }

    const total = totalsByYearId.get(allocation.agreementBudgetFiscalYearId) ?? 0
    resolved.push({
      ...allocation,
      amount: toMoney(total * allocation.allocationValue / 100)
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
        && (!allocation.streamCommitmentId || candidate.streamCommitmentId === allocation.streamCommitmentId)
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

const commitmentLineCoverageKey = (coverage: {
  commitmentType: CommitmentType
  agreementBudgetFiscalYearId: string
  streamCommitmentId: string
}) => [
  coverage.commitmentType,
  coverage.agreementBudgetFiscalYearId,
  coverage.streamCommitmentId
].join(':')

export const validateGeneratedCommitmentLinePaymentCoverage = (
  generatedLines: GeneratedCommitmentLineCoverage[],
  paidLines: PaidCommitmentLineCoverage[]
): AllocationValidationIssue[] => {
  const generatedAmountByKey = new Map<string, number>()
  for (const line of generatedLines) {
    const key = commitmentLineCoverageKey(line)
    const existingAmount = generatedAmountByKey.get(key) ?? 0
    generatedAmountByKey.set(key, toMoney(existingAmount + line.amount))
  }

  return paidLines.flatMap((line, index) => {
    const generatedAmount = generatedAmountByKey.get(commitmentLineCoverageKey(line)) ?? 0
    if (toMoney(line.paidAmount) <= toMoney(generatedAmount + 0.01)) {
      return []
    }

    return [{
      code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE',
      path: `paidCommitmentLines.${index}`,
      message: 'apiErrors.extensions.outcome_cost_allocation.payment_exceeds_generated_line'
    }]
  })
}

export const allocatePaymentAmountToCommitmentLines = (
  lines: PaymentLineAllocationInput[],
  paymentAmount: number
): PaymentLineAllocationResolved[] => {
  let candidates = lines
    .map(line => ({
      ...line,
      weightAmount: toMoney(line.weightAmount),
      remainingAmount: toMoney(line.remainingAmount)
    }))
    .filter(line => line.weightAmount > 0 && line.remainingAmount > 0)

  const totalRemaining = toMoney(candidates.reduce((sum, line) => sum + line.remainingAmount, 0))
  const amountToAllocate = toMoney(paymentAmount)
  if (amountToAllocate <= 0 || totalRemaining <= 0 || amountToAllocate > toMoney(totalRemaining + 0.01)) {
    return []
  }

  let remainingPaymentAmount = amountToAllocate
  const allocatedByLineId = new Map<string, PaymentLineAllocationResolved>()

  while (remainingPaymentAmount > 0.009 && candidates.length > 0) {
    const totalWeight = toMoney(candidates.reduce((sum, line) => sum + line.weightAmount, 0))
    if (totalWeight <= 0) {
      break
    }

    const roundStartAmount = remainingPaymentAmount
    let roundRemainingAmount = remainingPaymentAmount
    const nextCandidates: typeof candidates = []
    for (const [index, line] of candidates.entries()) {
      const isLastLine = index === candidates.length - 1
      const targetAmount = isLastLine
        ? roundRemainingAmount
        : toMoney(roundStartAmount * line.weightAmount / totalWeight)
      const paymentLineAmount = toMoney(Math.min(targetAmount, line.remainingAmount, roundRemainingAmount))
      if (paymentLineAmount <= 0) {
        nextCandidates.push(line)
        continue
      }

      const existing = allocatedByLineId.get(line.commitmentLineId)
      allocatedByLineId.set(line.commitmentLineId, {
        ...(existing ?? line),
        paymentAmount: toMoney((existing?.paymentAmount ?? 0) + paymentLineAmount)
      })
      roundRemainingAmount = toMoney(roundRemainingAmount - paymentLineAmount)
      const nextRemaining = toMoney(line.remainingAmount - paymentLineAmount)
      if (nextRemaining > 0) {
        nextCandidates.push({
          ...line,
          remainingAmount: nextRemaining
        })
      }
    }

    const roundAllocated = toMoney(roundStartAmount - roundRemainingAmount)
    if (roundAllocated <= 0) {
      break
    }

    remainingPaymentAmount = roundRemainingAmount
    candidates = nextCandidates
  }

  return Array.from(allocatedByLineId.values())
}
