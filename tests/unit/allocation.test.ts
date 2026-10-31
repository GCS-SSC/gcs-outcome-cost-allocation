import { parseCurrencyMoney, parseDecimalText, parseMoney, sumMoney } from '@gcs-ssc/extensions/money'
import { describe, expect, it } from 'vitest'
import {
  allocatePaymentAmountToCommitmentLines,
  parseOutcomeCostAllocationConfig,
  parseAllocationPercentage,
  resolveAllocationAmounts,
  validateAllocationReferences,
  validateAllocationTotals,
  validateAllocationYearLimits,
  validateCommitmentMappings
} from '../../shared/allocation'

const money = (amount: string, currency = 'CAD') => parseCurrencyMoney(amount, currency)

const years = [
  {
    agreementBudgetFiscalYearId: 'year-1',
    programFunding: money('1000')
  },
  {
    agreementBudgetFiscalYearId: 'year-2',
    programFunding: money('333.33')
  }
]

const activeOutcomes = new Set(['outcome-1', 'outcome-2'])

describe('outcome cost allocation logic', () => {
  it('validates amount allocations against the total agreement budget', () => {
    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('600')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: money('400')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('333.33')
      }
    ], years, activeOutcomes, 'CAD')).toEqual([])

    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('999')
      }
    ], years, activeOutcomes, 'CAD').map(issue => issue.code)).toContain('GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID')
  })

  it('rejects an allocation total that exceeds the agreement budget by one cent', () => {
    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('1000.01')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: money('333.33')
      }
    ], years, activeOutcomes, 'CAD').map(issue => issue.code)).toContain(
      'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID'
    )
  })

  it('validates percentage allocations and allows mixed methods when the total resolves to the agreement budget', () => {
    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: parseDecimalText('60')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage',
        allocationValue: parseDecimalText('40')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: parseDecimalText('100')
      }
    ], years, activeOutcomes, 'CAD')).toEqual([])

    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: parseDecimalText('60')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: money('400')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: parseDecimalText('100')
      }
    ], years, activeOutcomes, 'CAD')).toEqual([])
  })

  it('rejects shifting another fiscal year budget into one year', () => {
    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('1333.33')
      }
    ], years, activeOutcomes, 'CAD').map(issue => issue.code)).toContain('GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_INVALID')
    expect(validateAllocationYearLimits([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('1333.33')
      }
    ], years, 'CAD').map(issue => issue.code)).toContain('GCS_OUTCOME_COST_ALLOCATION_YEAR_TOTAL_EXCEEDED')
  })

  it('validates the agreement total across all commitment types combined', () => {
    expect(validateAllocationTotals([
      {
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('1000')
      },
      {
        commitmentType: '2',
        streamCommitmentId: 'stream-commitment-2',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: money('333.33')
      }
    ], years, activeOutcomes, 'CAD')).toEqual([])
  })

  it('validates scoped allocation references without requiring each commitment type to equal the agreement total', () => {
    expect(validateAllocationReferences([
      {
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('1000')
      }
    ], years, activeOutcomes)).toEqual([])
  })

  it('rounds generated percentage lines so the year total is exact', () => {
    const resolved = resolveAllocationAmounts([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: parseDecimalText('33.33')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage',
        allocationValue: parseDecimalText('66.67')
      }
    ], years, 'CAD')

    expect(resolved.map(allocation => allocation.amount)).toEqual([money('111.10'), money('222.23')])
    expect(sumMoney(resolved.map(allocation => allocation.amount), 'CAD')).toEqual(money('333.33'))
  })

  it('balances percentage residual cents deterministically and validates the resolved values', () => {
    const centSensitiveYears = [{
      agreementBudgetFiscalYearId: 'year-1',
      programFunding: money('2.05')
    }]
    const allocations = [
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage' as const,
        allocationValue: parseDecimalText('10')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage' as const,
        allocationValue: parseDecimalText('90')
      }
    ]

    const resolved = resolveAllocationAmounts(allocations, centSensitiveYears, 'CAD')

    expect(resolved.map(allocation => allocation.amount)).toEqual([money('0.21'), money('1.84')])
    expect(sumMoney(resolved.map(allocation => allocation.amount), 'CAD')).toEqual(money('2.05'))
    expect(validateAllocationTotals(allocations, centSensitiveYears, activeOutcomes, 'CAD')).toEqual([])
  })

  it('assigns equal percentage remainders to the same coordinate after request reordering', () => {
    const centSensitiveYears = [{
      agreementBudgetFiscalYearId: 'year-1',
      programFunding: money('2.05')
    }]
    const allocations = [
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage' as const,
        allocationValue: parseDecimalText('10')
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage' as const,
        allocationValue: parseDecimalText('90')
      }
    ]
    const byOutcomeId = (resolved: ReturnType<typeof resolveAllocationAmounts>) => new Map(
      resolved.map(allocation => [allocation.outcomeId, allocation.amount])
    )

    const forward = byOutcomeId(resolveAllocationAmounts(allocations, centSensitiveYears, 'CAD'))
    const reversed = byOutcomeId(resolveAllocationAmounts([...allocations].reverse(), centSensitiveYears, 'CAD'))

    expect(forward).toEqual(new Map([
      ['outcome-1', money('0.21')],
      ['outcome-2', money('1.84')]
    ]))
    expect(reversed).toEqual(forward)
  })

  it('rejects fractional currency minor units instead of silently rounding authored amounts', () => {
    expect(() => parseCurrencyMoney('10.075', 'CAD')).toThrow('fractional')
    expect(() => parseCurrencyMoney('1.005', 'CAD')).toThrow('fractional')
    expect(() => parseCurrencyMoney('0.1', 'JPY')).toThrow('fractional')
    expect(() => parseMoney('1.00')).toThrow('Money must be an object')
  })

  it('accepts exact Money objects and validates percentage syntax independently', () => {
    expect(parseMoney({ amount: '9999999999999999999', currency: 'CAD' })).toEqual(money('99999999999999999.99'))
    expect(parseAllocationPercentage('99.9999')).toBe('99.9999')
    expect(parseAllocationPercentage('100.0001')).toBeNull()
    expect(parseAllocationPercentage('00.1000')).toBeNull()
    expect(parseAllocationPercentage('0.00001')).toBeNull()
    expect(() => parseCurrencyMoney(' 1.00', 'CAD')).toThrow()
    expect(() => parseCurrencyMoney('01.00', 'CAD')).toThrow()
  })

  it('reports missing activity outcomes and stale budget rows', () => {
    const issues = validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'stale-year',
        outcomeId: 'stale-outcome',
        allocationMethod: 'amount',
        allocationValue: money('1000')
      }
    ], years, activeOutcomes, 'CAD').map(issue => issue.code)

    expect(issues).toContain('GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME')
    expect(issues).toContain('GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR')
    expect(issues).toContain('GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID')
  })

  it('parses stream config and validates missing or inactive mappings', () => {
    const config = parseOutcomeCostAllocationConfig({
      enabledCommitmentTypes: ['1'],
      mappings: [
        {
          commitmentType: '1',
          outcomeId: 'outcome-1',
          streamBudgetId: 'stream-budget-1',
          streamCommitmentId: 'stream-commitment-1'
        },
        {
          commitmentType: '1',
          outcomeId: 'outcome-2',
          streamBudgetId: 'stream-budget-1',
          streamCommitmentId: 'inactive-stream-commitment'
        }
      ]
    })

    const issues = validateCommitmentMappings(
      '1',
      [
        {
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: money('500'),
          amount: money('500')
        },
        {
          streamCommitmentId: 'inactive-stream-commitment',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-2',
          allocationMethod: 'amount',
          allocationValue: money('500'),
          amount: money('500')
        }
      ],
      config,
      new Map([['year-1', 'stream-budget-1']]),
      new Map([['stream-commitment-1', 'stream-budget-1']])
    ).map(issue => issue.code)

    expect(issues).toEqual(['GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE'])
  })

  it('rejects active stream commitments attached to a different fiscal-year budget', () => {
    const config = parseOutcomeCostAllocationConfig({
      enabledCommitmentTypes: ['1'],
      mappings: [{
        commitmentType: '1',
        outcomeId: 'outcome-1',
        streamBudgetId: 'stream-budget-1',
        streamCommitmentId: 'stream-commitment-1'
      }]
    })

    expect(validateCommitmentMappings(
      '1',
      [{
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: money('1000'),
        amount: money('1000')
      }],
      config,
      new Map([['year-1', 'stream-budget-1']]),
      new Map([['stream-commitment-1', 'different-stream-budget']])
    )).toEqual([{
      code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH',
      path: 'allocations.0.streamCommitmentId',
      message: 'apiErrors.extensions.outcome_cost_allocation.stream_commitment_budget_mismatch'
    }])
  })

  it('allocates payment amounts across commitment lines using allocation weights and remaining balances', () => {
    expect(allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: money('75'),
        remainingAmount: money('75')
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: money('25'),
        remainingAmount: money('10')
      }
    ], money('50'), 'CAD')).toEqual([
      {
        commitmentLineId: 'line-1',
        weightAmount: money('75.00'),
        remainingAmount: money('75.00'),
        paymentAmount: money('40.00')
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: money('25.00'),
        remainingAmount: money('10.00'),
        paymentAmount: money('10.00')
      }
    ])

    expect(allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: money('75'),
        remainingAmount: money('25')
      }
    ], money('50'), 'CAD')).toEqual([])
  })

  it('rounds generated payment lines to cents while preserving the payment total', () => {
    const lines = allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: money('1'),
        remainingAmount: money('100')
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: money('1'),
        remainingAmount: money('100')
      },
      {
        commitmentLineId: 'line-3',
        weightAmount: money('1'),
        remainingAmount: money('100')
      }
    ], money('100'), 'CAD')

    expect(lines.map(line => line.paymentAmount)).toEqual([money('33.33'), money('33.33'), money('33.34')])
    expect(sumMoney(lines.map(line => line.paymentAmount), 'CAD')).toEqual(money('100.00'))
  })

  it('weights large exact financial values without overflowing Number multiplication', () => {
    const lines = allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: money('900000000000'),
        remainingAmount: money('900000000000')
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: money('900000000000'),
        remainingAmount: money('900000000000')
      }
    ], money('900000000000'), 'CAD')

    expect(lines.map(line => line.paymentAmount)).toEqual([
      money('450000000000.00'),
      money('450000000000.00')
    ])
  })
})
