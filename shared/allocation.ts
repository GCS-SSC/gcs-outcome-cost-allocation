export const EXTENSION_KEY = 'gcs-outcome-cost-allocation'

/** Stream-owned commitment-type identity. */
export type CommitmentType = string
/** @deprecated UI options are loaded from the stream-owned commitment-type API. */
export const COMMITMENT_TYPES: CommitmentType[] = []

export const ALLOCATION_METHODS = ['amount', 'percentage'] as const
export type AllocationMethod = typeof ALLOCATION_METHODS[number]
export const ALLOCATION_VERSION_STATUSES = ['draft', 'active', 'inactive'] as const
export type AllocationVersionStatus = typeof ALLOCATION_VERSION_STATUSES[number]

declare const allocationMoneyBrand: unique symbol
declare const allocationDecimal4Brand: unique symbol
export type AllocationMoney = string & { readonly [allocationMoneyBrand]: 'AllocationMoney' }
export type AllocationDecimal4 = string & { readonly [allocationDecimal4Brand]: 'AllocationDecimal4' }
export type AllocationDecimalInput = string | number

/** Converts a canonical non-negative numeric(19,4) value to exact scale-four units. */
export const toExactNumeric19Scale4Units = (value: unknown): bigint | null => {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null
  }

  const numericText = String(value)
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(numericText)
  if (!match) {
    return null
  }

  const integerDigits = (match[1] ?? '').replace(/^0+/, '') || '0'
  const fractionDigits = match[2] ?? ''
  if (integerDigits.length > 15 || fractionDigits.length > 4) {
    return null
  }

  const scaledUnits = BigInt(`${integerDigits}${fractionDigits.padEnd(4, '0')}`)
  return typeof value === 'number' && scaledUnits > BigInt(Number.MAX_SAFE_INTEGER) ? null : scaledUnits
}

/** Parses a canonical non-negative numeric(19,4) value. */
export const parseExactNumeric19Scale4 = (value: unknown): AllocationDecimal4 | null => {
  const units = toExactNumeric19Scale4Units(value)
  if (units === null) return null
  return fromScale4Units(units)
}

export const fromScale4Units = (units: bigint): AllocationDecimal4 => {
  const text = units.toString().padStart(5, '0')
  return `${text.slice(0, -4)}.${text.slice(-4)}` as AllocationDecimal4
}

export const parseAllocationMoney = (value: unknown): AllocationMoney | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value))
  if (!match || (match[2]?.replace(/^0+/, '').length ?? 0) > 17) return null
  const sign = match[1] === '-' ? -BIGINT_ONE : BIGINT_ONE
  const cents = sign * BigInt(`${match[2]}${(match[3] ?? '').padEnd(2, '0')}`)
  if (typeof value === 'number' && (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER))) return null
  return fromCents(cents)
}

export interface OutcomeAllocationInput {
  commitmentType?: CommitmentType
  streamCommitmentId: string
  agreementBudgetFiscalYearId: string
  outcomeId: string
  allocationMethod: AllocationMethod
  allocationValue: AllocationDecimalInput
}

export interface VersionedOutcomeAllocationInput extends OutcomeAllocationInput {
  allocationVersionId: string
  resolvedAmount?: AllocationMoney | null
  fundingBasisAmount?: AllocationMoney | null
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
  fundingBasisAmount?: AllocationMoney | null
}

export interface OutcomeAllocationResolved extends OutcomeAllocationInput {
  amount: AllocationMoney
}

export interface YearFundingTotal {
  agreementBudgetFiscalYearId: string
  /** Canonical strings are authoritative; safe numbers remain deprecated input compatibility. */
  programFunding: AllocationDecimalInput
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
  amount: AllocationDecimalInput
}

export interface PaidCommitmentLineCoverage {
  commitmentLineId: string
  commitmentType: CommitmentType
  agreementBudgetFiscalYearId: string
  streamCommitmentId: string
  paidAmount: AllocationDecimalInput
}

export interface PaymentLineAllocationInput {
  commitmentLineId: string
  weightAmount: AllocationDecimalInput
  remainingAmount: AllocationDecimalInput
}

export interface PaymentLineAllocationResolved {
  commitmentLineId: string
  weightAmount: AllocationMoney
  remainingAmount: AllocationMoney
  paymentAmount: AllocationMoney
}

type PaymentLineAllocationCandidate = Omit<PaymentLineAllocationResolved, 'paymentAmount'>

const BIGINT_ZERO = BigInt(0)
const BIGINT_ONE = BigInt(1)
const BIGINT_TWO = BigInt(2)
const PERCENTAGE_DENOMINATOR = BigInt(1_000_000)

/**
 * Checks whether a value is one of the commitment types supported by allocation generation.
 */
export const isCommitmentType = (value: unknown): value is CommitmentType =>
  typeof value === 'string' && /^\d+$/.test(value)

/**
 * Converts a finite decimal number to a rounded scaled integer without binary half-cent drift.
 */
/**
 * Rounds a numeric amount to the nearest cent.
 */
export const toMoney = (value: AllocationDecimalInput): AllocationMoney => {
  const money = parseAllocationMoney(value)
  if (money !== null) return money
  const units = toExactNumeric19Scale4Units(value) ?? BIGINT_ZERO
  return fromCents((units + 50n) / 100n)
}

/**
 * Converts a monetary value to an integer number of cents.
 */
export const toCents = (value: AllocationDecimalInput): bigint => {
  const parsed = parseAllocationMoney(value)
  if (parsed === null) return BIGINT_ZERO
  const negative = parsed.startsWith('-')
  const unsigned = negative ? parsed.slice(1) : parsed
  const [integer = '0', fraction = '00'] = unsigned.split('.')
  const cents = BigInt(`${integer}${fraction}`)
  return negative ? -cents : cents
}

/**
 * Converts an integer number of cents to a monetary value.
 */
export const fromCents = (value: bigint | number): AllocationMoney => {
  const cents = typeof value === 'bigint' ? value : BigInt(value)
  const sign = cents < BIGINT_ZERO ? '-' : ''
  const text = (cents < BIGINT_ZERO ? -cents : cents).toString().padStart(3, '0')
  return `${sign}${text.slice(0, -2)}.${text.slice(-2)}` as AllocationMoney
}

export const compareMoney = (left: AllocationDecimalInput, right: AllocationDecimalInput): number => {
  const difference = toCents(left) - toCents(right)
  return difference < BIGINT_ZERO ? -1 : difference > BIGINT_ZERO ? 1 : 0
}

export const sumMoney = (values: AllocationDecimalInput[]): AllocationMoney =>
  fromCents(values.reduce((sum, value) => sum + toCents(value), BIGINT_ZERO))

export const subtractMoney = (left: AllocationDecimalInput, right: AllocationDecimalInput): AllocationMoney =>
  fromCents(toCents(left) - toCents(right))

export const percentageForMoney = (
  amount: AllocationDecimalInput,
  funding: AllocationDecimalInput
): AllocationDecimal4 => {
  const fundingCents = toCents(funding)
  if (fundingCents <= BIGINT_ZERO) return parseExactNumeric19Scale4('0')!
  const units = (toCents(amount) * PERCENTAGE_DENOMINATOR + fundingCents / BIGINT_TWO) / fundingCents
  return fromScale4Units(units)
}

export const moneyForPercentage = (
  funding: AllocationDecimalInput,
  percentage: AllocationDecimalInput
): AllocationMoney => {
  const units = toExactNumeric19Scale4Units(percentage) ?? BIGINT_ZERO
  const numerator = toCents(funding) * units
  return fromCents(numerator / PERCENTAGE_DENOMINATOR
    + (numerator % PERCENTAGE_DENOMINATOR >= PERCENTAGE_DENOMINATOR / BIGINT_TWO ? BIGINT_ONE : BIGINT_ZERO))
}

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
  const resolvedAllocations = resolveAllocationAmounts(allocations, yearTotals)
  const allocatedTotalCents = resolvedAllocations
    .reduce((sum, allocation) => sum + toCents(allocation.amount), BIGINT_ZERO)
  const agreementBudgetTotalCents = yearTotals
    .reduce((sum, total) => sum + toCents(total.programFunding), BIGINT_ZERO)
  if (allocatedTotalCents !== agreementBudgetTotalCents) {
    issues.push({
      code: 'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID',
      path: 'allocations',
      message: 'apiErrors.extensions.outcome_cost_allocation.total_invalid'
    })
  }
  for (const total of yearTotals) {
    const allocatedYearCents = resolvedAllocations
      .filter(allocation => allocation.agreementBudgetFiscalYearId === total.agreementBudgetFiscalYearId)
      .reduce((sum, allocation) => sum + toCents(allocation.amount), BIGINT_ZERO)
    if (allocatedYearCents !== toCents(total.programFunding)) {
      issues.push({
        code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID',
        path: `allocations.${total.agreementBudgetFiscalYearId}`,
        message: 'apiErrors.extensions.outcome_cost_allocation.year_total_invalid'
      })
    }
  }
  return issues
}

/** Rejects draft values whose resolved total exceeds any individual fiscal-year budget. */
export const validateAllocationYearLimits = (
  allocations: OutcomeAllocationInput[],
  yearTotals: YearFundingTotal[]
): AllocationValidationIssue[] => {
  const resolvedAllocations = resolveAllocationAmounts(allocations, yearTotals)
  return yearTotals.flatMap(total => {
    const allocatedCents = resolvedAllocations
      .filter(allocation => allocation.agreementBudgetFiscalYearId === total.agreementBudgetFiscalYearId)
      .reduce((sum, allocation) => sum + BigInt(toCents(allocation.amount)), BIGINT_ZERO)
    return allocatedCents > toCents(total.programFunding)
      ? [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED',
          path: `allocations.${total.agreementBudgetFiscalYearId}`,
          message: 'apiErrors.extensions.outcome_cost_allocation.year_total_exceeded'
        }]
      : []
  })
}

const stableAllocationCoordinate = (
  allocation: OutcomeAllocationInput | undefined
): string => allocation
  ? [
      allocation.commitmentType ?? '',
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
    allocation.allocationMethod === 'amount'
      ? ((toExactNumeric19Scale4Units(allocation.allocationValue) ?? BIGINT_ZERO) + 50n) / 100n
      : BIGINT_ZERO
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
    const fundingCents = totalsByYearId.get(yearId) ?? BIGINT_ZERO
    const denominator = PERCENTAGE_DENOMINATOR
    const shares = indexes.map(index => {
      const allocation = allocations[index]
      const percentageUnits = toExactNumeric19Scale4Units(allocation?.allocationValue ?? 0) ?? BIGINT_ZERO
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
    let residualCents = targetCents - floorCents

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
        const balancedCents = share.cents + (residualCents > BIGINT_ZERO ? BIGINT_ONE : BIGINT_ZERO)
        resolvedCents[share.index] = balancedCents
        if (residualCents > BIGINT_ZERO) residualCents -= BIGINT_ONE
      })
  }

  return allocations.map((allocation, index) => ({
    ...allocation,
    amount: fromCents(resolvedCents[index] ?? BIGINT_ZERO)
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
    .filter(allocation => toCents(allocation.amount) > BIGINT_ZERO)
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
  const generatedAmountByKey = new Map<string, bigint>()
  for (const line of generatedLines) {
    const key = commitmentLineCoverageKey(line)
    const existingAmount = generatedAmountByKey.get(key) ?? BIGINT_ZERO
    generatedAmountByKey.set(key, existingAmount + toCents(line.amount))
  }

  const paidAmountByKey = new Map<string, { index: number, paidAmount: bigint }>()
  for (const [index, line] of paidLines.entries()) {
    const key = commitmentLineCoverageKey(line)
    const existing = paidAmountByKey.get(key) ?? { index, paidAmount: BIGINT_ZERO }
    paidAmountByKey.set(key, {
      ...existing,
      paidAmount: existing.paidAmount + toCents(line.paidAmount)
    })
  }

  return Array.from(paidAmountByKey.entries()).flatMap(([key, paidLine]) => {
    const generatedAmount = generatedAmountByKey.get(key) ?? BIGINT_ZERO
    if (paidLine.paidAmount <= generatedAmount) {
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
  .filter(line => toCents(line.weightAmount) > BIGINT_ZERO && toCents(line.remainingAmount) > BIGINT_ZERO)

const canAllocatePaymentAmount = (
  candidates: PaymentLineAllocationCandidate[],
  amountToAllocate: AllocationMoney
) => {
  const totalRemainingCents = candidates.reduce((sum, line) => sum + toCents(line.remainingAmount), BIGINT_ZERO)
  const amountToAllocateCents = toCents(amountToAllocate)
  return amountToAllocateCents > BIGINT_ZERO
    && totalRemainingCents > BIGINT_ZERO
    && amountToAllocateCents <= totalRemainingCents
}

const recordPaymentLineAllocation = (
  allocatedByLineId: Map<string, PaymentLineAllocationResolved>,
  line: PaymentLineAllocationCandidate,
  paymentLineAmount: AllocationMoney
) => {
  const existing = allocatedByLineId.get(line.commitmentLineId)
  allocatedByLineId.set(line.commitmentLineId, {
    ...(existing ?? line),
    paymentAmount: fromCents(toCents(existing?.paymentAmount ?? '0.00') + toCents(paymentLineAmount))
  })
}

/**
 * Allocates one weighted round, capping each line at its remaining amount and carrying eligible remainders forward.
 */
const allocatePaymentRound = (
  candidates: PaymentLineAllocationCandidate[],
  remainingPaymentCents: bigint,
  allocatedByLineId: Map<string, PaymentLineAllocationResolved>
) => {
  const totalWeightCents = candidates.reduce(
    (sum, line) => sum + toCents(line.weightAmount),
    BIGINT_ZERO
  )
  if (totalWeightCents <= BIGINT_ZERO) {
    return {
      roundAllocatedCents: BIGINT_ZERO,
      roundRemainingCents: remainingPaymentCents,
      nextCandidates: []
    }
  }

  const roundStartCents = remainingPaymentCents
  let roundRemainingCents = remainingPaymentCents
  const nextCandidates: PaymentLineAllocationCandidate[] = []
  for (const [index, line] of candidates.entries()) {
    const isLastLine = index === candidates.length - 1
    const lineWeightCents = toCents(line.weightAmount)
    const lineRemainingCents = toCents(line.remainingAmount)
    const targetCents = isLastLine
      ? roundRemainingCents
      : (
            roundStartCents * lineWeightCents
            + totalWeightCents / BIGINT_TWO
          ) / totalWeightCents
    const paymentLineCents = [targetCents, lineRemainingCents, roundRemainingCents]
      .reduce((minimum, value) => value < minimum ? value : minimum)
    if (paymentLineCents <= BIGINT_ZERO) {
      nextCandidates.push(line)
      continue
    }

    recordPaymentLineAllocation(allocatedByLineId, line, fromCents(paymentLineCents))
    roundRemainingCents -= paymentLineCents
    const nextRemainingCents = lineRemainingCents - paymentLineCents
    if (nextRemainingCents > BIGINT_ZERO) {
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
  paymentAmount: AllocationDecimalInput
): PaymentLineAllocationResolved[] => {
  let candidates = normalizePaymentLineAllocationCandidates(lines)
  const amountToAllocate = toMoney(paymentAmount)
  if (!canAllocatePaymentAmount(candidates, amountToAllocate)) {
    return []
  }

  let remainingPaymentCents = toCents(amountToAllocate)
  const allocatedByLineId = new Map<string, PaymentLineAllocationResolved>()

  while (remainingPaymentCents > BIGINT_ZERO && candidates.length > 0) {
    const round = allocatePaymentRound(candidates, remainingPaymentCents, allocatedByLineId)
    if (round.roundAllocatedCents <= BIGINT_ZERO) {
      break
    }

    remainingPaymentCents = round.roundRemainingCents
    candidates = round.nextCandidates
  }

  return Array.from(allocatedByLineId.values())
}
