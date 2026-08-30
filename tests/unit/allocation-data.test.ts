import { afterEach, describe, expect, it, vi } from 'vitest'

const lockGcsExtensionLifecycleScopeMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@gcs-ssc/extensions/server', async importOriginal => ({
  ...await importOriginal<typeof import('@gcs-ssc/extensions/server')>(),
  lockGcsExtensionLifecycleScope: lockGcsExtensionLifecycleScopeMock
}))
import {
  completeAllocationVersion as completeAllocationVersionWithExpectedScope,
  createDraftAllocationVersion as createDraftAllocationVersionWithExpectedScope,
  deleteDraftAllocationVersion as deleteDraftAllocationVersionWithExpectedScope,
  ensureDraftAllocationVersion as ensureDraftAllocationVersionWithExpectedScope,
  getActiveAllocationVersion,
  getActiveStreamCommitmentBudgetIds,
  getAgreementBudgetYears,
  getAgreementOutcomes,
  getAllocationVersion,
  getAllocationVersions,
  getGeneratedCommitmentLines,
  getGeneratedPaymentLines,
  generatedPaymentStatusResurrectionExceedsCoverage,
  getSavedAllocations,
  getStreamCommitmentLines,
  lockAgreementAllocationLifecycle,
  saveAllocations as saveAllocationsWithExpectedScope,
  saveAndCompleteAllocationVersion as saveAndCompleteAllocationVersionWithExpectedScope,
  saveAndCompleteAllocationVersionWithCurrentConfiguration,
  validateAgreementAllocations,
  validateAllocationPaymentCoverage
} from '../../server/allocation-data'
import {
  asOutcomeCostAllocationDb,
  type OutcomeCostAllocationDb
} from '../../server/db'
import type { OutcomeAllocationInput } from '../../shared/allocation'

type QueryOperation = 'select' | 'insert' | 'update'

interface QueryRecord {
  operation: QueryOperation
  table: string
  scope: 'root' | 'transaction'
  joins: Array<{
    kind: 'inner' | 'left'
    args: unknown[]
    predicates: unknown[][]
  }>
  selections: unknown[][]
  wheres: unknown[][]
  lockedForShare: boolean
  lockedForUpdate: boolean
  values?: unknown
  update?: unknown
}

interface ScriptedDbState {
  committedWrites: QueryRecord[]
  lifecycleLocks: Map<string, {
    ownerTransactionId: number
    waiters: Array<{
      transactionId: number
      resolve: () => void
    }>
  }>
  nextTransactionId: number
  queryGates: Map<string, Array<Promise<void>>>
  records: QueryRecord[]
  responses: Map<string, unknown[][]>
  stagedWrites: Map<number, QueryRecord[]>
  transactionEntries: number
  waitingLifecycleLocks: number
}

class ScriptedJoinBuilder {
  constructor(private readonly predicates: unknown[][]) {}

  onRef(...args: unknown[]) {
    this.predicates.push(['onRef', ...args])
    return this
  }

  on(...args: unknown[]) {
    this.predicates.push(['on', ...args])
    return this
  }
}

class ScriptedQuery {
  constructor(
    private readonly db: ScriptedDb,
    private readonly record: QueryRecord
  ) {}

  innerJoin(...args: unknown[]) {
    this.captureJoin('inner', args)
    return this
  }

  leftJoin(...args: unknown[]) {
    this.captureJoin('left', args)
    return this
  }

  where(...args: unknown[]) {
    this.record.wheres.push(args)
    return this
  }

  select(...args: unknown[]) {
    this.record.selections.push(args)
    return this
  }

  distinct() {
    return this
  }

  orderBy() {
    return this
  }

  groupBy() {
    return this
  }

  forUpdate() {
    this.record.lockedForUpdate = true
    return this
  }

  forShare() {
    this.record.lockedForShare = true
    return this
  }

  values(value: unknown) {
    this.record.values = value
    return this
  }

  set(value: unknown) {
    this.record.update = value
    return this
  }

  returning() {
    return this
  }

  async execute() {
    await this.db.waitForQuery(this.record)
    const rows = this.db.takeResponse(this.record.operation, this.record.table)
    this.db.stageWrite(this.record)
    return rows
  }

  async executeTakeFirst() {
    return (await this.execute())[0]
  }

  async executeTakeFirstOrThrow() {
    const row = await this.executeTakeFirst()
    if (!row) {
      throw new Error(`Missing scripted row for ${this.record.operation}:${this.record.table}`)
    }

    return row
  }

  private captureJoin(kind: 'inner' | 'left', args: unknown[]) {
    const predicates: unknown[][] = []
    const callback = args[1]
    if (typeof callback === 'function') {
      callback(new ScriptedJoinBuilder(predicates))
    } else {
      predicates.push(['onRef', ...args.slice(1)])
    }
    this.record.joins.push({ kind, args, predicates })
  }
}

const scriptedDbs: ScriptedDb[] = []

class ScriptedDb {
  constructor(
    private readonly state: ScriptedDbState = {
      committedWrites: [],
      lifecycleLocks: new Map(),
      nextTransactionId: 1,
      queryGates: new Map(),
      records: [],
      responses: new Map(),
      stagedWrites: new Map(),
      transactionEntries: 0,
      waitingLifecycleLocks: 0
    },
    private readonly scope: 'root' | 'transaction' = 'root',
    private readonly transactionId: number | null = null
  ) {
    if (scope === 'root') {
      scriptedDbs.push(this)
    }
  }

  get records() {
    return this.state.records
  }

  get transactionEntries() {
    return this.state.transactionEntries
  }

  get committedWrites() {
    return this.state.committedWrites
  }

  get waitingLifecycleLocks() {
    return this.state.waitingLifecycleLocks
  }

  enqueue(operation: QueryOperation, table: string, rows: unknown[]) {
    const key = `${operation}:${table}`
    const queued = this.state.responses.get(key) ?? []
    this.state.responses.set(key, [...queued, rows])
  }

  deferQuery(operation: QueryOperation, table: string): () => void {
    let releaseGate = () => {}
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve
    })
    const key = `${operation}:${table}`
    const queued = this.state.queryGates.get(key) ?? []
    this.state.queryGates.set(key, [...queued, gate])
    return releaseGate
  }

  async waitForQuery(record: QueryRecord): Promise<void> {
    if (
      record.operation === 'select'
      && record.table === 'Funding_Case_Agreement_Profile'
      && record.joins.length === 0
    ) {
      const agreementId = record.wheres.find(where =>
        where[0] === 'id' || where[0] === 'Funding_Case_Agreement_Profile.id'
      )?.[2]
      if (typeof agreementId === 'string' && this.transactionId !== null) {
        await this.acquireLifecycleLock(agreementId)
      }
    }

    const key = `${record.operation}:${record.table}`
    const [gate, ...remainingGates] = this.state.queryGates.get(key) ?? []
    if (gate) {
      this.state.queryGates.set(key, remainingGates)
      await gate
    }
  }

  stageWrite(record: QueryRecord) {
    if (record.operation === 'select' || this.transactionId === null) {
      return
    }

    const staged = this.state.stagedWrites.get(this.transactionId) ?? []
    this.state.stagedWrites.set(this.transactionId, [...staged, record])
  }

  takeResponse(operation: QueryOperation, table: string): unknown[] {
    const key = `${operation}:${table}`
    const queued = this.state.responses.get(key) ?? []
    if (
      operation === 'select'
      && table === 'Funding_Case_Agreement_Profile'
      && queued.length === 0
    ) {
      return this.state.records.at(-1)?.joins.length === 0
        ? [{ egcs_fc_transferpaymentstream: 'stream-1' }]
        : [{ agency_id: 'agency-1', stream_id: 'stream-1' }]
    }
    if (operation === 'select' && table === 'Transfer_Payment_Stream' && queued.length === 0) {
      return [{
        stream_id: 'stream-1',
        transfer_payment_profile_id: 'profile-1'
      }]
    }
    if (operation === 'select' && table === 'Common_Completion' && queued.length === 0) {
      return []
    }
    if (operation === 'select' && queued.length === 0) {
      throw new Error(`Unexpected unscripted database query: ${key}`)
    }
    const [rows = [], ...remaining] = queued
    this.state.responses.set(key, remaining)
    return rows
  }

  selectFrom(table: string) {
    return this.createQuery('select', table)
  }

  insertInto(table: string) {
    return this.createQuery('insert', table)
  }

  updateTable(table: string) {
    return this.createQuery('update', table)
  }

  transaction() {
    return {
      execute: async <T>(callback: (db: ScriptedDb) => Promise<T>) => {
        const transactionId = this.state.nextTransactionId
        this.state.nextTransactionId += 1
        this.state.transactionEntries += 1
        try {
          const result = await callback(new ScriptedDb(this.state, 'transaction', transactionId))
          const staged = this.state.stagedWrites.get(transactionId) ?? []
          this.state.committedWrites.push(...staged)
          return result
        } finally {
          this.state.stagedWrites.delete(transactionId)
          this.releaseLifecycleLocks(transactionId)
        }
      }
    }
  }

  assertResponsesConsumed() {
    const remaining = Array.from(this.state.responses.entries())
      .filter(([, queued]) => queued.length > 0)
      .map(([key, queued]) => `${key} (${queued.length})`)
    expect(remaining, 'Expected all scripted database responses to be consumed.').toEqual([])
  }

  private createQuery(operation: QueryOperation, table: string) {
    const record: QueryRecord = {
      operation,
      table,
      scope: this.scope,
      joins: [],
      selections: [],
      wheres: [],
      lockedForShare: false,
      lockedForUpdate: false
    }
    this.records.push(record)
    return new ScriptedQuery(this, record)
  }

  private async acquireLifecycleLock(agreementId: string): Promise<void> {
    const existing = this.state.lifecycleLocks.get(agreementId)
    if (!existing) {
      this.state.lifecycleLocks.set(agreementId, {
        ownerTransactionId: this.transactionId as number,
        waiters: []
      })
      return
    }
    if (existing.ownerTransactionId === this.transactionId) {
      return
    }

    this.state.waitingLifecycleLocks += 1
    await new Promise<void>(resolve => {
      existing.waiters.push({
        transactionId: this.transactionId as number,
        resolve
      })
    })
    this.state.waitingLifecycleLocks -= 1
  }

  private releaseLifecycleLocks(transactionId: number) {
    for (const [agreementId, lifecycleLock] of this.state.lifecycleLocks) {
      if (lifecycleLock.ownerTransactionId !== transactionId) {
        continue
      }

      const nextWaiter = lifecycleLock.waiters.shift()
      if (!nextWaiter) {
        this.state.lifecycleLocks.delete(agreementId)
        continue
      }

      lifecycleLock.ownerTransactionId = nextWaiter.transactionId
      nextWaiter.resolve()
    }
  }
}

afterEach(() => {
  for (const db of scriptedDbs) {
    db.assertResponsesConsumed()
  }
  scriptedDbs.length = 0
  vi.clearAllMocks()
})

const asAllocationDb = (db: ScriptedDb): OutcomeCostAllocationDb =>
  asOutcomeCostAllocationDb(db)

const expectedAgreementScope = {
  agencyId: 'agency-1',
  streamId: 'stream-1'
}

const createDraftAllocationVersion = (
  db: OutcomeCostAllocationDb,
  agreementId: string
) => createDraftAllocationVersionWithExpectedScope(db, agreementId, expectedAgreementScope)

const ensureDraftAllocationVersion = (
  db: OutcomeCostAllocationDb,
  agreementId: string
) => ensureDraftAllocationVersionWithExpectedScope(db, agreementId, expectedAgreementScope)

const deleteDraftAllocationVersion = (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string
) => deleteDraftAllocationVersionWithExpectedScope(
  db,
  agreementId,
  allocationVersionId,
  expectedAgreementScope
)

const saveAllocations = (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  allocations: OutcomeAllocationInput[]
) => saveAllocationsWithExpectedScope(
  db,
  agreementId,
  allocationVersionId,
  allocations,
  expectedAgreementScope
)

const completeAllocationVersion = (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown
) => completeAllocationVersionWithExpectedScope(
  db,
  agreementId,
  streamId,
  allocationVersionId,
  config,
  expectedAgreementScope
)

const saveAndCompleteAllocationVersion = (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown,
  allocations: OutcomeAllocationInput[]
) => saveAndCompleteAllocationVersionWithExpectedScope(
  db,
  agreementId,
  streamId,
  allocationVersionId,
  config,
  allocations,
  expectedAgreementScope
)

describe('generated payment status resurrection coverage', () => {
  it('allows a generated payment with no active lines', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [])

    await expect(generatedPaymentStatusResurrectionExceedsCoverage(
      asAllocationDb(db),
      'payment-1'
    )).resolves.toBe(false)
  })

  it('detects when restoring a denied payment would exceed its commitment line', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [{
      commitment_line_id: 'line-1',
      payment_amount: '60.00',
      commitment_amount: '100.00'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [{ paid_amount: '50.00' }])

    await expect(generatedPaymentStatusResurrectionExceedsCoverage(
      asAllocationDb(db),
      'payment-1'
    )).resolves.toBe(true)
  })
})

const versionRow = {
  id: 'version-1',
  agreement_id: 'agreement-1',
  version_number: 1,
  status: 'draft',
  created_at: '2026-01-02T03:04:05.000Z',
  completed_at: null
}

const budgetYearRow = {
  id: 'year-1',
  fiscal_year_id: 'fiscal-year-1',
  fiscal_year_display: '2026-2027',
  program_funding: '100.00',
  stream_budget_id: 'stream-budget-1'
}

const outcomeRow = {
  id: 'outcome-1',
  label_en: 'Outcome 1',
  label_fr: 'Resultat 1'
}

const allocationRow = {
  allocation_version_id: 'version-1',
  commitment_type: '1',
  stream_commitment_id: 'stream-commitment-1',
  agreement_budget_fiscal_year_id: 'year-1',
  outcome_id: 'outcome-1',
  allocation_method: 'amount',
  allocation_value: '100.0000'
}

const allocation: OutcomeAllocationInput = {
  commitmentType: '1',
  streamCommitmentId: 'stream-commitment-1',
  agreementBudgetFiscalYearId: 'year-1',
  outcomeId: 'outcome-1',
  allocationMethod: 'amount',
  allocationValue: '100.0000'
}

const enqueueAllocationLabelSnapshot = (db: ScriptedDb) => {
  db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [{
    allocation_id: 'allocation-1',
    commitment_type: '1',
    stream_commitment_id: 'stream-commitment-1',
    agreement_budget_fiscal_year_id: 'year-1',
    outcome_id: 'outcome-1',
    outcome_label_en: 'Outcome 1',
    outcome_label_fr: 'Resultat 1',
    fiscal_year_display: '2026-2027',
    commitment_label_en: 'Fund: 110 · G/L: 5000',
    commitment_label_fr: 'Fonds : 110 · G/L : 5000'
  }])
  db.enqueue('update', 'extensions.gcs_outcome_cost_allocation_allocations', [])
}

const enqueueCompletionBudgetCapture = (db: ScriptedDb) => {
  db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [{
    id: 'year-1',
    fiscal_year_id: 'fiscal-year-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Budget_Line_Item', [{
    id: 'budget-line-1'
  }])
  db.enqueue('select', 'Agency_Fiscal_Year', [{
    id: 'fiscal-year-1'
  }])
  db.enqueue('select', 'Transfer_Payment_Stream', [{
    stream_id: 'stream-1',
    transfer_payment_profile_id: 'transfer-payment-1'
  }])
  db.enqueue('select', 'Transfer_Payment_Fiscal_Year_Budget', [{
    id: 'fiscal-budget-1'
  }])
  db.enqueue('select', 'Transfer_Payment_Stream_Budget', [{
    id: 'stream-budget-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])
  db.enqueue('select', 'Funding_Case_Agreement_Activity', [{
    id: 'activity-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Outcome_Activity', [{
    id: 'outcome-activity-1',
    egcs_fc_outcomes: 'outcome-1'
  }])
  db.enqueue('select', 'Transfer_Payment_Outcome', [{
    id: 'outcome-1'
  }])
}

const enqueuePaymentCoverageLocks = (db: ScriptedDb) => {
  db.enqueue('select', 'Funding_Case_Agreement_Commitment', [{
    id: 'commitment-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Commitment_Line', [{
    id: 'commitment-line-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Payment', [{
    id: 'payment-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Payment', [{
    id: 'payment-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [{
    id: 'payment-line-1'
  }])
  db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [{
    id: 'payment-line-1'
  }])
}

const allocationConfig = {
  enabledCommitmentTypes: ['1'],
  mappings: [{
    commitmentType: '1',
    outcomeId: 'outcome-1',
    streamBudgetId: 'stream-budget-1',
    streamCommitmentId: 'stream-commitment-1'
  }]
}

const expectLockedVersionQuery = (
  db: ScriptedDb,
  agreementId = 'agreement-1',
  allocationVersionId = 'version-1'
) => {
  const lifecycleLockIndex = db.records.findIndex(record =>
    record.operation === 'select'
    && record.table === 'Funding_Case_Agreement_Profile'
  )
  const versionQuery = db.records.find(record =>
    record.operation === 'select'
    && record.table === 'extensions.gcs_outcome_cost_allocation_versions'
    && record.wheres.some(where => where[0] === 'id')
  )
  expect(versionQuery).toMatchObject({
    scope: 'transaction',
    lockedForUpdate: true,
    wheres: [
      ['id', '=', allocationVersionId],
      ['agreement_id', '=', agreementId],
      ['_deleted', '=', false]
    ]
  })
  expect(lifecycleLockIndex).toBe(0)
  expect(db.records.indexOf(versionQuery as QueryRecord)).toBeGreaterThan(lifecycleLockIndex)
}

const expectAgreementLifecycleLock = (db: ScriptedDb, agreementId = 'agreement-1') => {
  expect(db.records[0]).toMatchObject({
    operation: 'select',
    table: 'Funding_Case_Agreement_Profile',
    scope: 'transaction',
    lockedForUpdate: false,
    wheres: [
      ['Funding_Case_Agreement_Profile.id', '=', agreementId],
      ['Funding_Case_Agreement_Profile._deleted', '=', false],
      ['Transfer_Payment_Stream._deleted', '=', false],
      ['Transfer_Payment_Profile._deleted', '=', false]
    ]
  })
  expect(lockGcsExtensionLifecycleScopeMock).toHaveBeenCalledWith(
    expect.anything(),
    'gcs-outcome-cost-allocation',
    'agency-1',
    'stream-1'
  )
  expect(db.records[1]).toMatchObject({
    operation: 'select',
    table: 'Transfer_Payment_Stream',
    scope: 'transaction',
    lockedForUpdate: true,
    wheres: expect.arrayContaining([
      ['Transfer_Payment_Stream.id', '=', 'stream-1'],
      ['Transfer_Payment_Stream._deleted', '=', false]
    ])
  })
  expect(db.records[2]?.selections[0]?.[0]).toEqual([
    'egcs_fc_transferpaymentstream',
    expect.anything()
  ])
}

const getLockedVersionRecord = (db: ScriptedDb) => db.records.find(record =>
  record.table === 'extensions.gcs_outcome_cost_allocation_versions'
  && record.lockedForUpdate
)

describe('outcome allocation data reads', () => {
  it('loads agreement reference data and stream commitment lines', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1',
      fiscal_year_display: '2026-2027',
      gl: 501,
      gl_description: 'Program expense'
    }])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [
      { id: 'stream-commitment-1', stream_budget_id: 'stream-budget-1' },
      { id: 2, stream_budget_id: 'stream-budget-2' }
    ])

    await expect(getAgreementOutcomes(asAllocationDb(db), 'agreement-1')).resolves.toEqual([outcomeRow])
    await expect(getAgreementBudgetYears(asAllocationDb(db), 'agreement-1', 'stream-1')).resolves.toEqual([budgetYearRow])
    await expect(getStreamCommitmentLines(asAllocationDb(db), 'stream-1')).resolves.toEqual([{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1',
      fiscal_year_display: '2026-2027',
      gl: 501,
      gl_description: 'Program expense'
    }])
    await expect(getActiveStreamCommitmentBudgetIds(asAllocationDb(db), 'stream-1')).resolves.toEqual(
      new Map([
        ['stream-commitment-1', 'stream-budget-1'],
        ['2', 'stream-budget-2']
      ])
    )

    const outcomesQuery = db.records.find(record =>
      record.table === 'Funding_Case_Agreement_Activity'
    )
    expect(outcomesQuery).toMatchObject({
      joins: [
        {
          kind: 'inner',
          args: [
            'Funding_Case_Agreement_Outcome_Activity',
            'Funding_Case_Agreement_Outcome_Activity.egcs_fc_activity',
            'Funding_Case_Agreement_Activity.id'
          ],
          predicates: [
            [
              'onRef',
              'Funding_Case_Agreement_Outcome_Activity.egcs_fc_activity',
              'Funding_Case_Agreement_Activity.id'
            ]
          ]
        },
        {
          kind: 'inner',
          args: [
            'Transfer_Payment_Outcome',
            'Transfer_Payment_Outcome.id',
            'Funding_Case_Agreement_Outcome_Activity.egcs_fc_outcomes'
          ],
          predicates: [
            [
              'onRef',
              'Transfer_Payment_Outcome.id',
              'Funding_Case_Agreement_Outcome_Activity.egcs_fc_outcomes'
            ]
          ]
        }
      ],
      wheres: [
        ['Funding_Case_Agreement_Activity.egcs_fc_fundingagreement', '=', 'agreement-1'],
        ['Funding_Case_Agreement_Activity._deleted', '=', false],
        ['Funding_Case_Agreement_Outcome_Activity._deleted', '=', false],
        ['Transfer_Payment_Outcome._deleted', '=', false]
      ],
      selections: [[[
        'Transfer_Payment_Outcome.id as id',
        'Transfer_Payment_Outcome.egcs_tp_name_en as label_en',
        'Transfer_Payment_Outcome.egcs_tp_name_fr as label_fr'
      ]]]
    })

    const budgetYearsQuery = db.records.find(record =>
      record.table === 'Funding_Case_Agreement_Budget_Fiscal_Year'
    )
    expect(budgetYearsQuery?.joins.map(join => ({
      kind: join.kind,
      table: join.args[0],
      predicates: join.predicates
    }))).toEqual([
      {
        kind: 'inner',
        table: 'Funding_Case_Agreement_Budget_Version',
        predicates: [
          [
            'onRef',
            'Funding_Case_Agreement_Budget_Version.id',
            '=',
            'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_budgetversion'
          ],
          [
            'onRef',
            'Funding_Case_Agreement_Budget_Version.egcs_fc_fundingagreement',
            '=',
            'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement'
          ],
          ['on', 'Funding_Case_Agreement_Budget_Version.egcs_fc_iscurrent', '=', true],
          ['on', 'Funding_Case_Agreement_Budget_Version._deleted', '=', false]
        ]
      },
      {
        kind: 'inner',
        table: 'Agency_Fiscal_Year',
        predicates: [[
          'onRef',
          'Agency_Fiscal_Year.id',
          'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear'
        ]]
      },
      {
        kind: 'left',
        table: 'Funding_Case_Agreement_Budget_Line_Item',
        predicates: [
          [
            'onRef',
            'Funding_Case_Agreement_Budget_Line_Item.egcs_fc_fundingagreementbudgetfiscalyear',
            '=',
            'Funding_Case_Agreement_Budget_Fiscal_Year.id'
          ],
          ['on', 'Funding_Case_Agreement_Budget_Line_Item._deleted', '=', false]
        ]
      },
      {
        kind: 'inner',
        table: 'Transfer_Payment_Stream',
        predicates: [
          ['on', 'Transfer_Payment_Stream.id', '=', 'stream-1'],
          ['on', 'Transfer_Payment_Stream._deleted', '=', false]
        ]
      },
      {
        kind: 'left',
        table: 'Transfer_Payment_Fiscal_Year_Budget',
        predicates: [
          [
            'onRef',
            'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_fiscalyear',
            '=',
            'Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fiscalyear'
          ],
          [
            'onRef',
            'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_transferpaymentprofile',
            '=',
            'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile'
          ],
          ['on', 'Transfer_Payment_Fiscal_Year_Budget._deleted', '=', false]
        ]
      },
      {
        kind: 'left',
        table: 'Transfer_Payment_Stream_Budget',
        predicates: [
          [
            'onRef',
            'Transfer_Payment_Stream_Budget.egcs_tp_transferpaymentbudget',
            '=',
            'Transfer_Payment_Fiscal_Year_Budget.id'
          ],
          ['on', 'Transfer_Payment_Stream_Budget.egcs_tp_transferpaymentstream', '=', 'stream-1'],
          ['on', 'Transfer_Payment_Stream_Budget._deleted', '=', false]
        ]
      }
    ])
    expect(budgetYearsQuery?.wheres).toEqual([
      ['Funding_Case_Agreement_Budget_Fiscal_Year.egcs_fc_fundingagreement', '=', 'agreement-1'],
      ['Funding_Case_Agreement_Budget_Fiscal_Year._deleted', '=', false],
      ['Agency_Fiscal_Year._deleted', '=', false]
    ])

    const streamLinesQuery = db.records.find(record =>
      record.table === 'Transfer_Payment_Stream_Chart_of_Account'
      && record.selections.some(selection => Array.isArray(selection[0]))
    )
    expect(streamLinesQuery?.wheres).toEqual([
      ['Transfer_Payment_Stream_Chart_of_Account.egcs_tp_transferpaymentstream', '=', 'stream-1'],
      ['Transfer_Payment_Stream_Chart_of_Account._deleted', '=', false],
      ['Transfer_Payment_Stream_Budget._deleted', '=', false],
      ['Transfer_Payment_Fiscal_Year_Budget._deleted', '=', false],
      ['Agency_Fiscal_Year._deleted', '=', false]
    ])
    expect(streamLinesQuery?.joins.map(join => join.predicates)).toEqual([
      [[
        'onRef',
        'Transfer_Payment_Stream_Budget.id',
        'Transfer_Payment_Stream_Chart_of_Account.egcs_tp_streambudget'
      ]],
      [[
        'onRef',
        'Transfer_Payment_Fiscal_Year_Budget.id',
        'Transfer_Payment_Stream_Budget.egcs_tp_transferpaymentbudget'
      ]],
      [[
        'onRef',
        'Agency_Fiscal_Year.id',
        'Transfer_Payment_Fiscal_Year_Budget.egcs_tp_fiscalyear'
      ]]
    ])
  })

  it('rejects non-canonical database aggregate money text', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [{
      ...budgetYearRow,
      program_funding: '900719925474.0992'
    }])

    await expect(getAgreementBudgetYears(
      asAllocationDb(db),
      'agreement-1',
      'stream-1'
    )).rejects.toThrow('Database money aggregate must be canonical scale-two text.')
  })

  it('normalizes allocation versions and nullable timestamps', async () => {
    const db = new ScriptedDb()
    const completedVersion = {
      ...versionRow,
      id: 2,
      agreement_id: 3,
      version_number: '2',
      status: 'active',
      completed_at: new Date('2026-02-03T04:05:06.000Z'),
      funding_basis_amount: '333.33'
    }
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [
      versionRow,
      completedVersion
    ])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [completedVersion])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [completedVersion])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])

    await expect(getAllocationVersions(asAllocationDb(db), 'agreement-1')).resolves.toEqual([
      {
        id: 'version-1',
        agreementId: 'agreement-1',
        versionNumber: 1,
        status: 'draft',
        createdAt: '2026-01-02T03:04:05.000Z',
        completedAt: null
      },
      {
        id: '2',
        agreementId: '3',
        versionNumber: 2,
        status: 'active',
        createdAt: '2026-01-02T03:04:05.000Z',
        completedAt: '2026-02-03T04:05:06.000Z',
        fundingBasisAmount: '333.33'
      }
    ])
    await expect(getAllocationVersion(asAllocationDb(db), 'agreement-1', '2')).resolves.toMatchObject({
      id: '2',
      status: 'active'
    })
    await expect(getAllocationVersion(asAllocationDb(db), 'agreement-1', 'missing')).resolves.toBeNull()
    await expect(getActiveAllocationVersion(asAllocationDb(db), 'agreement-1')).resolves.toMatchObject({
      id: '2',
      status: 'active'
    })
    await expect(getActiveAllocationVersion(asAllocationDb(db), 'agreement-1')).resolves.toBeNull()
  })

  it('normalizes saved allocation rows and optionally scopes the version query', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [
      {
        ...allocationRow,
        outcome_label_en: 'Recorded outcome',
        outcome_label_fr: 'Résultat enregistré',
        commitment_label_en: 'GL 5000 - Recorded commitment',
        commitment_label_fr: 'GL 5000 - Engagement enregistré',
        fiscal_year_display: '2026-2027'
      },
      {
        ...allocationRow,
        allocation_version_id: 2,
        commitment_type: 'unsupported',
        stream_commitment_id: 5,
        agreement_budget_fiscal_year_id: 3,
        outcome_id: 4,
        allocation_method: 'percentage',
        allocation_value: '25.0000'
      }
    ])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [])

    await expect(getSavedAllocations(asAllocationDb(db), 'agreement-1', 'version-1')).resolves.toEqual([
      {
        allocationVersionId: 'version-1',
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: '100.0000',
        outcomeLabelEn: 'Recorded outcome',
        outcomeLabelFr: 'Résultat enregistré',
        commitmentLabelEn: 'GL 5000 - Recorded commitment',
        commitmentLabelFr: 'GL 5000 - Engagement enregistré',
        fiscalYearDisplay: '2026-2027'
      },
      {
        allocationVersionId: '2',
        commitmentType: 'unsupported',
        streamCommitmentId: '5',
        agreementBudgetFiscalYearId: '3',
        outcomeId: '4',
        allocationMethod: 'percentage',
        allocationValue: '25.0000'
      }
    ])
    await expect(getSavedAllocations(asAllocationDb(db), 'agreement-1')).resolves.toEqual([])

    const allocationQueries = db.records.filter(record =>
      record.table === 'extensions.gcs_outcome_cost_allocation_allocations'
    )
    expect(allocationQueries[0]?.wheres).toContainEqual([
      'extensions.gcs_outcome_cost_allocation_allocations.allocation_version_id',
      '=',
      'version-1'
    ])
    expect(allocationQueries[0]?.joins[0]?.predicates).toContainEqual([
      'on',
      'extensions.gcs_outcome_cost_allocation_versions._deleted',
      '=',
      false
    ])
    expect(allocationQueries[1]?.wheres).not.toContainEqual([
      'allocation_version_id',
      '=',
      'version-1'
    ])
  })
})

describe('outcome allocation version lifecycle', () => {
  // One embedded PGlite client serializes commands and cannot represent independent
  // PostgreSQL sessions waiting on row locks. This deterministic model tests service
  // sequencing only; the opt-in PostgreSQL integration suite proves database blocking.
  it('reuses existing drafts without inserting another version', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])

    await expect(createDraftAllocationVersion(asAllocationDb(db), 'agreement-1')).resolves.toMatchObject({
      id: 'version-1',
      status: 'draft'
    })
    expect(db.transactionEntries).toBe(1)
    expectAgreementLifecycleLock(db)
    expect(db.records[4]).toMatchObject({
      operation: 'select',
      table: 'extensions.gcs_outcome_cost_allocation_versions',
      wheres: [
        ['agreement_id', '=', 'agreement-1'],
        ['status', '=', 'draft'],
        ['_deleted', '=', false]
      ]
    })
    expect(db.records.some(record => record.operation === 'insert')).toBe(false)
  })

  it('locks auth state before lifecycle locks and authorizes the locked entity before allocation writes', async () => {
    const db = new ScriptedDb()
    const phases: string[] = []
    lockGcsExtensionLifecycleScopeMock.mockImplementationOnce(async () => {
      phases.push('lifecycle-scope')
      expect(db.records).toHaveLength(1)
      expect(db.records[0]?.table).toBe('Funding_Case_Agreement_Profile')
    })
    const revokedAuthorization = {
      lockAuthState: vi.fn(async () => {
        phases.push('auth-state')
        expect(db.records).toEqual([])
      }),
      authorizeCurrentEntity: vi.fn(async () => {
        phases.push('current-entity')
        expectAgreementLifecycleLock(db)
        expect(db.records.some(record =>
          record.table === 'extensions.gcs_outcome_cost_allocation_versions'
        )).toBe(false)
        throw new Error('fresh authorization revoked')
      })
    }

    await expect(createDraftAllocationVersionWithExpectedScope(
      asAllocationDb(db),
      'agreement-1',
      expectedAgreementScope,
      revokedAuthorization
    )).rejects.toThrow('fresh authorization revoked')

    expect(phases).toEqual(['auth-state', 'lifecycle-scope', 'current-entity'])
    expect(revokedAuthorization.lockAuthState).toHaveBeenCalledTimes(1)
    expect(revokedAuthorization.authorizeCurrentEntity).toHaveBeenCalledTimes(1)
    expect(db.committedWrites).toEqual([])
  })

  it('rejects expected scope drift before acquiring the observed lifecycle scope', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Profile', [{
      agency_id: 'agency-2',
      stream_id: 'stream-2'
    }])

    await expect(createDraftAllocationVersionWithExpectedScope(
      asAllocationDb(db),
      'agreement-1',
      expectedAgreementScope
    )).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT'
    })

    expect(lockGcsExtensionLifecycleScopeMock).not.toHaveBeenCalled()
    expect(db.records).toHaveLength(1)
    expect(db.records[0]?.table).toBe('Funding_Case_Agreement_Profile')
  })

  it('locks auth state before save lifecycle locks and denies before saving allocations', async () => {
    const db = new ScriptedDb()
    const phases: string[] = []
    lockGcsExtensionLifecycleScopeMock.mockImplementationOnce(async () => {
      phases.push('lifecycle-scope')
    })
    const deniedAuthorization = {
      lockAuthState: vi.fn(async () => {
        phases.push('auth-state')
        expect(db.records).toEqual([])
      }),
      authorizeCurrentEntity: vi.fn(async () => {
        phases.push('current-entity')
        expectAgreementLifecycleLock(db)
        expect(db.records.some(record => record.operation !== 'select')).toBe(false)
        expect(db.records.some(record =>
          record.table === 'extensions.gcs_outcome_cost_allocation_versions'
        )).toBe(false)
        throw new Error('save authorization revoked')
      })
    }

    await expect(saveAllocationsWithExpectedScope(
      asAllocationDb(db),
      'agreement-1',
      'version-1',
      [allocation],
      expectedAgreementScope,
      deniedAuthorization
    )).rejects.toThrow('save authorization revoked')

    expect(phases).toEqual(['auth-state', 'lifecycle-scope', 'current-entity'])
    expect(db.committedWrites).toEqual([])
  })

  it('locks auth state before delete lifecycle locks and denies before soft deletion', async () => {
    const db = new ScriptedDb()
    const phases: string[] = []
    lockGcsExtensionLifecycleScopeMock.mockImplementationOnce(async () => {
      phases.push('lifecycle-scope')
    })
    const deniedAuthorization = {
      lockAuthState: vi.fn(async () => {
        phases.push('auth-state')
        expect(db.records).toEqual([])
      }),
      authorizeCurrentEntity: vi.fn(async () => {
        phases.push('current-entity')
        expectAgreementLifecycleLock(db)
        expect(db.records.some(record => record.operation !== 'select')).toBe(false)
        expect(db.records.some(record =>
          record.table === 'extensions.gcs_outcome_cost_allocation_versions'
        )).toBe(false)
        throw new Error('delete authorization revoked')
      })
    }

    await expect(deleteDraftAllocationVersionWithExpectedScope(
      asAllocationDb(db),
      'agreement-1',
      'version-1',
      expectedAgreementScope,
      deniedAuthorization
    )).rejects.toThrow('delete authorization revoked')

    expect(phases).toEqual(['auth-state', 'lifecycle-scope', 'current-entity'])
    expect(db.committedWrites).toEqual([])
  })

  it('locks auth state before completion configuration and lifecycle locks and denies before replacement', async () => {
    const db = new ScriptedDb()
    const phases: string[] = []
    db.enqueue('select', 'extensions.stream_configuration', [{ config: allocationConfig }])
    lockGcsExtensionLifecycleScopeMock
      .mockImplementationOnce(async () => {
        phases.push('configuration-scope')
      })
      .mockImplementationOnce(async () => {
        phases.push('lifecycle-scope')
      })
    const deniedAuthorization = {
      lockAuthState: vi.fn(async () => {
        phases.push('auth-state')
        expect(db.records).toEqual([])
        expect(lockGcsExtensionLifecycleScopeMock).not.toHaveBeenCalled()
      }),
      authorizeCurrentEntity: vi.fn(async () => {
        phases.push('current-entity')
        expect(db.records[0]?.table).toBe('extensions.stream_configuration')
        expect(db.records[1]?.table).toBe('Funding_Case_Agreement_Profile')
        expect(db.records[2]).toMatchObject({
          table: 'Transfer_Payment_Stream',
          lockedForUpdate: true
        })
        expect(db.records[3]?.table).toBe('Funding_Case_Agreement_Profile')
        expect(db.records[4]?.table).toBe('Funding_Case_Agreement_Profile')
        expect(db.records.some(record => record.operation !== 'select')).toBe(false)
        expect(db.records.some(record =>
          record.table === 'extensions.gcs_outcome_cost_allocation_versions'
        )).toBe(false)
        throw new Error('completion authorization revoked')
      })
    }

    await expect(saveAndCompleteAllocationVersionWithCurrentConfiguration(
      asAllocationDb(db),
      'agreement-1',
      'agency-1',
      'stream-1',
      'version-1',
      [allocation],
      deniedAuthorization
    )).rejects.toThrow('completion authorization revoked')

    expect(phases).toEqual([
      'auth-state',
      'configuration-scope',
      'lifecycle-scope',
      'current-entity'
    ])
    expect(db.committedWrites).toEqual([])
  })

  it('serializes concurrent draft creation and commits writes before releasing the agreement lock', async () => {
    const db = new ScriptedDb()
    const releaseFirstVersionRead = db.deferQuery(
      'select',
      'extensions.gcs_outcome_cost_allocation_versions'
    )
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])
    db.enqueue('insert', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])

    const firstDraft = createDraftAllocationVersion(asAllocationDb(db), 'agreement-1')
    await vi.waitFor(() => {
      expect(db.records.some(record =>
        record.table === 'extensions.gcs_outcome_cost_allocation_versions'
      )).toBe(true)
    })
    const secondDraft = createDraftAllocationVersion(asAllocationDb(db), 'agreement-1')
    await vi.waitFor(() => {
      expect(db.waitingLifecycleLocks).toBe(1)
    })

    expect(db.records.filter(record =>
      record.table === 'extensions.gcs_outcome_cost_allocation_versions'
    )).toHaveLength(1)
    expect(db.committedWrites).toEqual([])

    releaseFirstVersionRead()
    await expect(firstDraft).resolves.toMatchObject({
      id: 'version-1',
      status: 'draft'
    })
    await expect(secondDraft).resolves.toMatchObject({
      id: 'version-1',
      status: 'draft'
    })

    expect(db.waitingLifecycleLocks).toBe(0)
    expect(db.committedWrites).toHaveLength(1)
    expect(db.committedWrites[0]).toMatchObject({
      operation: 'insert',
      table: 'extensions.gcs_outcome_cost_allocation_versions'
    })
  })

  it('rolls back staged writes and releases the agreement lock to the next transaction', async () => {
    const db = new ScriptedDb()
    await expect(asAllocationDb(db).transaction().execute(async trx => {
      await lockAgreementAllocationLifecycle(trx, 'agreement-1')
      await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_versions')
        .set({ status: 'inactive' })
        .where('agreement_id', '=', 'agreement-1')
        .execute()
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    expect(db.committedWrites).toEqual([])
    expect(db.waitingLifecycleLocks).toBe(0)

    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    await expect(createDraftAllocationVersion(
      asAllocationDb(db),
      'agreement-1'
    )).resolves.toMatchObject({
      id: 'version-1',
      status: 'draft'
    })
  })

  it('returns a structured error when the lifecycle agreement cannot be locked', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Profile', [])

    await expect(createDraftAllocationVersion(
      asAllocationDb(db),
      'missing-agreement'
    )).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      details: [{
        path: 'agreementId',
        code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
      }]
    })
    expect(db.records[0]).toMatchObject({
      operation: 'select',
      table: 'Funding_Case_Agreement_Profile'
    })
    expect(db.records[0]?.wheres[0]).toEqual([
      'Funding_Case_Agreement_Profile.id',
      '=',
      'missing-agreement'
    ])
    expect(db.records).toHaveLength(1)
  })

  it('rejects a caller-authorized scope that changed before the agreement row was locked', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Profile', [{
      agency_id: 'agency-1',
      stream_id: 'stream-1'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Profile', [{
      egcs_fc_transferpaymentstream: 'stream-2'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Profile', [{
      agency_id: 'agency-2',
      stream_id: 'stream-2'
    }])

    await expect(createDraftAllocationVersionWithExpectedScope(
      asAllocationDb(db),
      'agreement-1',
      expectedAgreementScope
    )).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
      details: [{
        path: 'agreementId',
        code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT'
      }]
    })
    expect(db.records.some(record =>
      record.operation === 'insert'
      && record.table === 'extensions.gcs_outcome_cost_allocation_versions'
    )).toBe(false)
  })

  it('creates the next draft version number when none exists', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{ max_version: '4' }])
    db.enqueue('insert', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      id: 'version-5',
      version_number: 5
    }])

    await expect(createDraftAllocationVersion(asAllocationDb(db), 'agreement-1')).resolves.toMatchObject({
      id: 'version-5',
      versionNumber: 5
    })
    expect(db.transactionEntries).toBe(1)
    expectAgreementLifecycleLock(db)
    const versionSelects = db.records.filter(record =>
      record.operation === 'select'
      && record.table === 'extensions.gcs_outcome_cost_allocation_versions'
    )
    expect(versionSelects.map(record => record.wheres)).toEqual([
      [
        ['agreement_id', '=', 'agreement-1'],
        ['status', '=', 'draft'],
        ['_deleted', '=', false]
      ],
      [
        ['agreement_id', '=', 'agreement-1'],
        ['_deleted', '=', false]
      ]
    ])
    expect(db.records.find(record => record.operation === 'insert')?.values).toEqual({
      agreement_id: 'agreement-1',
      version_number: 5,
      status: 'draft'
    })
  })

  it('ensures an existing draft or creates version one for a new agreement', async () => {
    const existingDb = new ScriptedDb()
    existingDb.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])

    await expect(ensureDraftAllocationVersion(asAllocationDb(existingDb), 'agreement-1')).resolves.toMatchObject({
      id: 'version-1'
    })
    expect(existingDb.transactionEntries).toBe(1)
    expectAgreementLifecycleLock(existingDb)

    const newDb = new ScriptedDb()
    newDb.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])
    newDb.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])
    newDb.enqueue('insert', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])

    await expect(ensureDraftAllocationVersion(asAllocationDb(newDb), 'agreement-1')).resolves.toMatchObject({
      id: 'version-1',
      versionNumber: 1
    })
    expect(newDb.transactionEntries).toBe(1)
    expectAgreementLifecycleLock(newDb)
    expect(newDb.records.find(record => record.operation === 'insert')?.values).toMatchObject({
      version_number: 1
    })
  })

  it.each([
    undefined,
    { id: 'version-1', status: 'active' }
  ])('rejects deletion when the version is absent or not a draft', async version => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', version ? [version] : [])

    await expect(deleteDraftAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'version-1'
    )).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_DELETE_REQUIRED'
    })
    expect(db.transactionEntries).toBe(1)
    expectLockedVersionQuery(db)
    expectAgreementLifecycleLock(db)
    expect(getLockedVersionRecord(db)?.wheres).toEqual([
      ['id', '=', 'version-1'],
      ['agreement_id', '=', 'agreement-1'],
      ['_deleted', '=', false]
    ])
    expect(db.records.some(record => record.operation === 'update')).toBe(false)
  })

  it('soft-deletes a draft and its allocation rows', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      id: 'version-1',
      status: 'draft'
    }])

    await expect(deleteDraftAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'version-1'
    )).resolves.toBeUndefined()

    expect(db.transactionEntries).toBe(1)
    expectLockedVersionQuery(db)
    expectAgreementLifecycleLock(db)
    expect(getLockedVersionRecord(db)?.wheres).toEqual([
      ['id', '=', 'version-1'],
      ['agreement_id', '=', 'agreement-1'],
      ['_deleted', '=', false]
    ])
    expect(db.records.filter(record => record.operation === 'update')).toEqual([
      expect.objectContaining({
        table: 'extensions.gcs_outcome_cost_allocation_allocations',
        update: { _deleted: true },
        wheres: [
          ['agreement_id', '=', 'agreement-1'],
          ['allocation_version_id', '=', 'version-1'],
          ['_deleted', '=', false]
        ]
      }),
      expect.objectContaining({
        table: 'extensions.gcs_outcome_cost_allocation_versions',
        update: { _deleted: true },
        wheres: [
          ['id', '=', 'version-1'],
          ['agreement_id', '=', 'agreement-1'],
          ['status', '=', 'draft'],
          ['_deleted', '=', false]
        ]
      })
    ])
  })

  it('completes before a concurrent payment lifecycle read without deadlock or partial visibility', async () => {
    const db = new ScriptedDb()
    const releaseCompletionVersionRead = db.deferQuery(
      'select',
      'extensions.gcs_outcome_cost_allocation_versions'
    )
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      status: 'active',
      completed_at: '2026-01-03T00:00:00.000Z'
    }])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [allocationRow])
    enqueueCompletionBudgetCapture(db)
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])
    enqueuePaymentCoverageLocks(db)
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [])
    enqueueAllocationLabelSnapshot(db)
    db.enqueue('update', 'extensions.gcs_outcome_cost_allocation_versions', [])
    db.enqueue('update', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      status: 'active',
      completed_at: '2026-01-03T00:00:00.000Z'
    }])

    const completion = completeAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig
    )
    await vi.waitFor(() => {
      expect(db.records.some(record =>
        record.table === 'extensions.gcs_outcome_cost_allocation_versions'
      )).toBe(true)
    })
    const paymentLifecycleRead = asAllocationDb(db).transaction().execute(async trx => {
      await lockAgreementAllocationLifecycle(trx, 'agreement-1')
      return await getActiveAllocationVersion(trx, 'agreement-1')
    })
    await vi.waitFor(() => {
      expect(db.waitingLifecycleLocks).toBe(1)
    })

    expect(db.records.filter(record =>
      record.table === 'extensions.gcs_outcome_cost_allocation_versions'
    )).toHaveLength(1)
    expect(db.committedWrites).toEqual([])

    releaseCompletionVersionRead()
    await expect(completion).resolves.toEqual({
      id: 'version-1',
      agreementId: 'agreement-1',
      versionNumber: 1,
      status: 'active',
      createdAt: '2026-01-02T03:04:05.000Z',
      completedAt: '2026-01-03T00:00:00.000Z'
    })
    await expect(paymentLifecycleRead).resolves.toMatchObject({
      id: 'version-1',
      status: 'active'
    })

    expect(db.transactionEntries).toBe(2)
    expect(db.waitingLifecycleLocks).toBe(0)
    expect(db.committedWrites).toHaveLength(3)
    const budgetSourceQueries = db.records.filter(record =>
      record.operation === 'select'
      && (
        record.table === 'Funding_Case_Agreement_Budget_Fiscal_Year'
        || record.table === 'Funding_Case_Agreement_Budget_Line_Item'
      )
    )
    expect(budgetSourceQueries).toEqual([
      expect.objectContaining({
        table: 'Funding_Case_Agreement_Budget_Fiscal_Year',
        lockedForUpdate: true
      }),
      expect.objectContaining({
        table: 'Funding_Case_Agreement_Budget_Line_Item',
        lockedForUpdate: true
      }),
      expect.objectContaining({
        table: 'Funding_Case_Agreement_Budget_Fiscal_Year',
        lockedForUpdate: false
      })
    ])
    expect(db.committedWrites).toContainEqual(expect.objectContaining({
      operation: 'update',
      table: 'extensions.gcs_outcome_cost_allocation_allocations',
      update: {
        outcome_label_en: 'Outcome 1',
        outcome_label_fr: 'Resultat 1',
        commitment_label_en: 'Fund: 110 · G/L: 5000',
        commitment_label_fr: 'Fonds : 110 · G/L : 5000',
        fiscal_year_display: '2026-2027',
        resolved_amount: expect.anything(),
        funding_basis_amount: expect.anything()
      },
      wheres: [
        ['id', '=', 'allocation-1'],
        ['agreement_id', '=', 'agreement-1'],
        ['allocation_version_id', '=', 'version-1'],
        ['_deleted', '=', false]
      ]
    }))
    expectLockedVersionQuery(db)
    expectAgreementLifecycleLock(db)
    expect(getLockedVersionRecord(db)?.wheres).toEqual([
      ['id', '=', 'version-1'],
      ['agreement_id', '=', 'agreement-1'],
      ['_deleted', '=', false]
    ])
    expect(db.records.filter(record =>
      record.operation === 'update'
      && record.table === 'extensions.gcs_outcome_cost_allocation_versions'
    )).toEqual([
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'inactive',
          completed_at: expect.anything()
        }),
        wheres: [
          ['agreement_id', '=', 'agreement-1'],
          ['status', '=', 'active'],
          ['_deleted', '=', false]
        ]
      }),
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'active',
          completed_at: expect.anything()
        }),
        wheres: [
          ['id', '=', 'version-1'],
          ['agreement_id', '=', 'agreement-1'],
          ['status', '=', 'draft'],
          ['_deleted', '=', false]
        ]
      })
    ])

    const paidCoverageQuery = db.records.find(record =>
      record.table === 'Funding_Case_Agreement_Payment_Line'
      && record.joins.length > 0
    )
    expect(paidCoverageQuery?.joins.map(join => ({
      table: join.args[0],
      predicates: join.predicates
    }))).toEqual([
      {
        table: 'Funding_Case_Agreement_Payment',
        predicates: [[
          'onRef',
          'Funding_Case_Agreement_Payment.id',
          'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment'
        ]]
      },
      {
        table: 'Funding_Case_Agreement_Commitment_Line',
        predicates: [[
          'onRef',
          'Funding_Case_Agreement_Commitment_Line.id',
          'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline'
        ]]
      },
      {
        table: 'Funding_Case_Agreement_Commitment',
        predicates: [[
          'onRef',
          'Funding_Case_Agreement_Commitment.id',
          'Funding_Case_Agreement_Commitment_Line.egcs_fc_commitment'
        ]]
      }
    ])
    expect(paidCoverageQuery?.wheres).toEqual([
      ['Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement', '=', 'agreement-1'],
      ['Funding_Case_Agreement_Commitment.egcs_fc_type', 'in', ['1']],
      ['Funding_Case_Agreement_Commitment._deleted', '=', false],
      ['Funding_Case_Agreement_Commitment_Line._deleted', '=', false],
      ['Funding_Case_Agreement_Payment_Line._deleted', '=', false],
      ['Funding_Case_Agreement_Payment._deleted', '=', false],
      [expect.any(Object)]
    ])
  })

  it.each([
    undefined,
    { ...versionRow, status: 'active' }
  ])('rejects completion when the version is absent or not a draft without writing', async version => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', version ? [version] : [])

    await expect(completeAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig
    )).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_COMPLETE_REQUIRED'
    })

    expect(db.transactionEntries).toBe(1)
    expectLockedVersionQuery(db)
    expect(db.records.some(record => record.operation === 'update')).toBe(false)
  })

  it('does not change version statuses when allocation validation fails', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [{
      ...allocationRow,
      outcome_id: 'stale-outcome'
    }])
    enqueueCompletionBudgetCapture(db)
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])

    await expect(completeAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig
    )).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME'
        })
      ]
    })

    expect(db.transactionEntries).toBe(1)
    expectLockedVersionQuery(db)
    expect(db.records.some(record => record.operation === 'update')).toBe(false)
  })

  it('does not change version statuses when payment coverage validation fails', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [allocationRow])
    enqueueCompletionBudgetCapture(db)
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])
    enqueuePaymentCoverageLocks(db)
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [{
      commitment_line_id: 'commitment-line-1',
      commitment_type: '1',
      agreement_budget_fiscal_year_id: 'year-1',
      stream_commitment_id: 'stream-commitment-1',
      paid_amount: '100.02'
    }])

    await expect(completeAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig
    )).rejects.toMatchObject({
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE',
        path: 'paidCommitmentLines.0'
      }]
    })

    expect(db.transactionEntries).toBe(1)
    expectLockedVersionQuery(db)
    expect(db.records.some(record => record.operation === 'update')).toBe(false)
  })

  it('does not activate a draft with an unmapped stream commitment', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [{
      ...allocationRow,
      stream_commitment_id: 'stale-stream-commitment'
    }])
    enqueueCompletionBudgetCapture(db)
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])

    await expect(completeAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig
    )).rejects.toMatchObject({
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_MAPPING_MISSING',
        path: 'allocations.0.outcomeId'
      }]
    })

    expect(db.transactionEntries).toBe(1)
    expectAgreementLifecycleLock(db)
    expect(db.records.find(record =>
      record.operation === 'select'
      && record.table === 'Transfer_Payment_Stream_Chart_of_Account'
    )).toMatchObject({
      scope: 'transaction',
      lockedForShare: true
    })
    expect(db.records.some(record => record.operation === 'update')).toBe(false)
  })

  it('does not activate allocations for commitment types that are no longer enabled', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [{
      ...allocationRow,
      commitment_type: '2'
    }])
    enqueueCompletionBudgetCapture(db)
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])

    await expect(completeAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig
    )).rejects.toMatchObject({
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_TYPE_DISABLED',
        path: 'allocations.0.commitmentType'
      }]
    })

    expect(db.records.some(record =>
      record.table === 'Transfer_Payment_Stream_Chart_of_Account'
    )).toBe(false)
    expect(db.records.some(record => record.operation === 'update')).toBe(false)
  })

  it('does not activate a mapping whose commitment was reparented to another stream budget', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [allocationRow])
    enqueueCompletionBudgetCapture(db)
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'different-stream-budget'
    }])

    await expect(completeAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig
    )).rejects.toMatchObject({
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH',
        path: 'allocations.0.streamCommitmentId'
      }]
    })

    expect(db.records.find(record =>
      record.table === 'Transfer_Payment_Stream_Chart_of_Account'
    )).toMatchObject({
      scope: 'transaction',
      lockedForShare: true
    })
    expect(db.records.some(record => record.operation === 'update')).toBe(false)
  })

  it('saves and completes a draft inside one transaction', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [versionRow])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [allocationRow])
    enqueueCompletionBudgetCapture(db)
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])
    enqueuePaymentCoverageLocks(db)
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [])
    enqueueAllocationLabelSnapshot(db)
    db.enqueue('update', 'extensions.gcs_outcome_cost_allocation_versions', [])
    db.enqueue('update', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      status: 'active',
      completed_at: '2026-01-03T00:00:00.000Z'
    }])

    await expect(saveAndCompleteAllocationVersion(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'version-1',
      allocationConfig,
      [allocation]
    )).resolves.toMatchObject({
      id: 'version-1',
      status: 'active'
    })

    expect(db.transactionEntries).toBe(1)
    expect(db.records.filter(record => record.table === 'Transfer_Payment_Stream')).toHaveLength(2)
    expect(db.records.filter(record =>
      record.table === 'Funding_Case_Agreement_Profile'
    )).toHaveLength(6)
    expect(db.committedWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'insert',
        table: 'extensions.gcs_outcome_cost_allocation_allocations'
      }),
      expect.objectContaining({
        operation: 'update',
        table: 'extensions.gcs_outcome_cost_allocation_versions',
        update: expect.objectContaining({ status: 'active' })
      })
    ]))
  })
})

describe('outcome allocation saves and validation', () => {
  it('rejects edits to absent and non-draft versions', async () => {
    for (const version of [undefined, { id: 'version-1', status: 'active' }]) {
      const db = new ScriptedDb()
      db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', version ? [version] : [])

      await expect(saveAllocations(
        asAllocationDb(db),
        'agreement-1',
        'version-1',
        []
      )).rejects.toMatchObject({
        code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_EDIT_REQUIRED'
      })
      expect(db.transactionEntries).toBe(1)
      expectLockedVersionQuery(db)
      expectAgreementLifecycleLock(db)
      expect(getLockedVersionRecord(db)?.wheres).toEqual([
        ['id', '=', 'version-1'],
        ['agreement_id', '=', 'agreement-1'],
        ['_deleted', '=', false]
      ])
    }
  })

  it('soft-deletes prior rows and leaves a draft empty when no allocations are supplied', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      id: 'version-1',
      status: 'draft'
    }])

    await expect(saveAllocations(
      asAllocationDb(db),
      'agreement-1',
      'version-1',
      []
    )).resolves.toBeUndefined()

    expect(db.transactionEntries).toBe(1)
    expectLockedVersionQuery(db)
    expectAgreementLifecycleLock(db)
    expect(getLockedVersionRecord(db)?.wheres).toEqual([
      ['id', '=', 'version-1'],
      ['agreement_id', '=', 'agreement-1'],
      ['_deleted', '=', false]
    ])
    expect(db.records.filter(record => record.operation === 'update')).toHaveLength(1)
    expect(db.records.find(record => record.operation === 'update')).toMatchObject({
      update: { _deleted: true },
      wheres: [
        ['agreement_id', '=', 'agreement-1'],
        ['allocation_version_id', '=', 'version-1'],
        ['_deleted', '=', false]
      ]
    })
    expect(db.records.some(record => record.operation === 'insert')).toBe(false)
  })

  it('inserts normalized allocation rows after soft-deleting the previous draft rows', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      id: 'version-1',
      status: 'draft'
    }])

    await expect(saveAllocations(
      asAllocationDb(db),
      'agreement-1',
      'version-1',
      [{
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'year-1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: '100.0000'
      }]
    )).resolves.toBeUndefined()

    expect(db.transactionEntries).toBe(1)
    expectLockedVersionQuery(db)
    expect(db.records.find(record => record.operation === 'insert')?.values).toEqual([{
      allocation_version_id: 'version-1',
      agreement_id: 'agreement-1',
      commitment_type: '1',
      stream_commitment_id: 'stream-commitment-1',
      agreement_budget_fiscal_year_id: 'year-1',
      outcome_id: 'outcome-1',
      allocation_method: 'amount',
      allocation_value: expect.anything(),
      resolved_amount: null,
      funding_basis_amount: null
    }])
  })

  it('validates allocations against active outcomes and budget totals', async () => {
    const validDb = new ScriptedDb()
    validDb.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    validDb.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])

    await expect(validateAgreementAllocations(
      asAllocationDb(validDb),
      'agreement-1',
      'stream-1',
      [allocation]
    )).resolves.toEqual([])

    const invalidDb = new ScriptedDb()
    invalidDb.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    invalidDb.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])

    const issues = await validateAgreementAllocations(
      asAllocationDb(invalidDb),
      'agreement-1',
      'stream-1',
      [{ ...allocation, outcomeId: 'stale-outcome' }]
    )
    expect(issues.map(issue => issue.code)).toContain('GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME')
  })

  it('skips payment coverage queries when no configured commitment type is in scope', async () => {
    const db = new ScriptedDb()

    await expect(validateAllocationPaymentCoverage(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      { enabledCommitmentTypes: [], mappings: [] },
      [allocation]
    )).resolves.toEqual([])
    expect(db.records).toEqual([])

    await expect(validateAllocationPaymentCoverage(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      allocationConfig,
      [allocation],
      '2'
    )).resolves.toEqual([])
    expect(db.records).toEqual([])
  })
})

describe('generated outcome allocation commitment lines', () => {
  it('defers commitment types that are not managed by the extension', async () => {
    const db = new ScriptedDb()

    await expect(getGeneratedCommitmentLines(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      '2',
      allocationConfig
    )).resolves.toEqual({ status: 'continue' })
    expect(db.records).toEqual([])
  })

  it('requires an active allocation version for configured commitment types', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])

    await expect(getGeneratedCommitmentLines(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      '1',
      allocationConfig
    )).resolves.toEqual({
      status: 'handled',
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED',
        path: 'allocationVersion',
        message: 'apiErrors.extensions.outcome_cost_allocation.active_required'
      }],
      lines: []
    })
  })

  it('resolves active allocations to configured stream commitment lines', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      status: 'active',
      completed_at: '2026-01-03T00:00:00.000Z'
    }])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [allocationRow])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [])

    await expect(getGeneratedCommitmentLines(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      '1',
      allocationConfig
    )).resolves.toEqual({
      status: 'handled',
      issues: [],
      lines: [{
        allocation: {
          ...allocation,
          allocationVersionId: 'version-1',
          amount: '100.00'
        },
        allocationVersionId: 'version-1',
        streamCommitmentId: 'stream-commitment-1'
      }]
    })
  })

  it('uses completed economic snapshots when current program funding changes', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      status: 'active',
      completed_at: '2026-01-03T00:00:00.000Z'
    }])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [{
      ...allocationRow,
      allocation_method: 'percentage',
      allocation_value: '50.0000',
      resolved_amount: '40.00',
      funding_basis_amount: '80.00'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [{
      ...budgetYearRow,
      program_funding: '250.00'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [{
      ...budgetYearRow,
      program_funding: '250.00'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [])

    await expect(getGeneratedCommitmentLines(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      '1',
      allocationConfig
    )).resolves.toMatchObject({
      status: 'handled',
      issues: [],
      lines: [{
        allocation: {
          allocationMethod: 'percentage',
          allocationValue: '50.0000',
          resolvedAmount: '40.00',
          fundingBasisAmount: '80.00',
          amount: '40.00'
        }
      }]
    })
  })

  it('rejects managed commitment creation when the selected type has no positive allocations', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      status: 'active',
      completed_at: '2026-01-03T00:00:00.000Z'
    }])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [{
      ...allocationRow,
      commitment_type: '2'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [])

    await expect(getGeneratedCommitmentLines(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      '1',
      allocationConfig
    )).resolves.toEqual({
      status: 'handled',
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING',
        path: 'allocations',
        message: 'apiErrors.extensions.outcome_cost_allocation.commitment_lines_missing'
      }],
      lines: []
    })
  })
})

describe('generated outcome allocation payment edge cases', () => {
  it('defers missing and unsupported commitments', async () => {
    const missingDb = new ScriptedDb()
    missingDb.enqueue('select', 'Funding_Case_Agreement_Commitment', [])
    await expect(getGeneratedPaymentLines(
      asAllocationDb(missingDb),
      'agreement-1',
      'stream-1',
      'missing',
      'year-1',
      10,
      allocationConfig
    )).resolves.toEqual({ status: 'continue' })

    const unsupportedDb = new ScriptedDb()
    unsupportedDb.enqueue('select', 'Funding_Case_Agreement_Commitment', [{
      id: 'commitment-1',
      egcs_fc_type: 'unsupported'
    }])
    await expect(getGeneratedPaymentLines(
      asAllocationDb(unsupportedDb),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'year-1',
      10,
      allocationConfig
    )).resolves.toEqual({ status: 'continue' })
  })

  it('requires an active allocation before generating payment lines', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Commitment', [{
      id: 'commitment-1',
      egcs_fc_type: '1'
    }])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [])

    await expect(getGeneratedPaymentLines(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'year-1',
      10,
      allocationConfig
    )).resolves.toMatchObject({
      status: 'handled',
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED'
      }],
      lines: []
    })
  })

  it('locks exactly the mapped active commitment lines before generating payment splits', async () => {
    const db = new ScriptedDb()
    db.enqueue('select', 'Funding_Case_Agreement_Commitment', [{
      id: 'commitment-1',
      egcs_fc_type: '1'
    }])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_versions', [{
      ...versionRow,
      status: 'active',
      completed_at: '2026-01-03T00:00:00.000Z'
    }])
    db.enqueue('select', 'extensions.gcs_outcome_cost_allocation_allocations', [allocationRow])
    db.enqueue('select', 'Funding_Case_Agreement_Budget_Fiscal_Year', [budgetYearRow])
    db.enqueue('select', 'Funding_Case_Agreement_Activity', [outcomeRow])
    db.enqueue('select', 'Transfer_Payment_Stream_Chart_of_Account', [{
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1'
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Commitment_Line', [{
      id: 'commitment-line-1',
      stream_commitment_id: 'stream-commitment-1',
      amount: '100.00',
      provenance_version_id: null,
      provenance_year_id: null,
      provenance_outcome_id: null,
      provenance_stream_commitment_id: null
    }])
    db.enqueue('select', 'Funding_Case_Agreement_Payment_Line', [])

    await expect(getGeneratedPaymentLines(
      asAllocationDb(db),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'year-1',
      40,
      allocationConfig
    )).resolves.toEqual({
      status: 'handled',
      issues: [],
      lines: [{
        commitmentLineId: 'commitment-line-1',
        amount: '40.00'
      }]
    })

    const lockedLinesQuery = db.records.find(record =>
      record.table === 'Funding_Case_Agreement_Commitment_Line'
    )
    expect(lockedLinesQuery).toMatchObject({
      lockedForUpdate: true,
      wheres: [
        ['Funding_Case_Agreement_Commitment_Line.egcs_fc_commitment', '=', 'commitment-1'],
        ['Funding_Case_Agreement_Commitment_Line.egcs_fc_transferpaymentstreamchartofaccount', 'in', ['stream-commitment-1']],
        ['Funding_Case_Agreement_Commitment_Line._deleted', '=', false]
      ]
    })

    const priorPaymentsQuery = db.records.find(record =>
      record.table === 'Funding_Case_Agreement_Payment_Line'
    )
    expect(priorPaymentsQuery?.joins.map(join => ({
      table: join.args[0],
      predicates: join.predicates
    }))).toEqual([
      {
        table: 'Funding_Case_Agreement_Payment',
        predicates: [[
          'onRef',
          'Funding_Case_Agreement_Payment.id',
          'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementpayment'
        ]]
      }
    ])
    expect(priorPaymentsQuery?.wheres).toEqual([
      [
        'Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline',
        'in',
        ['commitment-line-1']
      ],
      ['Funding_Case_Agreement_Payment_Line._deleted', '=', false],
      ['Funding_Case_Agreement_Payment._deleted', '=', false],
      [expect.any(Object)]
    ])
  })
})
