import {
  addMoney, allocateMoney, allocateMoneyByPercentages, compareMoney,
  minMoney, parseDecimalText, parseMoney, percentageMoney, subtractMoney, sumMoney,
  zeroMoney, moneyToMinorUnits, moneyCalculator, type DecimalText, type Money
} from '@gcs-ssc/extensions/money'

export const EXTENSION_KEY = 'gcs-outcome-cost-allocation'
export type CommitmentType = string
export const ALLOCATION_METHODS = ['amount', 'percentage'] as const
export type AllocationMethod = typeof ALLOCATION_METHODS[number]
export const ALLOCATION_VERSION_STATUSES = ['draft', 'active', 'inactive'] as const
export type AllocationVersionStatus = typeof ALLOCATION_VERSION_STATUSES[number]
export type AllocationMoney = Money
export type AllocationDecimal4 = DecimalText

/** Four decimal places belong to percentages, independently of monetary denomination. */
export const percentageToScaledUnits = (value: unknown): bigint | null => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) return null
  const [whole = '0', fraction = ''] = value.split('.')
  const units = BigInt(`${whole}${fraction.padEnd(4, '0')}`)
  return units <= BigInt(1_000_000) ? units : null
}

export const parseAllocationPercentage = (value: unknown): DecimalText | null =>
  percentageToScaledUnits(value) === null ? null : parseDecimalText(String(value))

export type OutcomeAllocationInput = {
  commitmentType?: CommitmentType
  streamCommitmentId: string
  agreementBudgetFiscalYearId: string
  outcomeId: string
} & ({ allocationMethod: 'amount'; allocationValue: Money }
  | { allocationMethod: 'percentage'; allocationValue: DecimalText })

export type VersionedOutcomeAllocationInput = OutcomeAllocationInput & {
  allocationVersionId: string
  /** Invalid imported catalog coordinates never change the retained native denomination. */
  coordinateCurrencyMismatch?: boolean
  resolvedAmount?: Money | null
  fundingBasisAmount?: Money | null
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
  fundingBasisAmount?: Money | null
}
export type OutcomeAllocationResolved = OutcomeAllocationInput & { amount: Money }
export interface YearFundingTotal { agreementBudgetFiscalYearId: string; programFunding: Money }
export interface StreamCommitmentMapping {
  commitmentType: CommitmentType
  outcomeId: string
  streamBudgetId: string
  streamCommitmentId: string
}
export interface OutcomeCostAllocationConfig { enabledCommitmentTypes: CommitmentType[]; mappings: StreamCommitmentMapping[] }
export interface AllocationValidationIssue { code: string; path: string; message: string }
export interface PaymentLineAllocationInput { commitmentLineId: string; weightAmount: Money; remainingAmount: Money }
export interface PaymentLineAllocationResolved extends PaymentLineAllocationInput { paymentAmount: Money }
export const isCommitmentType = (value: unknown): value is CommitmentType => typeof value === 'string' && /^\d+$/.test(value)

/** Returns an exact percentage rounded only at its separate four-place display boundary. */
export const percentageForMoney = (amount: Money, funding: Money): DecimalText => {
  if (compareMoney(funding, zeroMoney(funding.currency)) <= 0) return parseDecimalText('0')
  // Currency cancels here: this is a dimensionless ratio rather than a monetary result.
  compareMoney(amount, zeroMoney(funding.currency))
  const denominator = moneyToMinorUnits(funding)
  const numerator = moneyCalculator.multiply(moneyToMinorUnits(amount), BigInt(1_000_000))
  const rounded = moneyCalculator.integerDivide(moneyCalculator.add(numerator, moneyCalculator.integerDivide(denominator, BigInt(2))), denominator)
  const text = String(rounded).padStart(5, '0')
  return parseDecimalText(`${text.slice(0, -4)}.${text.slice(-4)}`)
}
export const moneyForPercentage = (funding: Money, percentage: DecimalText): Money => percentageMoney(funding, percentage)

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
  allocations: OutcomeAllocationInput[], yearTotals: YearFundingTotal[], activeOutcomeIds: Set<string>, currency: string
): AllocationValidationIssue[] => {
  const issues = validateAllocationReferences(allocations, yearTotals, activeOutcomeIds)
  const resolved = resolveAllocationAmounts(allocations, yearTotals, currency)
  if (compareMoney(sumMoney(resolved.map(row => row.amount), currency), sumMoney(yearTotals.map(row => row.programFunding), currency)) !== 0) {
    issues.push({ code: 'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID', path: 'allocations', message: 'apiErrors.extensions.outcome_cost_allocation.total_invalid' })
  }
  for (const year of yearTotals) {
    if (compareMoney(sumMoney(resolved.filter(row => row.agreementBudgetFiscalYearId === year.agreementBudgetFiscalYearId).map(row => row.amount), currency), year.programFunding) !== 0) {
      issues.push({ code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID', path: `allocations.${year.agreementBudgetFiscalYearId}`, message: 'apiErrors.extensions.outcome_cost_allocation.year_total_invalid' })
    }
  }
  return issues
}
export const validateAllocationYearLimits = (
  allocations: OutcomeAllocationInput[], yearTotals: YearFundingTotal[], currency: string
): AllocationValidationIssue[] => {
  const resolved = resolveAllocationAmounts(allocations, yearTotals, currency)
  return yearTotals.flatMap(year => compareMoney(sumMoney(resolved.filter(row => row.agreementBudgetFiscalYearId === year.agreementBudgetFiscalYearId).map(row => row.amount), currency), year.programFunding) > 0
    ? [{ code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED', path: `allocations.${year.agreementBudgetFiscalYearId}`, message: 'apiErrors.extensions.outcome_cost_allocation.year_total_exceeded' }] : [])
}
const stableAllocationCoordinate = (allocation: OutcomeAllocationInput): string => [allocation.commitmentType ?? '', allocation.agreementBudgetFiscalYearId, allocation.outcomeId, allocation.streamCommitmentId].join(':')

/** Settles percentage quotas once per year, with deterministic coordinate ties. */
export const resolveAllocationAmounts = (
  allocations: OutcomeAllocationInput[], yearTotals: YearFundingTotal[], currency: string
): OutcomeAllocationResolved[] => {
  const amounts = allocations.map(row => row.allocationMethod === 'amount' ? parseMoney(row.allocationValue) : zeroMoney(currency))
  for (const year of yearTotals) {
    const indexes = allocations.flatMap((row, index) => row.allocationMethod === 'percentage' && row.agreementBudgetFiscalYearId === year.agreementBudgetFiscalYearId ? [index] : [])
      .sort((a, b) => stableAllocationCoordinate(allocations[a]!).localeCompare(stableAllocationCoordinate(allocations[b]!)) || a - b)
    const percentages = indexes.map(index => {
      const row = allocations[index]!
      if (row.allocationMethod !== 'percentage') throw new Error('Allocation method changed during resolution')
      return row.allocationValue
    })
    const shares = allocateMoneyByPercentages(year.programFunding, percentages)
    indexes.forEach((index, position) => { amounts[index] = shares[position]! })
  }
  return allocations.map((row, index) => ({ ...row, amount: amounts[index]! }))
}

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
    .filter(allocation => compareMoney(allocation.amount, zeroMoney(allocation.amount.currency)) > 0)
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


/** Capacity-limited proportional rounds use Dinero allocation and exact monetary operations. */
export const allocatePaymentAmountToCommitmentLines = (
  lines: PaymentLineAllocationInput[], paymentAmount: Money, currency: string
): PaymentLineAllocationResolved[] => {
  const zero = zeroMoney(currency)
  let candidates = lines.map(line => ({ ...line, weightAmount: parseMoney(line.weightAmount), remainingAmount: parseMoney(line.remainingAmount) }))
    .filter(line => compareMoney(line.weightAmount, zero) > 0 && compareMoney(line.remainingAmount, zero) > 0)
  if (compareMoney(paymentAmount, zero) <= 0 || compareMoney(paymentAmount, sumMoney(candidates.map(row => row.remainingAmount), currency)) > 0) return []
  let remaining = paymentAmount
  const allocated = new Map<string, PaymentLineAllocationResolved>()
  while (compareMoney(remaining, zero) > 0 && candidates.length) {
    // The previous payment allocator broke equal remainders by descending line identity.
    const ranked = [...candidates].sort((a, b) => b.commitmentLineId.localeCompare(a.commitmentLineId))
    const targets = allocateMoney(remaining, ranked.map(line => parseDecimalText(line.weightAmount.amount)), { method: 'largestRemainder' })
    const targetById = new Map(ranked.map((line, index) => [line.commitmentLineId, targets[index]!]))
    const before = remaining
    const next: PaymentLineAllocationInput[] = []
    for (const line of candidates) {
      const applied = minMoney([targetById.get(line.commitmentLineId)!, line.remainingAmount, remaining], currency)
      if (compareMoney(applied, zero) > 0) {
        const prior = allocated.get(line.commitmentLineId)
        allocated.set(line.commitmentLineId, { ...(prior ?? line), paymentAmount: addMoney(prior?.paymentAmount ?? zero, applied) })
        remaining = subtractMoney(remaining, applied)
      }
      const available = subtractMoney(line.remainingAmount, applied)
      if (compareMoney(available, zero) > 0) next.push({ ...line, remainingAmount: available })
    }
    if (compareMoney(before, remaining) === 0) break
    candidates = next
  }
  return [...allocated.values()]
}
