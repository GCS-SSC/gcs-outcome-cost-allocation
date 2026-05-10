/* eslint-disable jsdoc/require-jsdoc */
import { describe, expect, it } from 'vitest'
import {
  allocatePaymentAmountToCommitmentLines,
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
  validateGeneratedCommitmentLinePaymentCoverage,
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
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 600
      },
      {
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: 400
      },
      {
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 333.33
      }
    ], years, activeOutcomes)).toEqual([])

    expect(validateAllocationTotals([
      {
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 999
      }
    ], years, activeOutcomes).map(issue => issue.code)).toContain('GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID')
  })

  it('validates percentage allocations and allows mixed methods when the total resolves to the agreement budget', () => {
    expect(validateAllocationTotals([
      {
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 60
      },
      {
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage',
        allocationValue: 40
      },
      {
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 100
      }
    ], years, activeOutcomes)).toEqual([])

    expect(validateAllocationTotals([
      {
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 60
      },
      {
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-2',
        allocationMethod: 'amount',
        allocationValue: 400
      },
      {
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
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 1333.33
      }
    ], years, activeOutcomes)).toEqual([])
  })

  it('rounds generated percentage lines so the year total is exact', () => {
    const resolved = resolveAllocationAmounts([
      {
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 33.33
      },
      {
        agreementBudgetFiscalYearId: 'year-2',
        outcomeId: 'outcome-2',
        allocationMethod: 'percentage',
        allocationValue: 66.67
      }
    ], years)

    expect(resolved.map(allocation => allocation.amount)).toEqual([111.1, 222.23])
    expect(resolved.reduce((sum, allocation) => sum + allocation.amount, 0)).toBe(333.33)
  })

  it('reports missing activity outcomes and stale budget rows', () => {
    const issues = validateAllocationTotals([
      {
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
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: 500,
          amount: 500
        },
        {
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-2',
          allocationMethod: 'amount',
          allocationValue: 500,
          amount: 500
        }
      ],
      config,
      new Map([['year-1', 'stream-budget-1']]),
      new Set(['stream-commitment-1'])
    ).map(issue => issue.code)

    expect(issues).toEqual(['GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE'])
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
        commitmentType: 'commitment',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 80
      },
      {
        commitmentType: 'paye',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        streamCommitmentId: 'stream-commitment-1',
        paidAmount: 80
      }
    ])

    expect(issues.map(issue => issue.code)).toEqual([
      'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE',
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
})
