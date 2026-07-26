import { describe, expect, it, vi } from 'vitest'
import type { GcsExtensionRouteEvent } from '@gcs-ssc/extensions/server'
import {
  bilingualAllocationIssues,
  createOutcomeCostAllocationUserError,
  getOutcomeCostAllocationErrorMessage,
  getOutcomeCostAllocationErrorMessages,
  localizeAllocationIssues
} from '../../server/errors'

const serverMocks = vi.hoisted(() => ({
  getHeader: vi.fn((event: { acceptLanguage?: string }) => event.acceptLanguage)
}))

vi.mock('@gcs-ssc/extensions/server', async () => {
  const actual = await vi.importActual<typeof import('@gcs-ssc/extensions/server')>(
    '@gcs-ssc/extensions/server'
  )

  return {
    ...actual,
    getGcsExtensionRequestHeader: serverMocks.getHeader
  }
})

const createRouteEvent = (acceptLanguage?: string): GcsExtensionRouteEvent => {
  return {
    acceptLanguage,
    context: {
      $db: {}
    }
  } as GcsExtensionRouteEvent
}

describe('outcome cost allocation errors', () => {
  it('resolves known error codes in the request language', () => {
    expect(getOutcomeCostAllocationErrorMessage(
      createRouteEvent('fr-CA,fr;q=0.9'),
      'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED'
    )).toBe('Seules les repartitions des couts en ebauche peuvent etre modifiees.')

    expect(getOutcomeCostAllocationErrorMessage(
      createRouteEvent('en-CA'),
      'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED'
    )).toBe('Only draft cost allocations can be edited.')

    expect(getOutcomeCostAllocationErrorMessages(
      'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING'
    )).toEqual({
      en: 'The active cost allocation has no positive allocations for this commitment type.',
      fr: 'La repartition des couts active ne contient aucune repartition positive pour ce type d engagement.'
    })

    expect(getOutcomeCostAllocationErrorMessages(
      'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_TYPE_DISABLED'
    )).toEqual({
      en: 'One saved allocation uses a commitment type that is no longer enabled.',
      fr: 'Une repartition enregistree utilise un type d engagement qui n est plus autorise.'
    })
  })

  it('falls back to the generic English error for absent and unknown codes', () => {
    const generic = {
      en: 'Outcome cost allocations are invalid.',
      fr: 'Les repartitions des couts par resultat sont invalides.'
    }

    expect(getOutcomeCostAllocationErrorMessages(undefined)).toEqual(generic)
    expect(getOutcomeCostAllocationErrorMessages('UNKNOWN_CODE')).toEqual(generic)
    expect(getOutcomeCostAllocationErrorMessage(createRouteEvent(), 'UNKNOWN_CODE'))
      .toBe(generic.en)
  })

  it('creates bilingual user errors with and without field details', () => {
    expect(createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_DRAFT_DELETE_REQUIRED',
      'allocationVersionId'
    )).toMatchObject({
      name: 'GcsExtensionUserError',
      code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_DELETE_REQUIRED',
      message: 'Only draft cost allocations can be deleted.',
      localizedMessage: {
        en: 'Only draft cost allocations can be deleted.',
        fr: 'Seules les repartitions des couts en ebauche peuvent etre supprimees.'
      },
      details: [{
        path: 'allocationVersionId',
        code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_DELETE_REQUIRED'
      }]
    })

    expect(createOutcomeCostAllocationUserError(
      'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED'
    ).details).toBeUndefined()
  })

  it('localizes validation issues while retaining their paths and codes', () => {
    const issues = [{
      path: 'years.2026',
      code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
      message: 'apiErrors.extensions.outcome_cost_allocation.year_missing'
    }]

    expect(localizeAllocationIssues(createRouteEvent('fr'), issues)).toEqual([{
      path: 'years.2026',
      code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
      message: 'Le budget complet de l entente doit etre reparti.'
    }])

    expect(bilingualAllocationIssues(issues)).toEqual([{
      path: 'years.2026',
      code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
      message: {
        en: 'The full agreement budget must be allocated.',
        fr: 'Le budget complet de l entente doit etre reparti.'
      }
    }])
  })
})
