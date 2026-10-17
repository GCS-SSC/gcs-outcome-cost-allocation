import { expect, it } from 'vitest'
import { parseSaveAllocationsRequest } from '../../server/allocation-request-validation'

const allocation = {
  commitmentType: '1', streamCommitmentId: '2', agreementBudgetFiscalYearId: '3',
  outcomeId: '4', allocationMethod: 'percentage', allocationValue: '25.0000'
}

it.each([
  { allocations: [{ ...allocation, allocationValue: null }], path: 'allocations.0.allocationValue' },
  { allocations: [{ ...allocation, allocationValue: '100.0001' }], path: 'allocations.0.allocationValue' },
  { allocations: [allocation, allocation], path: 'allocations.1' }
])('returns bilingual user errors instead of internal schema prose at $path', ({ allocations, path }) => {
  expect(() => parseSaveAllocationsRequest({ allocationVersionId: '1', allocations })).toThrowError(expect.objectContaining({
    code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
    localizedMessage: {
      en: 'Outcome cost allocations are invalid.',
      fr: 'Les répartitions des coûts par résultat sont invalides.'
    },
    details: [{
      path, code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      message: {
        en: 'Outcome cost allocations are invalid.',
        fr: 'Les répartitions des coûts par résultat sont invalides.'
      }
    }]
  }))
})
