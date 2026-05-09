/* eslint-disable jsdoc/require-jsdoc */
import { describe, expect, it } from 'vitest'
import {
  parseOutcomeCostAllocationConfig,
  resolveAllocationAmounts,
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
})
