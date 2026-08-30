import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Kysely, Transaction } from 'kysely'
import type { GcsExtensionCreateOperation } from '@gcs-ssc/extensions'
import type {
  GcsExtensionAgreementDeleteGuardHookPayload,
  GcsExtensionAgreementStreamChangeGuardHookPayload,
  GcsExtensionAgreementLifecycleLockHookPayload,
  GcsExtensionAgreementPaymentMutationGuardHookPayload,
  GcsExtensionCreateOperationContext,
  GcsExtensionCreateOperationHookPayload,
  GcsExtensionStatusReferenceGuardHookPayload
} from '@gcs-ssc/extensions/server'
import { EXTENSION_KEY } from '../../shared/allocation'

const allocationDataMocks = vi.hoisted(() => ({
  getGeneratedCommitmentLines: vi.fn(),
  getGeneratedPaymentLines: vi.fn(),
  generatedPaymentStatusResurrectionExceedsCoverage: vi.fn(),
  lockAgreementAllocationAdvisory: vi.fn(),
  lockAgreementAllocationLifecycle: vi.fn(),
  lockAndGetOutcomeCostAllocationConfig: vi.fn(),
  lockOutcomeCostAllocationScope: vi.fn()
}))

vi.mock('../../server/allocation-data', () => allocationDataMocks)

interface WriteRecord {
  operation: 'insert' | 'update'
  table: string
  values?: unknown
  update?: unknown
  wheres: unknown[][]
}

class WriteQuery {
  constructor(
    private readonly db: WriteDb,
    private readonly record: WriteRecord
  ) {}

  values(value: unknown) {
    this.record.values = value
    return this
  }

  set(value: unknown) {
    this.record.update = value
    return this
  }

  where(...args: unknown[]) {
    this.record.wheres.push(args)
    return this
  }

  returningAll() {
    return this
  }

  returning() {
    return this
  }

  async executeTakeFirstOrThrow() {
    if (this.record.table === 'Funding_Case_Agreement_Commitment') {
      return this.db.commitment
    }
    throw new Error(`Unexpected single-row write for ${this.record.table}`)
  }

  async execute() {
    return this.record.table === 'Funding_Case_Agreement_Commitment_Line'
      ? this.db.commitmentLines
      : []
  }
}

class WriteDb {
  readonly records: WriteRecord[] = []
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
  commitment = {
    id: 'commitment-1',
    egcs_fc_fundingagreement: 'agreement-1',
    egcs_fc_type: '1',
    egcs_fc_status: 'inprogress',
    egcs_fc_financialsystemnumber: null
  }

  commitmentLines = [
    {
      id: 'commitment-line-1',
      egcs_fc_commitmentlinenumber: 1
    },
    {
      id: 'commitment-line-2',
      egcs_fc_commitmentlinenumber: 2
    }
  ]

  insertInto(table: string) {
    return this.createQuery('insert', table)
  }

  updateTable(table: string) {
    return this.createQuery('update', table)
  }

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

  private createQuery(operation: WriteRecord['operation'], table: string) {
    const record: WriteRecord = {
      operation,
      table,
      wheres: []
    }
    this.records.push(record)
    return new WriteQuery(this, record)
  }
}

type Hook = (payload: GcsExtensionCreateOperationHookPayload) => Promise<void> | void

const loadHooks = async () => {
  const hooks: Hook[] = []
  const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
    nitroApp: {
      hooks: {
        hook: (name: string, handler: Hook) => void
      }
    }
  ) => void
  plugin({
    hooks: {
      hook: (_name, handler) => {
        hooks.push(handler)
      }
    }
  })
  expect(hooks).toHaveLength(8)
  return {
    commitment: hooks[0] as Hook,
    payment: hooks[1] as Hook,
    disable: hooks[2] as Hook,
    lifecycle: hooks[3] as unknown as (
      payload: GcsExtensionAgreementLifecycleLockHookPayload
    ) => Promise<void>,
    agreementDelete: hooks[4] as unknown as (
      payload: GcsExtensionAgreementDeleteGuardHookPayload
    ) => Promise<void>,
    streamChange: hooks[5] as unknown as (
      payload: GcsExtensionAgreementStreamChangeGuardHookPayload
    ) => Promise<void>,
    paymentMutation: hooks[6] as unknown as (
      payload: GcsExtensionAgreementPaymentMutationGuardHookPayload
    ) => Promise<void>,
    statusReference: hooks[7] as unknown as (
      payload: GcsExtensionStatusReferenceGuardHookPayload
    ) => Promise<void>
  }
}

const createContext = (
  db: WriteDb,
  overrides: Partial<GcsExtensionCreateOperationContext> = {}
): Omit<GcsExtensionCreateOperationContext, 'extensionKey'> => ({
  operation: 'agreement.commitments.create',
  phase: 'before-create',
  event: {},
  db: db as unknown as Transaction<unknown>,
  trx: db as unknown as Kysely<unknown>,
  agreementId: 'agreement-1',
  agencyId: 'agency-1',
  streamId: 'stream-1',
  scope: {
    type: 'agency',
    agencyId: 'agency-1'
  },
  config: {
    enabledCommitmentTypes: ['1']
  },
  validatedBody: {
    egcs_fc_type: '1'
  },
  ...overrides
})

const createPaymentContext = (
  db: WriteDb,
  overrides: Partial<GcsExtensionCreateOperationContext> = {}
) => createContext(db, {
  operation: 'agreement.payments.create',
  phase: 'after-create',
  validatedBody: {
    egcs_fc_fundingagreementcommitment: 'commitment-1',
    egcs_fc_fiscalyear: 'year-1',
    egcs_fc_paymentamount: '25.00'
  },
  createdRecord: {
    id: 'payment-1'
  },
  ...overrides
})

const createPayload = (
  operation: GcsExtensionCreateOperation,
  context: Omit<GcsExtensionCreateOperationContext, 'extensionKey'>,
  enabled = true
): GcsExtensionCreateOperationHookPayload => ({
  operation,
  enabledExtensionKeys: enabled ? new Set([EXTENSION_KEY]) : new Set(),
  contexts: {
    [EXTENSION_KEY]: context
  },
  results: []
})

const createGeneratedCommitmentLine = (
  suffix: '1' | '2',
  amount: number,
  allocationVersionId = 'version-1'
) => ({
  allocationVersionId,
  streamCommitmentId: `stream-commitment-${suffix}`,
  allocation: {
    commitmentType: '1',
    streamCommitmentId: `stream-commitment-${suffix}`,
    agreementBudgetFiscalYearId: 'year-1',
    outcomeId: `outcome-${suffix}`,
    allocationMethod: 'amount',
    allocationValue: amount.toFixed(4),
    amount: amount.toFixed(2)
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  allocationDataMocks.getGeneratedCommitmentLines.mockResolvedValue({
    status: 'continue'
  })
  allocationDataMocks.getGeneratedPaymentLines.mockResolvedValue({
    status: 'continue'
  })
  allocationDataMocks.lockAndGetOutcomeCostAllocationConfig.mockResolvedValue({
    enabledCommitmentTypes: ['1']
  })
  allocationDataMocks.lockAgreementAllocationLifecycle.mockImplementation(async (db: WriteDb) => {
    db.agreementLifecycleLocked = true
    return 'stream-1'
  })
  allocationDataMocks.lockAgreementAllocationAdvisory.mockResolvedValue(undefined)
  allocationDataMocks.lockOutcomeCostAllocationScope.mockResolvedValue(undefined)
  allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage.mockResolvedValue(false)
})

describe('outcome cost allocation create hooks', () => {
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
    expect(allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage).toHaveBeenCalledWith(db, 'payment-1')
  })

  it('uses the locked payment status instead of a stale caller status for resurrection coverage', async () => {
    const { paymentMutation } = await loadHooks()
    const db = new WriteDb()
    db.generatedPayment = true
    db.currentPaymentStatus = 'denied'
    allocationDataMocks.generatedPaymentStatusResurrectionExceedsCoverage.mockResolvedValueOnce(true)

    await expect(paymentMutation({
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
      'payment-1'
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
      'payment-1'
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

  it('registers both operations and gates disabled extensions before invoking allocation services', async () => {
    const hooks = await loadHooks()
    const db = new WriteDb()
    const commitmentPayload = createPayload(
      'agreement.commitments.create',
      createContext(db),
      false
    )
    const paymentPayload = createPayload(
      'agreement.payments.create',
      createPaymentContext(db),
      false
    )

    await hooks.commitment(commitmentPayload)
    await hooks.payment(paymentPayload)

    expect(commitmentPayload.results).toEqual([])
    expect(paymentPayload.results).toEqual([])
    expect(allocationDataMocks.getGeneratedCommitmentLines).not.toHaveBeenCalled()
    expect(allocationDataMocks.getGeneratedPaymentLines).not.toHaveBeenCalled()
  })

  it('continues commitment creation for invalid host types and extension-deferred types', async () => {
    const { commitment } = await loadHooks()
    const db = new WriteDb()
    const invalidPayload = createPayload(
      'agreement.commitments.create',
      createContext(db, {
        validatedBody: {
          egcs_fc_type: 'unsupported'
        }
      })
    )

    await commitment(invalidPayload)
    expect(invalidPayload.results).toEqual([{
      extensionKey: EXTENSION_KEY,
      result: {
        status: 'continue'
      }
    }])
    expect(allocationDataMocks.getGeneratedCommitmentLines).not.toHaveBeenCalled()

    const deferredPayload = createPayload(
      'agreement.commitments.create',
      createContext(db)
    )
    await commitment(deferredPayload)
    expect(deferredPayload.results[0]?.result).toEqual({
      status: 'continue'
    })
    expect(allocationDataMocks.getGeneratedCommitmentLines).toHaveBeenCalledWith(
      db,
      'agreement-1',
      'stream-1',
      '1',
      {
        enabledCommitmentTypes: ['1']
      }
    )
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(
      db,
      'agreement-1'
    )
    expect(
      allocationDataMocks.lockAgreementAllocationLifecycle.mock.invocationCallOrder[0]
    ).toBeLessThan(
      allocationDataMocks.getGeneratedCommitmentLines.mock.invocationCallOrder[0] as number
    )
  })

  it('rechecks enablement under the scope lock before taking the agreement lock', async () => {
    const { commitment } = await loadHooks()
    const db = new WriteDb()
    allocationDataMocks.lockAndGetOutcomeCostAllocationConfig.mockResolvedValue(null)
    const payload = createPayload(
      'agreement.commitments.create',
      createContext(db, { phase: 'after-create', createdRecord: db.commitment })
    )

    await commitment(payload)

    expect(payload.results[0]?.result).toEqual({ status: 'continue' })
    expect(allocationDataMocks.lockAndGetOutcomeCostAllocationConfig).toHaveBeenCalledWith(
      db,
      'agency-1',
      'stream-1'
    )
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).not.toHaveBeenCalled()
    expect(allocationDataMocks.getGeneratedCommitmentLines).not.toHaveBeenCalled()
  })

  it('fails closed when the agreement moved streams before its lifecycle lock', async () => {
    const { commitment, payment } = await loadHooks()
    const db = new WriteDb()
    allocationDataMocks.lockAgreementAllocationLifecycle.mockResolvedValue('stream-2')
    const commitmentPayload = createPayload(
      'agreement.commitments.create',
      createContext(db)
    )
    const paymentPayload = createPayload(
      'agreement.payments.create',
      createPaymentContext(db)
    )

    await expect(commitment(commitmentPayload)).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_SCOPE_CHANGED'
    })
    await expect(payment(paymentPayload)).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_SCOPE_CHANGED'
    })

    expect(commitmentPayload.results).toEqual([])
    expect(paymentPayload.results).toEqual([])
    expect(allocationDataMocks.getGeneratedCommitmentLines).not.toHaveBeenCalled()
    expect(allocationDataMocks.getGeneratedPaymentLines).not.toHaveBeenCalled()
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

  it('returns localized allocation issues without inserting a commitment', async () => {
    const { commitment } = await loadHooks()
    const db = new WriteDb()
    allocationDataMocks.getGeneratedCommitmentLines.mockResolvedValue({
      status: 'handled',
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED',
        path: 'allocationVersion',
        message: 'apiErrors.extensions.outcome_cost_allocation.active_required'
      }],
      lines: []
    })

    await expect(commitment(createPayload(
      'agreement.commitments.create',
      createContext(db)
    ))).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED',
      details: [{
        path: 'allocationVersion',
        code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED'
      }]
    })
    expect(db.records).toEqual([])
  })

  it('does not insert a parent or child record when the managed type has no positive allocation lines', async () => {
    const { commitment } = await loadHooks()
    const db = new WriteDb()
    allocationDataMocks.getGeneratedCommitmentLines.mockResolvedValue({
      status: 'handled',
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING',
        path: 'allocations',
        message: 'apiErrors.extensions.outcome_cost_allocation.commitment_lines_missing'
      }],
      lines: []
    })

    await expect(commitment(createPayload(
      'agreement.commitments.create',
      createContext(db)
    ))).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING',
      details: [{
        path: 'allocations',
        code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING'
      }]
    })
    expect(db.records).toEqual([])
  })

  it('inserts a generated commitment, its lines, and allocation provenance', async () => {
    const { commitment } = await loadHooks()
    const db = new WriteDb()
    allocationDataMocks.getGeneratedCommitmentLines.mockResolvedValue({
      status: 'handled',
      issues: [],
      lines: [
        createGeneratedCommitmentLine('1', 60),
        createGeneratedCommitmentLine('2', 40)
      ]
    })
    const payload = createPayload(
      'agreement.commitments.create',
      createContext(db, { phase: 'after-create', createdRecord: db.commitment })
    )

    await commitment(payload)

    expect(allocationDataMocks.getGeneratedCommitmentLines).toHaveBeenCalled()
    expect(payload.results).toEqual([{
      extensionKey: EXTENSION_KEY,
      result: {
        status: 'continue'
      }
    }])
    expect(db.records).toEqual([
      expect.objectContaining({
        operation: 'insert',
        table: 'Funding_Case_Agreement_Commitment_Line',
        values: [
          {
            egcs_fc_commitment: 'commitment-1',
            egcs_fc_commitmentlinenumber: 1,
            egcs_fc_transferpaymentstreamchartofaccount: 'stream-commitment-1',
            egcs_fc_amount: expect.anything()
          },
          {
            egcs_fc_commitment: 'commitment-1',
            egcs_fc_commitmentlinenumber: 2,
            egcs_fc_transferpaymentstreamchartofaccount: 'stream-commitment-2',
            egcs_fc_amount: expect.anything()
          }
        ]
      }),
      expect.objectContaining({
        operation: 'insert',
        table: 'extensions.gcs_outcome_cost_allocation_commitment_lines',
        values: [
          {
            allocation_version_id: 'version-1',
            generated_commitment_id: 'commitment-1',
            commitment_line_id: 'commitment-line-1',
            agreement_id: 'agreement-1',
            agreement_budget_fiscal_year_id: 'year-1',
            outcome_id: 'outcome-1',
            stream_commitment_id: 'stream-commitment-1',
            generated_amount: expect.anything()
          },
          {
            allocation_version_id: 'version-1',
            generated_commitment_id: 'commitment-1',
            commitment_line_id: 'commitment-line-2',
            agreement_id: 'agreement-1',
            agreement_budget_fiscal_year_id: 'year-1',
            outcome_id: 'outcome-2',
            stream_commitment_id: 'stream-commitment-2',
            generated_amount: expect.anything()
          }
        ]
      })
    ])
  })

  it('associates provenance by commitment line number when returned rows are reversed', async () => {
    const { commitment } = await loadHooks()
    const db = new WriteDb()
    db.commitmentLines.reverse()
    allocationDataMocks.getGeneratedCommitmentLines.mockResolvedValue({
      status: 'handled',
      issues: [],
      lines: [
        createGeneratedCommitmentLine('1', 60),
        createGeneratedCommitmentLine('2', 40, 'version-2')
      ]
    })

    await commitment(createPayload(
      'agreement.commitments.create',
      createContext(db, { phase: 'after-create', createdRecord: db.commitment })
    ))

    expect(db.records.find(record =>
      record.table === 'extensions.gcs_outcome_cost_allocation_commitment_lines'
    )?.values).toEqual([
      expect.objectContaining({
        allocation_version_id: 'version-2',
        commitment_line_id: 'commitment-line-2',
        outcome_id: 'outcome-2',
        stream_commitment_id: 'stream-commitment-2',
        generated_amount: expect.anything()
      }),
      expect.objectContaining({
        allocation_version_id: 'version-1',
        commitment_line_id: 'commitment-line-1',
        outcome_id: 'outcome-1',
        stream_commitment_id: 'stream-commitment-1',
        generated_amount: expect.anything()
      })
    ])
  })

  it('continues after host payment creation when required inputs or generated lines are absent', async () => {
    const { payment } = await loadHooks()
    const db = new WriteDb()
    const missingPayload = createPayload(
      'agreement.payments.create',
      createPaymentContext(db, {
        validatedBody: {},
        createdRecord: {
          id: 'payment-1'
        }
      })
    )

    await payment(missingPayload)
    expect(missingPayload.results[0]?.result).toEqual({
      status: 'continue'
    })
    expect(allocationDataMocks.getGeneratedPaymentLines).not.toHaveBeenCalled()

    allocationDataMocks.getGeneratedPaymentLines.mockResolvedValue({
      status: 'handled',
      issues: [],
      lines: []
    })
    const emptyLinesPayload = createPayload(
      'agreement.payments.create',
      createPaymentContext(db)
    )
    await payment(emptyLinesPayload)
    expect(emptyLinesPayload.results[0]?.result).toEqual({
      status: 'continue'
    })
    expect(db.records).toEqual([])
  })

  it('establishes the managed agreement context before the host inserts a payment', async () => {
    const { payment } = await loadHooks()
    const db = new WriteDb()
    const payload = createPayload(
      'agreement.payments.create',
      createPaymentContext(db, {
        phase: 'before-create',
        createdRecord: undefined
      })
    )

    await payment(payload)

    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(
      db,
      'agreement-1'
    )
    expect(allocationDataMocks.getGeneratedPaymentLines).not.toHaveBeenCalled()
    expect(payload.results[0]?.result).toEqual({
      status: 'continue'
    })
  })

  it('rejects payment values outside the exact scale-four number envelope', async () => {
    const { payment } = await loadHooks()
    const db = new WriteDb()

    await expect(payment(createPayload(
      'agreement.payments.create',
      createPaymentContext(db, {
        validatedBody: {
          egcs_fc_fundingagreementcommitment: 'commitment-1',
          egcs_fc_fiscalyear: 'year-1',
          egcs_fc_paymentamount: 900_719_925_474.0992
        }
      })
    ))).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      details: [{
        path: 'egcs_fc_paymentamount',
        code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
      }]
    })
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).not.toHaveBeenCalled()
  })

  it('returns payment allocation issues without writing generated lines', async () => {
    const { payment } = await loadHooks()
    const db = new WriteDb()
    allocationDataMocks.getGeneratedPaymentLines.mockResolvedValue({
      status: 'handled',
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_LINES_MISSING',
        path: 'paymentLines',
        message: 'apiErrors.extensions.outcome_cost_allocation.payment_lines_missing'
      }],
      lines: []
    })

    await expect(payment(createPayload(
      'agreement.payments.create',
      createPaymentContext(db, {
        validatedBody: {
          egcs_fc_fiscalyear: 'year-1',
          egcs_fc_paymentamount: '25.00'
        },
        createdRecord: {
          id: 'payment-1',
          egcs_fc_fundingagreementcommitment: 'commitment-1'
        }
      })
    ))).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_LINES_MISSING'
    })
    expect(db.records).toEqual([])
  })

  it('inserts generated payment lines while leaving host status ownership unchanged', async () => {
    const { payment } = await loadHooks()
    const db = new WriteDb()
    allocationDataMocks.getGeneratedPaymentLines.mockResolvedValue({
      status: 'handled',
      issues: [],
      lines: [
        {
          commitmentLineId: 'commitment-line-1',
          amount: '15.00'
        },
        {
          commitmentLineId: 'commitment-line-2',
          amount: '10.00'
        }
      ]
    })
    const payload = createPayload(
      'agreement.payments.create',
      createPaymentContext(db)
    )

    await payment(payload)

    expect(allocationDataMocks.getGeneratedPaymentLines).toHaveBeenCalledWith(
      db,
      'agreement-1',
      'stream-1',
      'commitment-1',
      'year-1',
      '25.00',
      {
        enabledCommitmentTypes: ['1']
      }
    )
    expect(allocationDataMocks.lockAgreementAllocationLifecycle).toHaveBeenCalledWith(
      db,
      'agreement-1'
    )
    expect(
      allocationDataMocks.lockAgreementAllocationLifecycle.mock.invocationCallOrder[0]
    ).toBeLessThan(
      allocationDataMocks.getGeneratedPaymentLines.mock.invocationCallOrder[0] as number
    )
    expect(db.records).toEqual([
      {
        operation: 'insert',
        table: 'Funding_Case_Agreement_Payment_Line',
        values: [
          {
            egcs_fc_fundingagreementpayment: 'payment-1',
            egcs_fc_fundingagreementcommitmentline: 'commitment-line-1',
            egcs_fc_amount: expect.anything()
          },
          {
            egcs_fc_fundingagreementpayment: 'payment-1',
            egcs_fc_fundingagreementcommitmentline: 'commitment-line-2',
            egcs_fc_amount: expect.anything()
          }
        ],
        wheres: []
      }
    ])
    expect(payload.results[0]?.result).toEqual({
      status: 'continue'
    })
  })
})
