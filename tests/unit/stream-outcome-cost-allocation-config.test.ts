import { describe, expect, it } from 'vitest'
import { buildStreamOutcomeAllocationTableRows } from '../../shared/stream-outcome-cost-allocation-config'

const association = {
  id: 'association-1',
  commitmentType: 'commitment',
  commitmentTypeGroup: 'Commitments',
  fiscalYearGroup: '2026-2027',
  streamBudgetId: 'budget-1',
  streamCommitmentId: 'commitment-1',
  outcomeId: 'outcome-1',
  lineLabel: 'GL 100',
  outcomeLabel: 'Outcome 1'
} as const

describe('stream outcome cost allocation config helpers', () => {
  it('builds expanded hierarchy rows', () => {
    expect(buildStreamOutcomeAllocationTableRows([association], {
      isExpanded: () => true,
      recordsLabel: 'records'
    })).toEqual([
      expect.objectContaining({
        id: 'type:commitment',
        rowType: 'commitmentType',
        associationCount: 1
      }),
      expect.objectContaining({
        id: 'year:commitment:2026-2027',
        rowType: 'fiscalYear',
        lineLabel: '2026-2027'
      }),
      expect.objectContaining({
        id: 'association-1',
        rowType: 'association',
        association
      })
    ])
  })

  it('omits fiscal-year and association rows when the type group is collapsed', () => {
    expect(buildStreamOutcomeAllocationTableRows([association], {
      isExpanded: groupId => groupId !== 'type:commitment',
      recordsLabel: 'records'
    })).toEqual([
      expect.objectContaining({
        id: 'type:commitment',
        rowType: 'commitmentType'
      })
    ])
  })
})
