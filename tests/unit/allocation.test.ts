import { describe, expect, it } from 'vitest'
import {
  allocatePaymentAmountToCommitmentLines,
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
  toMoney,
  validateGeneratedCommitmentLinePaymentCoverage,
  validateAllocationReferences,
  validateAllocationTotals,
  validateCommitmentMappings
} from '../../shared/allocation'

const years = [
  {
    agreementBudgetFiscalYearId: 'year-1',
    programFunding: 1000
  },
  {
    agreementBudgetFiscalYearId: 'year-2',
    programFunding: 333.33
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
        allocationValue: 600
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: 400
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 333.33
      }
    ], years, activeOutcomes)).toEqual([])

    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 999
      }
    ], years, activeOutcomes).map(issue => issue.code)).toContain('GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID')
  })

  it('rejects an allocation total that exceeds the agreement budget by one cent', () => {
    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 1000.01
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: 333.33
      }
    ], years, activeOutcomes).map(issue => issue.code)).toContain(
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
        allocationValue: 60
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage',
        allocationValue: 40
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 100
      }
    ], years, activeOutcomes)).toEqual([])

    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 60
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: 400
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 100
      }
    ], years, activeOutcomes)).toEqual([])
  })

  it('allows the full agreement budget to be allocated in one budget year', () => {
    expect(validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 1333.33
      }
    ], years, activeOutcomes)).toEqual([])
  })

  it('validates the agreement total across all commitment types combined', () => {
    expect(validateAllocationTotals([
      {
        commitmentType: 'commitment',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 1000
      },
      {
        commitmentType: 'paye',
        streamCommitmentId: 'stream-commitment-2',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: 333.33
      }
    ], years, activeOutcomes)).toEqual([])
  })

  it('validates scoped allocation references without requiring each commitment type to equal the agreement total', () => {
    expect(validateAllocationReferences([
      {
        commitmentType: 'commitment',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 1000
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
        allocationValue: 33.33
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage',
        allocationValue: 66.67
      }
    ], years)

    expect(resolved.map(allocation => allocation.amount)).toEqual([111.1, 222.23])
    expect(resolved.reduce((sum, allocation) => sum + allocation.amount, 0)).toBe(333.33)
  })

  it('balances percentage residual cents deterministically and validates the resolved values', () => {
    const centSensitiveYears = [{
      agreementBudgetFiscalYearId: 'year-1',
      programFunding: 2.05
    }]
    const allocations = [
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage' as const,
        allocationValue: 10
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage' as const,
        allocationValue: 90
      }
    ]

    const resolved = resolveAllocationAmounts(allocations, centSensitiveYears)

    expect(resolved.map(allocation => allocation.amount)).toEqual([0.21, 1.84])
    expect(toMoney(resolved.reduce((sum, allocation) => sum + allocation.amount, 0))).toBe(2.05)
    expect(validateAllocationTotals(allocations, centSensitiveYears, activeOutcomes)).toEqual([])
  })

  it('assigns equal percentage remainders to the same coordinate after request reordering', () => {
    const centSensitiveYears = [{
      agreementBudgetFiscalYearId: 'year-1',
      programFunding: 2.05
    }]
    const allocations = [
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage' as const,
        allocationValue: 10
      },
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage' as const,
        allocationValue: 90
      }
    ]
    const byOutcomeId = (resolved: ReturnType<typeof resolveAllocationAmounts>) => new Map(
      resolved.map(allocation => [allocation.outcomeId, allocation.amount])
    )

    const forward = byOutcomeId(resolveAllocationAmounts(allocations, centSensitiveYears))
    const reversed = byOutcomeId(resolveAllocationAmounts([...allocations].reverse(), centSensitiveYears))

    expect(forward).toEqual(new Map([
      ['outcome-1', 0.21],
      ['outcome-2', 1.84]
    ]))
    expect(reversed).toEqual(forward)
  })

  it('rounds decimal half cents correctly without binary floating-point drift', () => {
    expect(toMoney(10.075)).toBe(10.08)
    expect(toMoney(1.005)).toBe(1.01)
  })

  it('reports missing activity outcomes and stale budget rows', () => {
    const issues = validateAllocationTotals([
      {
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'stale-year',
        outcomeId: 'stale-outcome',
        allocationMethod: 'amount',
        allocationValue: 1000
      }
    ], years, activeOutcomes).map(issue => issue.code)

    expect(issues).toContain('GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME')
    expect(issues).toContain('GCS_OUTCOME_COST_ALLOCATION_STALE_BUDGET_YEAR')
    expect(issues).toContain('GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID')
  })

  it('parses stream config and validates missing or inactive mappings', () => {
    const config = parseOutcomeCostAllocationConfig({
      enabledCommitmentTypes: ['commitment'],
      mappings: [
        {
          commitmentType: 'commitment',
          outcomeId: 'outcome-1',
          streamBudgetId: 'stream-budget-1',
          streamCommitmentId: 'stream-commitment-1'
        },
        {
          commitmentType: 'commitment',
          outcomeId: 'outcome-2',
          streamBudgetId: 'stream-budget-1',
          streamCommitmentId: 'inactive-stream-commitment'
        }
      ]
    })

    const issues = validateCommitmentMappings(
      'commitment',
      [
        {
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: 500,
          amount: 500
        },
        {
          streamCommitmentId: 'inactive-stream-commitment',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-2',
          allocationMethod: 'amount',
          allocationValue: 500,
          amount: 500
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
      enabledCommitmentTypes: ['commitment'],
      mappings: [{
        commitmentType: 'commitment',
        outcomeId: 'outcome-1',
        streamBudgetId: 'stream-budget-1',
        streamCommitmentId: 'stream-commitment-1'
      }]
    })

    expect(validateCommitmentMappings(
      'commitment',
      [{
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 1000,
        amount: 1000
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

  it('rejects generated commitment lines below existing paid amounts', () => {
    const issues = validateGeneratedCommitmentLinePaymentCoverage([
      {
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        streamCommitmentId: 'stream-commitment-1',
        amount: 75
      }
    ], [
      {
        commitmentLineId: 'line-1',
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 80
      },
      {
        commitmentLineId: 'line-2',
        commitmentType: 'paye',
        agreementBudgetFiscalYearId: 'year-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 80
      }
    ])

    expect(issues.map(issue => issue.code)).toEqual([
      'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE',
      'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE'
    ])
  })

  it('validates paid coverage by commitment type, budget year, and stream commitment', () => {
    const issues = validateGeneratedCommitmentLinePaymentCoverage([
      {
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        streamCommitmentId: 'stream-commitment-1',
        amount: 40
      },
      {
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        streamCommitmentId: 'stream-commitment-1',
        amount: 35
      }
    ], [
      {
        commitmentLineId: 'line-1',
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 70
      }
    ])

    expect(issues).toEqual([])

    expect(validateGeneratedCommitmentLinePaymentCoverage([
      {
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        streamCommitmentId: 'stream-commitment-1',
        amount: 40
      },
      {
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        streamCommitmentId: 'stream-commitment-1',
        amount: 35
      }
    ], [
      {
        commitmentLineId: 'line-1',
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 80
      }
    ]).map(issue => issue.code)).toEqual([
      'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE'
    ])
  })

  it('sums multiple paid lines against the same referenced commitment line', () => {
    const issues = validateGeneratedCommitmentLinePaymentCoverage([
      {
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        streamCommitmentId: 'stream-commitment-1',
        amount: 75
      }
    ], [
      {
        commitmentLineId: 'line-1',
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 40
      },
      {
        commitmentLineId: 'line-1',
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 40
      }
    ])

    expect(issues.map(issue => issue.code)).toEqual([
      'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE'
    ])
  })

  it('allocates payment amounts across commitment lines using allocation weights and remaining balances', () => {
    expect(allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: 75,
        remainingAmount: 75
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: 25,
        remainingAmount: 10
      }
    ], 50)).toEqual([
      {
        commitmentLineId: 'line-1',
        weightAmount: 75,
        remainingAmount: 75,
        paymentAmount: 40
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: 25,
        remainingAmount: 10,
        paymentAmount: 10
      }
    ])

    expect(allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: 75,
        remainingAmount: 25
      }
    ], 50)).toEqual([])
  })

  it('rounds generated payment lines to cents while preserving the payment total', () => {
    const lines = allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: 1,
        remainingAmount: 100
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: 1,
        remainingAmount: 100
      },
      {
        commitmentLineId: 'line-3',
        weightAmount: 1,
        remainingAmount: 100
      }
    ], 100)

    expect(lines.map(line => line.paymentAmount)).toEqual([33.33, 33.33, 33.34])
    expect(lines.reduce((sum, line) => sum + line.paymentAmount, 0)).toBe(100)
  })

  it('weights large exact financial values without overflowing Number multiplication', () => {
    const lines = allocatePaymentAmountToCommitmentLines([
      {
        commitmentLineId: 'line-1',
        weightAmount: 900_000_000_000,
        remainingAmount: 900_000_000_000
      },
      {
        commitmentLineId: 'line-2',
        weightAmount: 900_000_000_000,
        remainingAmount: 900_000_000_000
      }
    ], 900_000_000_000)

    expect(lines.map(line => line.paymentAmount)).toEqual([
      450_000_000_000,
      450_000_000_000
    ])
  })
})
