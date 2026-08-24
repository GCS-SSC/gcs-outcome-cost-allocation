import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GcsExtensionRawRouteHandler,
  GcsExtensionRouteContext
} from '@gcs-ssc/extensions/server'

const routeMocks = vi.hoisted(() => ({
  asOutcomeCostAllocationDb: vi.fn((db: unknown) => ({ wrapped: db })),
  createDraftAllocationVersion: vi.fn(),
  deleteDraftAllocationVersion: vi.fn(),
  getAgreementBudgetYears: vi.fn(),
  getAgreementOutcomes: vi.fn(),
  getAllocationVersions: vi.fn(),
  getSavedAllocations: vi.fn(),
  getStreamCommitmentLines: vi.fn(),
  getStreamCommitmentTypes: vi.fn(),
  saveAllocations: vi.fn()
}))

const createReadBody = (
  value: unknown
): GcsExtensionRouteContext['readBody'] => async <T>() => value as T

vi.mock('@gcs-ssc/extensions/server', async () => {
  const actual = await vi.importActual<typeof import('@gcs-ssc/extensions/server')>(
    '@gcs-ssc/extensions/server'
  )

  return {
    ...actual,
    defineGcsExtensionRouteHandler: (handler: unknown) => handler
  }
})

vi.mock('../../server/db', () => ({
  asOutcomeCostAllocationDb: routeMocks.asOutcomeCostAllocationDb
}))

vi.mock('../../server/allocation-data', () => ({
  createDraftAllocationVersion: routeMocks.createDraftAllocationVersion,
  deleteDraftAllocationVersion: routeMocks.deleteDraftAllocationVersion,
  getAgreementBudgetYears: routeMocks.getAgreementBudgetYears,
  getAgreementOutcomes: routeMocks.getAgreementOutcomes,
  getAllocationVersions: routeMocks.getAllocationVersions,
  getSavedAllocations: routeMocks.getSavedAllocations,
  getStreamCommitmentLines: routeMocks.getStreamCommitmentLines,
  getStreamCommitmentTypes: routeMocks.getStreamCommitmentTypes,
  saveAllocations: routeMocks.saveAllocations
}))

const createRouteContext = (
  overrides: Partial<GcsExtensionRouteContext> = {}
): GcsExtensionRouteContext => ({
  event: {
    context: {
      $db: { raw: true }
    }
  },
  db: { raw: true },
  params: {
    agreementId: 'agreement-1',
    allocationVersionId: 'version-1'
  },
  config: {},
  writeAuthorization: {
    lockAuthState: vi.fn(async () => undefined),
    authorizeCurrentEntity: vi.fn(async () => undefined)
  },
  entity: {
    agencyId: 'agency-1',
    streamId: 'stream-1'
  },
  readBody: createReadBody({}),
  getHeader: () => undefined,
  ...overrides
})

const invokeRoute = async <T>(
  route: GcsExtensionRawRouteHandler<T>,
  context: GcsExtensionRouteContext
): Promise<T> => await (
  route as unknown as (routeContext: GcsExtensionRouteContext) => Promise<T>
)(context)

describe('outcome allocation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeMocks.createDraftAllocationVersion.mockResolvedValue({
      id: 'version-1',
      status: 'draft'
    })
    routeMocks.deleteDraftAllocationVersion.mockResolvedValue(undefined)
    routeMocks.getAgreementBudgetYears.mockResolvedValue([])
    routeMocks.getAgreementOutcomes.mockResolvedValue([])
    routeMocks.getAllocationVersions.mockResolvedValue([])
    routeMocks.getSavedAllocations.mockResolvedValue([])
    routeMocks.getStreamCommitmentLines.mockResolvedValue([])
    routeMocks.getStreamCommitmentTypes.mockResolvedValue([])
    routeMocks.saveAllocations.mockResolvedValue(undefined)
  })

  it('requires Agreement delete access for the allocation-version DELETE handler', async () => {
    const extension = (await import('../../extension.config')).default
    const deleteHandler = extension.serverHandlers?.find(handler =>
      handler.method === 'delete'
      && handler.route.endsWith('/allocation-versions/[allocationVersionId]')
    )

    expect(deleteHandler?.rbac).toEqual(expect.objectContaining({
      subject: 'agreement',
      action: 'delete'
    }))
  })

  it('creates a draft for the requested agreement', async () => {
    const route = (await import('../../server/api/allocation-versions.post')).default

    await expect(invokeRoute(route, createRouteContext())).resolves.toEqual({
      ok: true,
      version: {
        id: 'version-1',
        status: 'draft'
      }
    })
    expect(routeMocks.asOutcomeCostAllocationDb).toHaveBeenCalledWith({ raw: true })
    expect(routeMocks.createDraftAllocationVersion).toHaveBeenCalledWith(
      { wrapped: { raw: true } },
      'agreement-1',
      { agencyId: 'agency-1', streamId: 'stream-1' },
      expect.objectContaining({
        lockAuthState: expect.any(Function),
        authorizeCurrentEntity: expect.any(Function)
      })
    )
  })

  it('soft-deletes a selected draft and defaults absent route parameters', async () => {
    const route = (await import('../../server/api/allocation-version.delete')).default

    await expect(invokeRoute(route, createRouteContext({
      params: {}
    }))).resolves.toEqual({ ok: true })
    expect(routeMocks.deleteDraftAllocationVersion).toHaveBeenCalledWith(
      { wrapped: { raw: true } },
      '',
      '',
      { agencyId: 'agency-1', streamId: 'stream-1' },
      expect.objectContaining({
        lockAuthState: expect.any(Function),
        authorizeCurrentEntity: expect.any(Function)
      })
    )
  })

  it('returns existing versions and all allocation reference data', async () => {
    const route = (await import('../../server/api/allocations.get')).default
    const versions = [{
      id: 'version-1',
      status: 'draft'
    }]
    routeMocks.getAllocationVersions.mockResolvedValue(versions)
    routeMocks.getAgreementOutcomes.mockResolvedValue([{ id: 'outcome-1' }])
    routeMocks.getAgreementBudgetYears.mockResolvedValue([{ id: 'year-1' }])
    routeMocks.getSavedAllocations.mockResolvedValue([{ outcomeId: 'outcome-1' }])
    routeMocks.getStreamCommitmentLines.mockResolvedValue([{ id: 'line-1' }])

    await expect(invokeRoute(route, createRouteContext())).resolves.toEqual({
      outcomes: [{ id: 'outcome-1' }],
      budgetYears: [{ id: 'year-1' }],
      commitmentTypes: [],
      versions,
      allocations: [{ outcomeId: 'outcome-1' }],
      streamCommitments: [{ id: 'line-1' }]
    })
    expect(routeMocks.createDraftAllocationVersion).not.toHaveBeenCalled()
    expect(routeMocks.getAgreementBudgetYears).toHaveBeenCalledWith(
      { wrapped: { raw: true } },
      'agreement-1',
      'stream-1'
    )
  })

  it('keeps allocation reads side-effect free when an agreement has no versions', async () => {
    const route = (await import('../../server/api/allocations.get')).default
    routeMocks.getAllocationVersions.mockResolvedValue([])

    await expect(invokeRoute(route, createRouteContext({
      params: {},
      entity: undefined
    }))).resolves.toMatchObject({
      versions: []
    })
    expect(routeMocks.createDraftAllocationVersion).not.toHaveBeenCalled()
    expect(routeMocks.getAllocationVersions).toHaveBeenCalledTimes(1)
    expect(routeMocks.getAgreementBudgetYears).toHaveBeenCalledWith(
      { wrapped: { raw: true } },
      '',
      ''
    )
  })

  it('validates and normalizes allocation save payloads', async () => {
    const route = (await import('../../server/api/allocations.put')).default
    const context = createRouteContext({
      readBody: createReadBody({
        allocationVersionId: 'version-1',
        allocations: [{
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'percentage',
          allocationValue: '25.5'
        }]
      })
    })

    await expect(invokeRoute(route, context)).resolves.toEqual({ ok: true })
    expect(routeMocks.saveAllocations).toHaveBeenCalledWith(
      { wrapped: { raw: true } },
      'agreement-1',
      'version-1',
      [{
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 25.5
      }],
      { agencyId: 'agency-1', streamId: 'stream-1' },
      expect.objectContaining({
        lockAuthState: expect.any(Function),
        authorizeCurrentEntity: expect.any(Function)
      }),
      true
    )
  })

  it.each([
    {
      body: {
        allocationVersionId: '',
        allocations: []
      },
      path: 'allocationVersionId'
    },
    {
      body: {
        allocationVersionId: 'version-1',
        allocations: [{
          commitmentType: '1',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: 100
        }]
      },
      path: 'allocations.0.streamCommitmentId'
    },
    {
      body: {
        allocationVersionId: 'version-1',
        allocations: [{
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: null
        }]
      },
      path: 'allocations.0.allocationValue'
    },
    {
      body: {
        allocationVersionId: 'version-1',
        allocations: [{
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: '1.00001'
        }]
      },
      path: 'allocations.0.allocationValue'
    },
    {
      body: {
        allocationVersionId: 'version-1',
        allocations: [{
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: 'year-1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: '1000000000000000'
        }]
      },
      path: 'allocations.0.allocationValue'
    }
  ])('returns a structured error for malformed allocation save payload at $path', async ({ body, path }) => {
    const route = (await import('../../server/api/allocations.put')).default
    const context = createRouteContext({
      readBody: createReadBody(body)
    })

    await expect(invokeRoute(route, context)).rejects.toMatchObject({
      name: 'GcsExtensionUserError',
      statusCode: 400,
      code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      localizedMessage: {
        en: 'Outcome cost allocations are invalid.',
        fr: 'Les repartitions des couts par resultat sont invalides.'
      },
      details: [{
        path,
        code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
      }]
    })
    expect(routeMocks.saveAllocations).not.toHaveBeenCalled()
  })

  it('translates known persistence constraints without exposing database messages', async () => {
    const route = (await import('../../server/api/allocations.put')).default
    routeMocks.saveAllocations.mockRejectedValue({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_allocation_coordinate_guard',
      message: 'private SQL detail'
    })

    await expect(invokeRoute(route, createRouteContext({
      readBody: createReadBody({
        allocationVersionId: 'version-1',
        allocations: []
      })
    }))).rejects.toMatchObject({
      name: 'GcsExtensionUserError',
      code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE',
      message: 'One allocation reference is no longer available for this agreement. Refresh the allocation and try again.',
      localizedMessage: {
        fr: 'Une reference de repartition n est plus disponible pour cette entente. Actualisez la repartition et reessayez.'
      },
      details: [{
        path: 'allocations',
        code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE'
      }]
    })
  })

  it.each([
    {
      sqlState: '23514',
      constraint: 'gcs_outcome_cost_allocation_method',
      expectedCode: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      expectedPath: 'allocations'
    },
    {
      sqlState: '23505',
      constraint: 'gcs_outcome_cost_allocation_one_draft_version',
      expectedCode: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EXISTS',
      expectedPath: 'allocationVersionId'
    },
    {
      sqlState: '23503',
      constraint: 'gcs_outcome_cost_allocation_allocations_outcome_id_fkey',
      expectedCode: 'GCS_OUTCOME_COST_ALLOCATION_STALE_COORDINATE',
      expectedPath: 'allocations'
    }
  ])(
    'translates $sqlState constraint $constraint to $expectedCode',
    async ({ sqlState, constraint, expectedCode, expectedPath }) => {
      const route = (await import('../../server/api/allocations.put')).default
      routeMocks.saveAllocations.mockRejectedValue({
        code: sqlState,
        constraint,
        message: 'private SQL detail'
      })

      await expect(invokeRoute(route, createRouteContext({
        readBody: createReadBody({
          allocationVersionId: 'version-1',
          allocations: []
        })
      }))).rejects.toMatchObject({
        name: 'GcsExtensionUserError',
        code: expectedCode,
        details: [{
          path: expectedPath,
          code: expectedCode
        }]
      })
    }
  )

  it('does not mask unknown persistence errors', async () => {
    const route = (await import('../../server/api/allocations.put')).default
    const error = Object.assign(new Error('database unavailable'), {
      code: '08006'
    })
    routeMocks.saveAllocations.mockRejectedValue(error)

    await expect(invokeRoute(route, createRouteContext({
      readBody: createReadBody({
        allocationVersionId: 'version-1',
        allocations: []
      })
    }))).rejects.toBe(error)
  })
})
