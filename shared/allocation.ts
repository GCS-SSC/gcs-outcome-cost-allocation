export const EXTENSION_KEY = 'gcs-outcome-cost-allocation'

export const COMMITMENT_TYPES = ['commitment', 'paye', 'paye2', 'pyp'] as const
export type CommitmentType = typeof COMMITMENT_TYPES[number]

export const ALLOCATION_METHODS = ['amount', 'percentage'] as const
export type AllocationMethod = typeof ALLOCATION_METHODS[number]
export const ALLOCATION_VERSION_STATUSES = ['draft', 'active', 'inactive'] as const
export type AllocationVersionStatus = typeof ALLOCATION_VERSION_STATUSES[number]

export const EXACT_NUMERIC_19_4_MAX = 900_719_925_474.0991

/**
 * Converts a non-negative scale-four decimal to exact units when it fits a safe JavaScript integer.
 */
export const toExactNumeric19Scale4Units = (value: unknown): bigint | null => {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null
  }

  const numericText = typeof value === 'string' ? value.trim() : String(value)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(numericText)
  if (!match) {
    return null
  }

  const integerDigits = (match[1] ?? '').replace(/^0+/, '') || '0'
  const fractionDigits = match[2] ?? ''
  if (integerDigits.length > 15 || fractionDigits.length > 4) {
    return null
  }

  const scaledUnits = BigInt(`${integerDigits}${fractionDigits.padEnd(4, '0')}`)
  return scaledUnits > BigInt(Number.MAX_SAFE_INTEGER) ? null : scaledUnits
}

/**
 * Parses a non-negative scale-four decimal only when its scaled units fit a safe JavaScript integer.
 */
export const parseExactNumeric19Scale4 = (value: unknown): number | null => {
  if (toExactNumeric19Scale4Units(value) === null) {
    return null
  }

  const parsed = Number(typeof value === 'string' ? value.trim() : value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export interface OutcomeAllocationInput {
  commitmentType?: CommitmentType
  streamCommitmentId: string
  agreementBudgetFiscalYearId: string
  outcomeId: string
  allocationMethod: AllocationMethod
  allocationValue: number
}

export interface VersionedOutcomeAllocationInput extends OutcomeAllocationInput {
  allocationVersionId: string
  resolvedAmount?: number | null
  fundingBasisAmount?: number | null
  outcomeLabelEn?: string | null
  outcomeLabelFr?: string | null
  commitmentLabelEn?: string | null
  commitmentLabelFr?: string | null
  fiscalYearDisplay?: string | null
}

export interface CostAllocationVersion {
  id: string
  agreementId: string
  status: AllocationVersionStatus
  versionNumber: number
  createdAt?: string | null
  completedAt?: string | null
  fundingBasisAmount?: number | null
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
  commitmentLineId: string
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

type PaymentLineAllocationCandidate = PaymentLineAllocationInput

const BIGINT_ZERO = BigInt(0)
const BIGINT_ONE = BigInt(1)
const BIGINT_TWO = BigInt(2)
const PERCENTAGE_DENOMINATOR = BigInt(1_000_000)

/**
 * Checks whether a value is one of the commitment types supported by allocation generation.
 */
export const isCommitmentType = (value: unknown): value is CommitmentType =>
  typeof value === 'string' && COMMITMENT_TYPES.includes(value as CommitmentType)

/**
 * Converts a finite decimal number to a rounded scaled integer without binary half-cent drift.
 */
const decimalToScaledBigInt = (value: number, scale: number): bigint => {
  if (!Number.isFinite(value)) {
    return BIGINT_ZERO
  }

  const sign = value < 0 ? -BIGINT_ONE : BIGINT_ONE
  const [coefficient = '0', exponentText = '0'] = Math.abs(value).toString().toLowerCase().split('e')
  const [integerPart = '0', fractionPart = ''] = coefficient.split('.')
  const exponent = Number(exponentText)
  const digits = `${integerPart}${fractionPart}`
  const decimalPosition = integerPart.length + exponent
  const normalized = decimalPosition <= 0
    ? `${'0'.repeat(-decimalPosition)}${digits}`
    : `${digits}${'0'.repeat(Math.max(0, decimalPosition - digits.length))}`
  const scaledPosition = decimalPosition + scale
  const wholeDigits = scaledPosition <= 0
    ? '0'
    : normalized.slice(0, scaledPosition).padEnd(scaledPosition, '0') || '0'
  const roundingDigit = scaledPosition < 0
    ? '0'
    : normalized[scaledPosition] ?? '0'
  const rounded = BigInt(wholeDigits) + (roundingDigit >= '5' ? BIGINT_ONE : BIGINT_ZERO)

  return sign * rounded
}

/**
 * Converts a finite decimal number to a rounded scaled integer.
 */
const decimalToScaledInteger = (value: number, scale: number): number => {
  const scaled = decimalToScaledBigInt(value, scale)
  return scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(Number.MIN_SAFE_INTEGER)
    ? 0
    : Number(scaled)
}

/**
 * Rounds a numeric amount to the nearest cent.
 */
export const toMoney = (value: number): number => decimalToScaledInteger(value, 2) / 100

/**
 * Converts a monetary value to an integer number of cents.
 */
export const toCents = (value: number): number => decimalToScaledInteger(value, 2)

/**
 * Converts an integer number of cents to a monetary value.
 */
export const fromCents = (value: number): number => value / 100

/**
 * Keeps valid commitment types and complete mapping records from an unknown extension config.
 */
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

/**
 * Reports allocations that reference outcomes or agreement budget years outside the active sets.
 */
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

/**
 * Combines reference issues with an agreement-level check that resolved allocations equal total program funding.
 */
export const validateAllocationTotals = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[],
  activeOutcomeIds: Set<string>
): AllocationValidationIssue[] => {
  const issues: AllocationValidationIssue[] = validateAllocationReferences(allocations, yearTotals, activeOutcomeIds)
  const allocatedTotalCents = resolveAllocationAmounts(allocations, yearTotals)
    .reduce((sum, allocation) => sum + BigInt(toCents(allocation.amount)), BIGINT_ZERO)
  const agreementBudgetTotalCents = yearTotals
    .reduce((sum, total) => sum + BigInt(toCents(total.programFunding)), BIGINT_ZERO)
  const agreementBudgetScale4Units = yearTotals.reduce(
    (sum, total) => sum + (toExactNumeric19Scale4Units(total.programFunding) ?? BIGINT_ZERO),
    BIGINT_ZERO
  )
  if (allocatedTotalCents !== agreementBudgetTotalCents) {
    issues.push({
      code: 'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID',
      path: 'allocations',
      message: 'apiErrors.extensions.outcome_cost_allocation.total_invalid'
    })
  }
  if (agreementBudgetScale4Units > BigInt(Number.MAX_SAFE_INTEGER)) {
    issues.push({
      code: 'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID',
      path: 'allocations',
      message: 'apiErrors.extensions.outcome_cost_allocation.total_invalid'
    })
  }

  return issues
}

const stableAllocationCoordinate = (
  allocation: OutcomeAllocationInput | undefined
): string => allocation
  ? [
      allocation.commitmentType ?? 'commitment',
      allocation.agreementBudgetFiscalYearId,
      allocation.outcomeId,
      allocation.streamCommitmentId
    ].join(':')
  : ''

/**
 * Resolves amount allocations directly and percentage allocations against their agreement-year funding total.
 */
export const resolveAllocationAmounts = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[]
): OutcomeAllocationResolved[] => {
  const totalsByYearId = new Map(yearTotals.map(total => [
    total.agreementBudgetFiscalYearId,
    toCents(total.programFunding)
  ]))
  const resolvedCents = allocations.map(allocation =>
    allocation.allocationMethod === 'amount' ? toCents(allocation.allocationValue) : 0
  )
  const percentageIndexesByYearId = new Map<string, number[]>()

  allocations.forEach((allocation, index) => {
    if (allocation.allocationMethod !== 'percentage') {
      return
    }

    const indexes = percentageIndexesByYearId.get(allocation.agreementBudgetFiscalYearId) ?? []
    indexes.push(index)
    percentageIndexesByYearId.set(allocation.agreementBudgetFiscalYearId, indexes)
  })

  for (const [yearId, indexes] of percentageIndexesByYearId) {
    const fundingCents = BigInt(totalsByYearId.get(yearId) ?? 0)
    const denominator = PERCENTAGE_DENOMINATOR
    const shares = indexes.map(index => {
      const allocation = allocations[index]
      const percentageUnits = decimalToScaledBigInt(allocation?.allocationValue ?? 0, 4)
      const numerator = fundingCents * percentageUnits
      return {
        index,
        cents: numerator / denominator,
        remainder: numerator % denominator,
        numerator
      }
    })
    const totalNumerator = shares.reduce((sum, share) => sum + share.numerator, BIGINT_ZERO)
    const targetCents = totalNumerator / denominator
      + (totalNumerator % denominator >= denominator / BIGINT_TWO ? BIGINT_ONE : BIGINT_ZERO)
    const floorCents = shares.reduce((sum, share) => sum + share.cents, BIGINT_ZERO)
    let residualCents = Number(targetCents - floorCents)

    shares
      .sort((left, right) => {
        if (left.remainder === right.remainder) {
          const leftCoordinate = stableAllocationCoordinate(allocations[left.index])
          const rightCoordinate = stableAllocationCoordinate(allocations[right.index])
          if (leftCoordinate === rightCoordinate) {
            return left.index - right.index
          }
          return leftCoordinate < rightCoordinate ? -1 : 1
        }
        return left.remainder > right.remainder ? -1 : 1
      })
      .forEach(share => {
        const balancedCents = share.cents + (residualCents > 0 ? BIGINT_ONE : BIGINT_ZERO)
        resolvedCents[share.index] = Number(balancedCents)
        residualCents = Math.max(0, residualCents - 1)
      })
  }

  return allocations.map((allocation, index) => ({
    ...allocation,
    amount: fromCents(resolvedCents[index] ?? 0)
  }))
}

/**
 * Validates positive allocations against stream budgets, configured mappings, and active stream commitments.
 */
export const validateCommitmentMappings = (
  commitmentType: CommitmentType,
  allocations: OutcomeAllocationResolved[],
  config: OutcomeCostAllocationConfig,
  streamBudgetIdsByAgreementBudgetFiscalYearId: Map<string, string>,
  activeStreamCommitmentBudgetIds: Map<string, string>
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

      const activeStreamCommitmentBudgetId = activeStreamCommitmentBudgetIds.get(mapping.streamCommitmentId)
      if (!activeStreamCommitmentBudgetId) {
        issues.push({
          code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE',
          path: `allocations.${index}.outcomeId`,
          message: 'apiErrors.extensions.outcome_cost_allocation.stream_commitment_inactive'
        })
        return
      }

      if (activeStreamCommitmentBudgetId !== streamBudgetId) {
        issues.push({
          code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH',
          path: `allocations.${index}.streamCommitmentId`,
          message: 'apiErrors.extensions.outcome_cost_allocation.stream_commitment_budget_mismatch'
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

/**
 * Aggregates generated and paid lines by commitment coordinates and reports payments exceeding generated coverage.
 */
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

  const paidAmountByKey = new Map<string, { index: number, paidAmount: number }>()
  for (const [index, line] of paidLines.entries()) {
    const key = commitmentLineCoverageKey(line)
    const existing = paidAmountByKey.get(key) ?? { index, paidAmount: 0 }
    paidAmountByKey.set(key, {
      ...existing,
      paidAmount: toMoney(existing.paidAmount + line.paidAmount)
    })
  }

  return Array.from(paidAmountByKey.entries()).flatMap(([key, paidLine]) => {
    const generatedAmount = generatedAmountByKey.get(key) ?? 0
    if (toCents(paidLine.paidAmount) <= toCents(generatedAmount)) {
      return []
    }

    return [{
      code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE',
      path: `paidCommitmentLines.${paidLine.index}`,
      message: 'apiErrors.extensions.outcome_cost_allocation.payment_exceeds_generated_line'
    }]
  })
}

const normalizePaymentLineAllocationCandidates = (
  lines: PaymentLineAllocationInput[]
): PaymentLineAllocationCandidate[] => lines
  .map(line => ({
    ...line,
    weightAmount: toMoney(line.weightAmount),
    remainingAmount: toMoney(line.remainingAmount)
  }))
  .filter(line => line.weightAmount > 0 && line.remainingAmount > 0)

const canAllocatePaymentAmount = (
  candidates: PaymentLineAllocationCandidate[],
  amountToAllocate: number
) => {
  const totalRemainingCents = candidates.reduce((sum, line) => sum + toCents(line.remainingAmount), 0)
  const amountToAllocateCents = toCents(amountToAllocate)
  return amountToAllocateCents > 0
    && totalRemainingCents > 0
    && amountToAllocateCents <= totalRemainingCents
}

const recordPaymentLineAllocation = (
  allocatedByLineId: Map<string, PaymentLineAllocationResolved>,
  line: PaymentLineAllocationCandidate,
  paymentLineAmount: number
) => {
  const existing = allocatedByLineId.get(line.commitmentLineId)
  allocatedByLineId.set(line.commitmentLineId, {
    ...(existing ?? line),
    paymentAmount: toMoney((existing?.paymentAmount ?? 0) + paymentLineAmount)
  })
}

/**
 * Allocates one weighted round, capping each line at its remaining amount and carrying eligible remainders forward.
 */
const allocatePaymentRound = (
  candidates: PaymentLineAllocationCandidate[],
  remainingPaymentCents: number,
  allocatedByLineId: Map<string, PaymentLineAllocationResolved>
) => {
  const totalWeightCents = candidates.reduce(
    (sum, line) => sum + BigInt(toCents(line.weightAmount)),
    BIGINT_ZERO
  )
  if (totalWeightCents <= BIGINT_ZERO) {
    return {
      roundAllocatedCents: 0,
      roundRemainingCents: remainingPaymentCents,
      nextCandidates: []
    }
  }

  const roundStartCents = remainingPaymentCents
  let roundRemainingCents = remainingPaymentCents
  const nextCandidates: PaymentLineAllocationCandidate[] = []
  for (const [index, line] of candidates.entries()) {
    const isLastLine = index === candidates.length - 1
    const lineWeightCents = BigInt(toCents(line.weightAmount))
    const lineRemainingCents = toCents(line.remainingAmount)
    const targetCents = isLastLine
      ? roundRemainingCents
      : Number(
          (
            BigInt(roundStartCents) * lineWeightCents
            + totalWeightCents / BIGINT_TWO
          ) / totalWeightCents
        )
    const paymentLineCents = Math.min(targetCents, lineRemainingCents, roundRemainingCents)
    if (paymentLineCents <= 0) {
      nextCandidates.push(line)
      continue
    }

    recordPaymentLineAllocation(allocatedByLineId, line, fromCents(paymentLineCents))
    roundRemainingCents -= paymentLineCents
    const nextRemainingCents = lineRemainingCents - paymentLineCents
    if (nextRemainingCents > 0) {
      nextCandidates.push({
        ...line,
        remainingAmount: fromCents(nextRemainingCents)
      })
    }
  }

  return {
    roundAllocatedCents: roundStartCents - roundRemainingCents,
    roundRemainingCents,
    nextCandidates
  }
}

/**
 * Distributes a valid payment proportionally across positive line weights without exceeding any line remainder.
 */
export const allocatePaymentAmountToCommitmentLines = (
  lines: PaymentLineAllocationInput[],
  paymentAmount: number
): PaymentLineAllocationResolved[] => {
  let candidates = normalizePaymentLineAllocationCandidates(lines)
  const amountToAllocate = toMoney(paymentAmount)
  if (!canAllocatePaymentAmount(candidates, amountToAllocate)) {
    return []
  }

  let remainingPaymentCents = toCents(amountToAllocate)
  const allocatedByLineId = new Map<string, PaymentLineAllocationResolved>()

  while (remainingPaymentCents > 0 && candidates.length > 0) {
    const round = allocatePaymentRound(candidates, remainingPaymentCents, allocatedByLineId)
    if (round.roundAllocatedCents <= 0) {
      break
    }

    remainingPaymentCents = round.roundRemainingCents
    candidates = round.nextCandidates
  }

  return Array.from(allocatedByLineId.values())
}
