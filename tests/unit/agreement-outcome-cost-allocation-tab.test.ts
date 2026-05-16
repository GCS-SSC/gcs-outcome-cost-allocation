import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import {
  buildOutcomeAllocationRows,
  buildSaveOutcomeAllocationsRequestBody,
  completeOutcomeAllocationSelectedVersion,
  completeOutcomeAllocationVersionRequest,
  deleteOutcomeAllocationDraftVersionRequest,
  getOutcomeAllocationVersionEndpoint,
  getOutcomeAllocationVersionsEndpoint,
  getOutcomeAllocationResponseErrorMessage,
  getOutcomeAllocationToastText,
  resolveCreatedDraftVersionId,
  resolveDeletedDraftVersionId,
  resolveSelectedOutcomeAllocationVersionId,
  saveOutcomeAllocationsRequest
} from '../../shared/agreement-outcome-cost-allocation-tab'
import type { VersionedOutcomeAllocationInput } from '../../shared/allocation'
import type { CostAllocationVersion } from '../../shared/allocation'

const versions = [
  { id: 'active-1', status: 'active' },
  { id: 'draft-1', status: 'draft' },
  { id: 'archived-1', status: 'archived' }
] as CostAllocationVersion[]

describe('agreement outcome cost allocation tab helpers', () => {
  it('keeps the currently selected allocation version when available', () => {
    expect(resolveSelectedOutcomeAllocationVersionId('active-1', versions)).toBe('active-1')
  })

  it('prefers draft, then active, then the first available version', () => {
    expect(resolveSelectedOutcomeAllocationVersionId('', versions)).toBe('draft-1')
    expect(resolveSelectedOutcomeAllocationVersionId('', versions.filter(version => version.status !== 'draft'))).toBe('active-1')
    expect(resolveSelectedOutcomeAllocationVersionId('', [{ id: 'archived-1', status: 'archived' }] as CostAllocationVersion[]))
      .toBe('archived-1')
    expect(resolveSelectedOutcomeAllocationVersionId('', [])).toBe('')
  })

  it('extracts the most specific API error message', async () => {
    await expect(getOutcomeAllocationResponseErrorMessage(new Response(JSON.stringify({
      data: {
        message: 'Data message',
        details: [{ message: 'Detail message' }]
      },
      message: 'Top message',
      statusMessage: 'Status message'
    }), { statusText: 'Bad Request' }))).resolves.toBe('Data message')

    await expect(getOutcomeAllocationResponseErrorMessage(new Response(JSON.stringify({
      data: {
        details: [{ message: 'Detail message' }]
      }
    }), { statusText: 'Bad Request' }))).resolves.toBe('Detail message')
  })

  it('falls back to response status text when JSON parsing fails', async () => {
    await expect(getOutcomeAllocationResponseErrorMessage(new Response('{', {
      statusText: 'Bad Request'
    }))).resolves.toBe('Bad Request')
  })

  it('builds grouped allocation rows from configured associations', () => {
    const associations = [
      {
        id: 'association-1',
        commitmentType: 'commitment',
        commitmentTypeLabel: 'Commitments',
        yearId: 'year-1',
        yearLabel: '2026-2027',
        programFunding: 1000,
        streamBudgetId: 'budget-1',
        streamCommitmentId: 'commitment-1',
        commitmentLineLabel: 'GL 100',
        outcomeId: 'outcome-1',
        outcomeLabel: 'Outcome 1'
      },
      {
        id: 'association-2',
        commitmentType: 'commitment',
        commitmentTypeLabel: 'Commitments',
        yearId: 'year-1',
        yearLabel: '2026-2027',
        programFunding: 1000,
        streamBudgetId: 'budget-1',
        streamCommitmentId: 'commitment-2',
        commitmentLineLabel: 'GL 200',
        outcomeId: 'outcome-2',
        outcomeLabel: 'Outcome 2'
      }
    ] as const

    expect(buildOutcomeAllocationRows([...associations], {
      isExpanded: () => true,
      recordsLabel: 'records'
    })).toEqual([
      expect.objectContaining({
        id: 'type:commitment',
        rowType: 'commitmentType',
        associationCount: 2
      }),
      expect.objectContaining({
        id: 'year:commitment:year-1',
        rowType: 'fiscalYear',
        associationCount: 2,
        programFunding: 1000
      }),
      expect.objectContaining({
        id: 'association-1',
        rowType: 'association',
        association: associations[0]
      }),
      expect.objectContaining({
        id: 'association-2',
        rowType: 'association',
        association: associations[1]
      })
    ])
  })

  it('omits collapsed allocation child rows', () => {
    const association = {
      id: 'association-1',
      commitmentType: 'commitment',
      commitmentTypeLabel: 'Commitments',
      yearId: 'year-1',
      yearLabel: '2026-2027',
      programFunding: 1000,
      streamBudgetId: 'budget-1',
      streamCommitmentId: 'commitment-1',
      commitmentLineLabel: 'GL 100',
      outcomeId: 'outcome-1',
      outcomeLabel: 'Outcome 1'
    } as const

    expect(buildOutcomeAllocationRows([association], {
      isExpanded: groupId => groupId !== 'type:commitment',
      recordsLabel: 'records'
    })).toEqual([
      expect.objectContaining({
        id: 'type:commitment',
        rowType: 'commitmentType'
      })
    ])
  })

  it('builds allocation version endpoints from the allocations endpoint', () => {
    expect(getOutcomeAllocationVersionsEndpoint('/api/extensions/ext/agreements/1/allocations'))
      .toBe('/api/extensions/ext/agreements/1/allocation-versions')
    expect(getOutcomeAllocationVersionEndpoint('/api/extensions/ext/agreements/1/allocations', 'version-1'))
      .toBe('/api/extensions/ext/agreements/1/allocation-versions/version-1')
  })

  it('updates selected draft versions after create and delete responses', () => {
    expect(resolveCreatedDraftVersionId('current', {
      version: { id: 'draft-1', status: 'draft' } as CostAllocationVersion
    })).toBe('draft-1')
    expect(resolveCreatedDraftVersionId('current', {})).toBe('current')
    expect(resolveDeletedDraftVersionId('draft-1', 'draft-1')).toBe('')
    expect(resolveDeletedDraftVersionId('active-1', 'draft-1')).toBe('active-1')
  })

  it('builds save request bodies for active allocations', () => {
    const allocations = [{
      allocationVersionId: 'version-1',
      commitmentType: 'commitment',
      agreementBudgetFiscalYearId: 'year-1',
      streamCommitmentId: 'commitment-1',
      outcomeId: 'outcome-1',
      allocationMethod: 'amount',
      allocationValue: 10
    }] as const

    expect(buildSaveOutcomeAllocationsRequestBody('version-1', [...allocations])).toEqual({
      allocationVersionId: 'version-1',
      allocations
    })
  })

  it('sends save requests with the selected allocation version payload', async () => {
    const allocations: VersionedOutcomeAllocationInput[] = [{
      allocationVersionId: 'version-1',
      commitmentType: 'commitment',
      agreementBudgetFiscalYearId: 'year-1',
      streamCommitmentId: 'commitment-1',
      outcomeId: 'outcome-1',
      allocationMethod: 'amount',
      allocationValue: 10
    }]
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    await expect(saveOutcomeAllocationsRequest('/allocations', 'version-1', allocations, fetcher)).resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledWith('/allocations', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        allocationVersionId: 'version-1',
        allocations
      })
    })
  })

  it('raises API response messages from save requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { message: 'Cannot save allocations' }
    }), {
      status: 400,
      statusText: 'Bad Request'
    }))

    await expect(saveOutcomeAllocationsRequest('/allocations', 'version-1', [], fetcher))
      .rejects.toThrow('Cannot save allocations')
  })

  it('sends complete and draft delete requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    await expect(completeOutcomeAllocationVersionRequest('/allocation-versions/version-1/complete', fetcher))
      .resolves.toBeUndefined()
    await expect(deleteOutcomeAllocationDraftVersionRequest('/allocation-versions/version-1', fetcher))
      .resolves.toBeUndefined()

    expect(fetcher).toHaveBeenNthCalledWith(1, '/allocation-versions/version-1/complete', { method: 'POST' })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/allocation-versions/version-1', { method: 'DELETE' })
  })

  it('skips completion when already completing, not editable, or missing a version', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const baseOptions = {
      isCompleting: ref(false),
      canEditSelectedVersion: true,
      selectedVersionId: 'version-1',
      validationIssueCount: 0,
      validationMessage: '',
      locale: 'en',
      saveError: ref(''),
      save,
      refresh: vi.fn().mockResolvedValue(undefined),
      buildCompleteRequestUrl: (versionId: string) => `/versions/${versionId}/complete`,
      toast: { add: vi.fn() },
      completeRequest: vi.fn().mockResolvedValue(undefined)
    }

    await completeOutcomeAllocationSelectedVersion({ ...baseOptions, isCompleting: ref(true) })
    await completeOutcomeAllocationSelectedVersion({ ...baseOptions, canEditSelectedVersion: false })
    await completeOutcomeAllocationSelectedVersion({ ...baseOptions, selectedVersionId: '' })

    expect(save).not.toHaveBeenCalled()
  })

  it('shows validation errors before saving completion requests', async () => {
    const options = {
      isCompleting: ref(false),
      canEditSelectedVersion: true,
      selectedVersionId: 'version-1',
      validationIssueCount: 1,
      validationMessage: 'The full agreement budget must be allocated.',
      locale: 'en',
      saveError: ref(''),
      save: vi.fn().mockResolvedValue(true),
      refresh: vi.fn().mockResolvedValue(undefined),
      buildCompleteRequestUrl: (versionId: string) => `/versions/${versionId}/complete`,
      toast: { add: vi.fn() },
      completeRequest: vi.fn().mockResolvedValue(undefined)
    }

    await completeOutcomeAllocationSelectedVersion(options)

    expect(options.toast.add).toHaveBeenCalledWith({
      title: 'Error',
      description: 'The full agreement budget must be allocated.',
      color: 'error'
    })
    expect(options.save).not.toHaveBeenCalled()
    expect(options.completeRequest).not.toHaveBeenCalled()
  })

  it('saves, completes, refreshes, and shows success for valid completion requests', async () => {
    const options = {
      isCompleting: ref(false),
      canEditSelectedVersion: true,
      selectedVersionId: 'version-1',
      validationIssueCount: 0,
      validationMessage: '',
      locale: 'en',
      saveError: ref('previous'),
      save: vi.fn().mockResolvedValue(true),
      refresh: vi.fn().mockResolvedValue(undefined),
      buildCompleteRequestUrl: (versionId: string) => `/versions/${versionId}/complete`,
      toast: { add: vi.fn() },
      completeRequest: vi.fn().mockResolvedValue(undefined)
    }

    await completeOutcomeAllocationSelectedVersion(options)

    expect(options.saveError.value).toBe('')
    expect(options.save).toHaveBeenCalled()
    expect(options.completeRequest).toHaveBeenCalledWith('/versions/version-1/complete')
    expect(options.refresh).toHaveBeenCalled()
    expect(options.toast.add).toHaveBeenCalledWith({
      title: 'Success',
      description: 'Cost allocation activated.',
      color: 'success'
    })
    expect(options.isCompleting.value).toBe(false)
  })

  it('does not complete when saving the version fails', async () => {
    const options = {
      isCompleting: ref(false),
      canEditSelectedVersion: true,
      selectedVersionId: 'version-1',
      validationIssueCount: 0,
      validationMessage: '',
      locale: 'en',
      saveError: ref(''),
      save: vi.fn().mockResolvedValue(false),
      refresh: vi.fn().mockResolvedValue(undefined),
      buildCompleteRequestUrl: (versionId: string) => `/versions/${versionId}/complete`,
      toast: { add: vi.fn() },
      completeRequest: vi.fn().mockResolvedValue(undefined)
    }

    await completeOutcomeAllocationSelectedVersion(options)

    expect(options.completeRequest).not.toHaveBeenCalled()
    expect(options.refresh).not.toHaveBeenCalled()
    expect(options.isCompleting.value).toBe(false)
  })

  it('stores and toasts completion request errors', async () => {
    const options = {
      isCompleting: ref(false),
      canEditSelectedVersion: true,
      selectedVersionId: 'version-1',
      validationIssueCount: 0,
      validationMessage: '',
      locale: 'en',
      saveError: ref(''),
      save: vi.fn().mockResolvedValue(true),
      refresh: vi.fn().mockResolvedValue(undefined),
      buildCompleteRequestUrl: (versionId: string) => `/versions/${versionId}/complete`,
      toast: { add: vi.fn() },
      completeRequest: vi.fn().mockRejectedValue(new Error('Cannot complete'))
    }

    await completeOutcomeAllocationSelectedVersion(options)

    expect(options.saveError.value).toBe('Cannot complete')
    expect(options.toast.add).toHaveBeenCalledWith({
      title: 'Error',
      description: 'Cannot complete',
      color: 'error'
    })
    expect(options.refresh).not.toHaveBeenCalled()
    expect(options.isCompleting.value).toBe(false)
  })

  it('returns localized outcome allocation toast text', () => {
    expect(getOutcomeAllocationToastText('en', 'saved')).toEqual({
      title: 'Success',
      description: 'Allocation saved.'
    })
    expect(getOutcomeAllocationToastText('fr', 'deleted')).toEqual({
      title: 'Succes',
      description: 'Brouillon supprime.'
    })
    expect(getOutcomeAllocationToastText('en', 'error')).toEqual({
      title: 'Error',
      description: ''
    })
  })
})
