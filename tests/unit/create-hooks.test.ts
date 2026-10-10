import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transaction } from 'kysely'
import type {
  GcsExtensionAgreementDeleteGuardHookPayload,
  GcsExtensionAgreementStreamChangeGuardHookPayload,
  GcsExtensionAgreementLifecycleLockHookPayload,
  GcsExtensionAgreementPaymentMutationGuardHookPayload,
  GcsExtensionDisableGuardHookPayload,
  GcsExtensionStatusReferenceGuardHookPayload
} from '@gcs-ssc/extensions/server'
import { EXTENSION_KEY } from '../../shared/allocation'

const allocationDataMocks = vi.hoisted(() => ({
  generatedPaymentStatusResurrectionExceedsCoverage: vi.fn(),
  lockAgreementAllocationAdvisory: vi.fn(),
  lockAgreementAllocationLifecycle: vi.fn(),
  lockOutcomeCostAllocationScope: vi.fn()
}))

vi.mock('../../server/allocation-data', () => allocationDataMocks)

class WriteDb {
  readonly selectedTables: string[] = []
  agreementLifecycleLocked = false
  ownedTableQueriedBeforeLifecycleLock = false
  allocationHistoryId: string | null = null
  allocationHistoryStatusId: string | null = null
  allocationHistoryDeleted = false
  agencyEnabled = true
  extensionTablesExist = true
  generatedPayment = false
  currentPaymentStatus = 'denied'
  generatedPaymentIds = new Set<string>()
  generatedCommitment = false
  generatedCommitmentLine = false

  getExecutor() {
    return this
  }

  withPlugins() {
    return this
  }

  transformQuery(query: unknown) {
    return query
  }

  compileQuery(query: unknown) {
    return {
      query,
      sql: '',
      parameters: []
    }
  }

  async executeQuery() {
    const tableName = this.extensionTablesExist ? 'migrated-table' : null
    return {
      rows: [{
        commitment_lines_table: tableName,
        versions_table: tableName
      }]
    }
  }

  selectFrom(table: string) {
    this.selectedTables.push(table)
    if (table.startsWith('extensions.gcs_outcome_cost_allocation_') && !this.agreementLifecycleLocked) {
      this.ownedTableQueriedBeforeLifecycleLock = true
    }
    const wheres: unknown[][] = []
    const query = {
      innerJoin: () => query,
      where: (...args: unknown[]) => {
        wheres.push(args)
        return query
      },
      select: () => query,
      forUpdate: () => query,
      distinct: () => query,
      orderBy: () => query,
      execute: async () => table === 'Funding_Case_Agreement_Profile'
        ? [{ id: 'agreement-1' }]
        : [],
      executeTakeFirst: async () => {
        if (table === 'extensions.agency_enablement' || table === 'Funding_Case_Agreement_Profile') {
          return this.agencyEnabled ? { id: 'enabled-scope-1', agency_id: 'agency-1' } : undefined
        }
        if (table === 'Funding_Case_Agreement_Payment') {
          const requestedIds = wheres.find(where => where[0] === 'Funding_Case_Agreement_Payment.id')?.[2]
          const includesGeneratedDestination = Array.isArray(requestedIds)
            && requestedIds.some(id => this.generatedPaymentIds.has(String(id)))
          return this.generatedPayment || includesGeneratedDestination
            ? { id: 'payment-1', egcs_fc_status: this.currentPaymentStatus, status_terminal: true }
            : undefined
        }
        if (table === 'Common_Status') {
          return { egcs_cn_terminal: false }
        }
        if (table === 'extensions.gcs_outcome_cost_allocation_commitment_lines') {
          const generated = wheres.some(where => where[0] === 'generated_commitment_id')
            ? this.generatedCommitment
            : this.generatedCommitmentLine
          return generated ? { id: 'provenance-1' } : undefined
        }
        if (table === 'extensions.gcs_outcome_cost_allocation_versions as allocation_version') {
          const requestedStatus = wheres.find(
            where => where[0] === 'allocation_version.lifecycle_status_id'
          )?.[2]
          return this.allocationHistoryId
            && !this.allocationHistoryDeleted
            && requestedStatus === this.allocationHistoryStatusId
            ? { id: this.allocationHistoryId }
            : undefined
        }
        return this.allocationHistoryId ? { id: this.allocationHistoryId } : undefined
      }
    }
    return query
  }
}

type Hook = (payload: never) => Promise<void> | void

const loadHooks = async () => {
  const hooks = new Map<string, Hook>()
  const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
    nitroApp: { hooks: { hook: (name: string, handler: Hook) => void } }
  ) => void
  plugin({ hooks: { hook: (name, handler) => { hooks.set(name, handler) } } })
  return {
    names: [...hooks.keys()],
    disable: hooks.get('gcs:extension:disable-guard') as unknown as (payload: GcsExtensionDisableGuardHookPayload) => Promise<void>,
    lifecycle: hooks.get('gcs:extension:agreement-lifecycle-lock') as unknown as (payload: GcsExtensionAgreementLifecycleLockHookPayload) => Promise<void>,
    agreementDelete: hooks.get('gcs:extension:agreement-delete-guard') as unknown as (payload: GcsExtensionAgreementDeleteGuardHookPayload) => Promise<void>,
    streamChange: hooks.get('gcs:extension:agreement-stream-change-guard') as unknown as (payload: GcsExtensionAgreementStreamChangeGuardHookPayload) => Promise<void>,
    paymentMutation: hooks.get('gcs:extension:agreement-payment-mutation-guard') as unknown as (payload: GcsExtensionAgreementPaymentMutationGuardHookPayload) => Promise<void>,
    statusReference: hooks.get('gcs:extension:status-reference-guard') as unknown as (payload: GcsExtensionStatusReferenceGuardHookPayload) => Promise<void>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  allocationDataMocks.lockAgreementAllocationLifecycle.mockImplementation(async (db: WriteDb) => {
    db.agreementLifecycleLocked = true
    return 'stream-1'
  })
  allocationDataMocks.lockAgreementAllocationAdvisory.mockResolvedValue(undefined)
  allocationDataMocks.lockOutcomeCostAllocationScope.mockResolvedValue(undefined)
  allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage.mockResolvedValue(false)
})

describe('outcome cost allocation lifecycle hooks', () => {
  it('registers lifecycle guards without superseded create handlers', async () => {
    const { names } = await loadHooks()
    expect(names).toEqual([
      'gcs:extension:disable-guard',
      'gcs:extension:agreement-lifecycle-lock',
      'gcs:extension:agreement-delete-guard',
      'gcs:extension:agreement-stream-change-guard',
      'gcs:extension:agreement-payment-mutation-guard',
      'gcs:extension:status-reference-guard'
    ])
  })

  it('retains disable protection for legacy generated commitments under lifecycle locks', async () => {
    const { disable } = await loadHooks()
    const db = new WriteDb()
    db.generatedCommitmentLine = true

    await expect(disable({
      extensionKey: EXTENSION_KEY,
      event: {},
      db: db as unknown as Transaction<unknown>,
      agencyId: 'agency-1',
      streamId: 'stream-1',
      scope: 'stream'
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_DISABLE_BLOCKED',
      statusCode: 409
    })
    expect(allocationDataMocks.lockOutcomeCostAllocationScope).toHaveBeenCalledWith(db, 'agency-1', 'stream-1')
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(db, 'agreement-1')
    expect(db.ownedTableQueriedBeforeLifecycleLock).toBe(false)
  })

  it('blocks deletion of a status referenced by active allocation history', async () => {
    const { statusReference } = await loadHooks()
    const db = new WriteDb()
    db.allocationHistoryId = 'version-1'
    db.allocationHistoryStatusId = 'status-1'

    await expect(statusReference({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agencyId: 'agency-1',
      statusId: 'status-1'
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_STATUS_REFERENCED',
      statusCode: 409,
      localizedMessage: {
        en: expect.any(String),
        fr: expect.any(String)
      }
    })
  })

  it.each([
    ['an unrelated status', { allocationHistoryStatusId: 'other-status' }],
    ['deleted allocation history', { allocationHistoryStatusId: 'status-1', allocationHistoryDeleted: true }]
  ])('allows deletion of %s', async (_label, state) => {
    const { statusReference } = await loadHooks()
    const db = new WriteDb()
    db.allocationHistoryId = 'version-1'
    Object.assign(db, state)

    await expect(statusReference({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agencyId: 'agency-1',
      statusId: 'status-1'
    })).resolves.toBeUndefined()
  })

  it('takes the agreement advisory lock in the host pre-row lifecycle phase', async () => {
    const { lifecycle } = await loadHooks()
    const db = new WriteDb()

    await lifecycle({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      currentStreamId: 'stream-1',
      targetStreamIds: ['stream-1', 'stream-2']
    })

    expect(allocationDataMocks.lockAgreementAllocationAdvisory).toHaveBeenCalledWith(
      db,
      'agreement-1'
    )
  })

  it('allows agreement deletion when no allocation history or generated provenance exists', async () => {
    const { agreementDelete } = await loadHooks()
    const db = new WriteDb()

    await expect(agreementDelete({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      streamId: 'stream-1'
    })).resolves.toBeUndefined()

    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(db, 'agreement-1')
  })

  it.each([
    ['allocation history', { allocationHistoryId: 'version-1' }],
    ['generated provenance', { generatedCommitmentLine: true }]
  ])('blocks agreement deletion when %s exists', async (_label, state) => {
    const { agreementDelete } = await loadHooks()
    const db = new WriteDb()
    Object.assign(db, state)

    await expect(agreementDelete({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      streamId: 'stream-1'
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_AGREEMENT_DELETE_BLOCKED',
      statusCode: 409,
      localizedMessage: {
        en: expect.any(String),
        fr: expect.any(String)
      }
    })
  })

  it('blocks sensitive generated-payment edits with a stable bilingual conflict', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedPayment = true

    await expect(paymentMutation({
      operation: 'payment.update',
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      changes: { egcs_fc_paymentamount: '30.00' }
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
      statusCode: 409,
      localizedMessage: {
        en: expect.any(String),
        fr: expect.any(String)
      }
    })
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(db, 'agreement-1')
  })

  it('locks and rejects a denied generated-payment resurrection that exceeds coverage', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedPayment = true
    allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage.mockResolvedValueOnce(true)

    await expect(paymentMutation({
      agreementFinancials: { getPaymentCalculation: vi.fn(), getClaimRecoveryProjection: vi.fn(async () => ({ agreementId: 'agreement-1', entries: [] })), getRecordedPaidToDate: vi.fn(), getPaidAccountingProjection: vi.fn(), getCommitmentPaymentCapacity: vi.fn(), getCommitmentLinePaymentCoverage: vi.fn(), validatePaymentAllocations: vi.fn() },
      operation: 'payment.status-change',
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      currentStatusId: 'denied',
      nextStatusId: 'pendingapproval'
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING',
      statusCode: 409
    })
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(db, 'agreement-1')
    expect(db.ownedTableQueriedBeforeLifecycleLock).toBe(false)
    expect(allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage).toHaveBeenCalledWith(db, 'payment-1', expect.objectContaining({ validatePaymentAllocations: expect.any(Function) }))
  })

  it('uses the locked payment status instead of a stale caller status for resurrection coverage', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedPayment = true
    db.currentPaymentStatus = 'denied'
    allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage.mockResolvedValueOnce(true)

    await expect(paymentMutation({
      agreementFinancials: { getPaymentCalculation: vi.fn(), getClaimRecoveryProjection: vi.fn(async () => ({ agreementId: 'agreement-1', entries: [] })), getRecordedPaidToDate: vi.fn(), getPaidAccountingProjection: vi.fn(), getCommitmentPaymentCapacity: vi.fn(), getCommitmentLinePaymentCoverage: vi.fn(), validatePaymentAllocations: vi.fn() },
      operation: 'payment.status-change',
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      currentStatusId: 'inprogress',
      nextStatusId: 'pendingapproval'
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING',
      statusCode: 409
    })
    expect(allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage).toHaveBeenCalledWith(
      db,
      'payment-1',
      expect.objectContaining({ validatePaymentAllocations: expect.any(Function) })
    )
  })

  it('allows non-generated, ordinary-field, and covered generated payment mutations', async () => {
    const { paymentMutation } = await loadHooks()
    const ordinaryDb = new WriteDb()

    await expect(paymentMutation({
      operation: 'payment.delete',
      event: {},
      db: ordinaryDb as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1'
    })).resolves.toBeUndefined()
    await expect(paymentMutation({
      operation: 'payment.update',
      event: {},
      db: ordinaryDb as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      changes: { egcs_fc_comment: 'Ordinary note' }
    })).resolves.toBeUndefined()
    await expect(paymentMutation({
      operation: 'payment-line.create',
      event: {},
      db: ordinaryDb as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      changes: { egcs_fc_amount: expect.anything() }
    })).resolves.toBeUndefined()
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledTimes(3)
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(
      ordinaryDb,
      'agreement-1'
    )

    const generatedDb = new WriteDb()
    generatedDb.generatedPayment = true
    await expect(paymentMutation({
      operation: 'payment.update',
      event: {},
      db: generatedDb as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      changes: { egcs_fc_comment: 'Allowed note' }
    })).resolves.toBeUndefined()
    await expect(paymentMutation({
      agreementFinancials: { getPaymentCalculation: vi.fn(), getClaimRecoveryProjection: vi.fn(async () => ({ agreementId: 'agreement-1', entries: [] })), getRecordedPaidToDate: vi.fn(), getPaidAccountingProjection: vi.fn(), getCommitmentPaymentCapacity: vi.fn(), getCommitmentLinePaymentCoverage: vi.fn(), validatePaymentAllocations: vi.fn() },
      operation: 'payment.status-change',
      event: {},
      db: generatedDb as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      currentStatusId: 'denied',
      nextStatusId: 'pendingapproval'
    })).resolves.toBeUndefined()
    expect(allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage).toHaveBeenCalledWith(
      generatedDb,
      'payment-1',
      expect.objectContaining({ validatePaymentAllocations: expect.any(Function) })
    )
  })

  it('uses the payment-line path for generated payment line conflicts', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedPayment = true

    await expect(paymentMutation({
      operation: 'payment-line.delete',
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'payment-1',
      paymentLineId: 'line-1'
    })).rejects.toMatchObject({
      details: [{ path: 'paymentLineId' }]
    })
  })

  it('blocks an ordinary payment from being reassigned to a generated commitment', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedCommitment = true

    await expect(paymentMutation({
      operation: 'payment.update',
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'ordinary-payment',
      changes: { egcs_fc_fundingagreementcommitment: 'generated-commitment' }
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
      statusCode: 409,
      details: [{ path: 'paymentId' }]
    })
  })

  it('blocks an ordinary payment line from being reassigned to a generated payment', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedPaymentIds.add('generated-payment')

    await expect(paymentMutation({
      operation: 'payment-line.update',
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'ordinary-payment',
      paymentLineId: 'ordinary-line',
      changes: { egcs_fc_fundingagreementpayment: 'generated-payment' }
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
      statusCode: 409,
      details: [{ path: 'paymentLineId' }]
    })
  })

  it('blocks an ordinary payment line from targeting generated commitment-line provenance', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedCommitmentLine = true

    await expect(paymentMutation({
      operation: 'payment-line.update',
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      paymentId: 'ordinary-payment',
      paymentLineId: 'ordinary-line',
      changes: { egcs_fc_fundingagreementcommitmentline: 'generated-line' }
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_GENERATED_PAYMENT_IMMUTABLE',
      statusCode: 409,
      details: [{ path: 'paymentLineId' }]
    })
  })

  it('blocks agreement stream reassignment after locking both scopes when allocation history exists', async () => {
    const { streamChange } = await loadHooks()
    const db = new WriteDb()
    db.allocationHistoryId = 'version-1'

    await expect(streamChange({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      currentStreamId: 'stream-2',
      nextStreamId: 'stream-1'
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_AGREEMENT_STREAM_CHANGE_BLOCKED',
      statusCode: 409
    })

    expect(allocationDataMocks.lockOutcomeCostAllocationScope.mock.calls).toEqual([
      [db, 'agency-1', 'stream-1'],
      [db, 'agency-1', 'stream-2']
    ])
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(
      db,
      'agreement-1'
    )
  })

  it('blocks agreement stream reassignment with history after agency disablement', async () => {
    const { streamChange } = await loadHooks()
    const db = new WriteDb()
    db.agencyEnabled = false
    db.allocationHistoryId = 'version-1'

    await expect(streamChange({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      currentStreamId: 'stream-1',
      nextStreamId: 'stream-2'
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_AGREEMENT_STREAM_CHANGE_BLOCKED',
      statusCode: 409
    })

    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(
      db,
      'agreement-1'
    )
  })

  it('allows agreement stream reassignment when no allocation history exists', async () => {
    const { streamChange } = await loadHooks()
    const db = new WriteDb()

    await expect(streamChange({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      currentStreamId: 'stream-1',
      nextStreamId: 'stream-2'
    })).resolves.toBeUndefined()
  })

  it('skips owned-table lifecycle queries when the extension has never been enabled', async () => {
    const { agreementDelete, paymentMutation, streamChange } = await loadHooks()
    const db = new WriteDb()
    db.extensionTablesExist = false

    await paymentMutation({
      event: {},
      db: db as unknown as Transaction<unknown>,
      operation: 'payment.delete',
      agreementId: 'agreement-1',
      paymentId: 'payment-1'
    })
    await streamChange({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      currentStreamId: 'stream-1',
      nextStreamId: 'stream-2'
    })
    await agreementDelete({
      event: {},
      db: db as unknown as Transaction<unknown>,
      agreementId: 'agreement-1',
      agencyId: 'agency-1',
      streamId: 'stream-1'
    })

    expect(db.selectedTables).not.toContain('extensions.gcs_outcome_cost_allocation_versions')
    expect(db.selectedTables).not.toContain('extensions.gcs_outcome_cost_allocation_commitment_lines')
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).not.toHaveBeenCalled()
    expect(allocationDataMocks.lockOutcomeCostAllocationScope).not.toHaveBeenCalled()
  })

})
