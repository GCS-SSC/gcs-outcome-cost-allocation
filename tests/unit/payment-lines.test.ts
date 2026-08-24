import { describe, expect, it } from 'vitest'
import { getGeneratedPaymentLines, validateAllocationPaymentCoverage } from '../../server/allocation-data'
import { asOutcomeCostAllocationDb } from '../../server/db'
import type {
  AllocationMethod,
  CommitmentType,
  OutcomeAllocationInput
} from '../../shared/allocation'

const paymentCoverageExcludedStatuses = new Set(['denied'])

interface FakeDbState {
  currentReferenceReads: number
  forUpdateCount: number
  commitments: Array<{
    id: string
    agreementId: string
    type: string
    allocationVersionId?: string
  }>
  commitmentLines: Array<{
    id: string
    lineNumber?: number
    commitmentId: string
    streamCommitmentId: string
    amount: number
    generatedAmount?: number
    agreementBudgetFiscalYearId?: string
    outcomeId?: string
    allocationVersionId?: string
  }>
  paidLines: Array<{
    commitmentLineId: string
    amount: number
    paymentStatus: string
    agreementBudgetFiscalYearId?: string
  }>
  allocations: Array<{
    allocation_version_id: string
    commitment_type: CommitmentType
    stream_commitment_id: string
    agreement_budget_fiscal_year_id: string
    outcome_id: string
    allocation_method: AllocationMethod
    allocation_value: number
  }>
  versions: Array<{
    id: string
    agreement_id: string
    version_number: number
    status: 'active' | 'inactive'
    created_at: string
    completed_at: string
  }>
}

const budgetYears = [
  {
    id: 'budget-year-1',
    fiscal_year_id: 'fy-1',
    fiscal_year_display: '2025-2026',
    program_funding: 100,
    stream_budget_id: 'stream-budget-1'
  }
]

const allocations: FakeDbState['allocations'] = [
  {
    allocation_version_id: 'version-1',
    commitment_type: '1',
    stream_commitment_id: 'stream-commitment-1',
    agreement_budget_fiscal_year_id: 'budget-year-1',
    outcome_id: 'outcome-1',
    allocation_method: 'amount',
    allocation_value: 60
  },
  {
    allocation_version_id: 'version-1',
    commitment_type: '1',
    stream_commitment_id: 'stream-commitment-2',
    agreement_budget_fiscal_year_id: 'budget-year-1',
    outcome_id: 'outcome-2',
    allocation_method: 'amount',
    allocation_value: 40
  }
]

class FakeQuery {
  private readonly wheres: Array<{ column: string, operator: string, value: unknown }> = []
  private selectedColumns: string[] = []

  constructor(
    private readonly state: FakeDbState,
    private readonly table: string
  ) {}

  innerJoin() {
    return this
  }

  leftJoin() {
    return this
  }

  select(columns: string[] | string) {
    this.selectedColumns = Array.isArray(columns) ? columns : [columns]
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
    this.state.forUpdateCount += 1
    return this
  }

  where(column: string, operator: string, value: unknown) {
    this.wheres.push({ column, operator, value })
    return this
  }

  async executeTakeFirst() {
    return (await this.execute())[0]
  }

  async execute() {
    if (this.table === 'extensions.gcs_outcome_cost_allocation_versions') {
      this.state.currentReferenceReads += 1
      const versionId = this.wheres.find(where => where.column === 'id')?.value
      const status = this.findWhereValue('status')
      return this.state.versions.filter(version =>
        (versionId === undefined || version.id === versionId)
        && (status === undefined || version.status === status)
      )
    }

    if (this.table === 'extensions.gcs_outcome_cost_allocation_allocations') {
      this.state.currentReferenceReads += 1
      const allocationVersionId = this.findWhereValue('allocation_version_id')
      return this.state.allocations.filter(allocation =>
        allocationVersionId === undefined
        || allocation.allocation_version_id === allocationVersionId
      )
    }

    if (this.table === 'extensions.gcs_outcome_cost_allocation_commitment_lines') {
      const commitmentId = this.findWhereValue('generated_commitment_id')
      const agreementBudgetFiscalYearId = this.findWhereValue('agreement_budget_fiscal_year_id')
      return this.state.commitmentLines
        .filter(line => line.commitmentId === commitmentId)
        .filter(line => line.agreementBudgetFiscalYearId === agreementBudgetFiscalYearId)
        .map(line => ({
          commitment_line_id: line.id,
          commitment_line_amount: line.amount,
          generated_amount: line.generatedAmount ?? line.amount
        }))
    }

    if (this.table === 'Funding_Case_Agreement_Budget_Fiscal_Year') {
      this.state.currentReferenceReads += 1
      return budgetYears
    }

    if (this.table === 'Funding_Case_Agreement_Activity') {
      this.state.currentReferenceReads += 1
      return [
        { id: 'outcome-1', label_en: 'Outcome 1', label_fr: 'Resultat 1' },
        { id: 'outcome-2', label_en: 'Outcome 2', label_fr: 'Resultat 2' }
      ]
    }

    if (this.table === 'Transfer_Payment_Stream_Chart_of_Account') {
      this.state.currentReferenceReads += 1
      return [
        { id: 'stream-commitment-1', stream_budget_id: 'stream-budget-1' },
        { id: 'stream-commitment-2', stream_budget_id: 'stream-budget-1' }
      ]
    }

    if (this.table === 'Funding_Case_Agreement_Commitment') {
      const commitmentId = this.findWhereValue('id')
      return this.state.commitments
        .filter(commitment => commitment.id === commitmentId)
        .map(commitment => ({
          id: commitment.id,
          egcs_fc_type: commitment.type,
          allocation_version_id: commitment.allocationVersionId ?? null
        }))
    }

    if (this.table === 'Funding_Case_Agreement_Commitment_Line') {
      const commitmentId = this.findWhereValue('egcs_fc_commitment')
      const streamCommitmentIds = this.findWhereValue('egcs_fc_transferpaymentstreamchartofaccount') as string[]
      return this.state.commitmentLines
        .filter(line => line.commitmentId === commitmentId)
        .filter(line => streamCommitmentIds.includes(line.streamCommitmentId))
        .sort((left, right) => {
          const lineNumberDifference = (left.lineNumber ?? 0) - (right.lineNumber ?? 0)
          if (lineNumberDifference !== 0) {
            return lineNumberDifference
          }
          return left.id < right.id ? -1 : 1
        })
        .map(line => ({
          id: line.id,
          line_number: line.lineNumber ?? 0,
          stream_commitment_id: line.streamCommitmentId,
          amount: line.amount,
          provenance_version_id: line.outcomeId
            ? line.allocationVersionId ?? 'version-1'
            : null,
          provenance_year_id: line.agreementBudgetFiscalYearId ?? null,
          provenance_outcome_id: line.outcomeId ?? null,
          provenance_stream_commitment_id: line.outcomeId
            ? line.streamCommitmentId
            : null
        }))
    }

    if (this.table === 'Funding_Case_Agreement_Payment_Line') {
      if (this.selectedColumns.some(column => String(column).includes('stream_commitment_id'))) {
        const agreementId = this.findWhereValue('Funding_Case_Agreement_Commitment.egcs_fc_fundingagreement')
        const commitmentTypes = this.findWhereValue('Funding_Case_Agreement_Commitment.egcs_fc_type') as string[]
        return this.state.paidLines.flatMap(paidLine => {
          const commitmentLine = this.state.commitmentLines.find(line => line.id === paidLine.commitmentLineId)
          const commitment = this.state.commitments.find(candidate => candidate.id === commitmentLine?.commitmentId)
          if (
            paymentCoverageExcludedStatuses.has(paidLine.paymentStatus)
            || !commitmentLine
            || !commitment
            || commitment.agreementId !== agreementId
            || !commitmentTypes.includes(commitment.type)
          ) {
            return []
          }

          return [{
            commitment_line_id: commitmentLine.id,
            commitment_type: commitment.type,
            agreement_budget_fiscal_year_id: paidLine.agreementBudgetFiscalYearId ?? 'budget-year-1',
            stream_commitment_id: commitmentLine.streamCommitmentId,
            paid_amount: paidLine.amount
          }]
        })
      }

      const commitmentLineIds = this.findWhereValue('Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline') as string[]
      return commitmentLineIds.flatMap(commitmentLineId => {
        const paidAmount = this.state.paidLines
          .filter(line => line.commitmentLineId === commitmentLineId)
          .filter(line => !paymentCoverageExcludedStatuses.has(line.paymentStatus))
          .reduce((sum, line) => sum + line.amount, 0)

        return paidAmount > 0
          ? [{
              commitment_line_id: commitmentLineId,
              paid_amount: paidAmount
            }]
          : []
      })
    }

    return []
  }

  private findWhereValue(columnSuffix: string) {
    return this.wheres.find(where => where.column.endsWith(columnSuffix))?.value
  }
}

const createFakeDb = (state: FakeDbState) => asOutcomeCostAllocationDb({
  selectFrom: (table: string) => new FakeQuery(state, table)
})

const toAllocationInputs = (
  rows: FakeDbState['allocations']
): OutcomeAllocationInput[] => rows.map(row => ({
  commitmentType: row.commitment_type,
  streamCommitmentId: row.stream_commitment_id,
  agreementBudgetFiscalYearId: row.agreement_budget_fiscal_year_id,
  outcomeId: row.outcome_id,
  allocationMethod: row.allocation_method,
  allocationValue: row.allocation_value
}))

const config = {
  enabledCommitmentTypes: ['1'],
  mappings: [
    {
      commitmentType: '1',
      outcomeId: 'outcome-1',
      streamBudgetId: 'stream-budget-1',
      streamCommitmentId: 'stream-commitment-1'
    },
    {
      commitmentType: '1',
      outcomeId: 'outcome-2',
      streamBudgetId: 'stream-budget-1',
      streamCommitmentId: 'stream-commitment-2'
    }
  ]
}

const createState = (): FakeDbState => ({
  currentReferenceReads: 0,
  forUpdateCount: 0,
  commitments: [
    {
      id: 'commitment-1',
      agreementId: 'agreement-1',
      type: '1'
    },
    {
      id: 'paye-1',
      agreementId: 'agreement-1',
      type: '2'
    }
  ],
  commitmentLines: [
    {
      id: 'line-1',
      commitmentId: 'commitment-1',
      streamCommitmentId: 'stream-commitment-1',
      amount: 60
    },
    {
      id: 'line-2',
      commitmentId: 'commitment-1',
      streamCommitmentId: 'stream-commitment-2',
      amount: 40
    }
  ],
  paidLines: [],
  allocations,
  versions: [{
    id: 'version-1',
    agreement_id: 'agreement-1',
    version_number: 1,
    status: 'active',
    created_at: '2026-05-09T00:00:00.000Z',
    completed_at: '2026-05-09T00:00:00.000Z'
  }]
})

describe('outcome cost allocation payment generation', () => {
  it('generates payment lines from the active cost allocation and selected commitment lines', async () => {
    const state = createState()
    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      50,
      config
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 30 },
        { commitmentLineId: 'line-2', amount: 20 }
      ]
    })
    expect(state.forUpdateCount).toBe(1)
  })

  it('uses every manual commitment line for a duplicated stream commitment deterministically', async () => {
    const state = createState()
    state.allocations = [
      {
        ...allocations[0],
        stream_commitment_id: 'stream-commitment-1'
      },
      {
        ...allocations[1],
        stream_commitment_id: 'stream-commitment-1'
      }
    ]
    state.commitmentLines = [
      {
        id: 'line-2',
        lineNumber: 2,
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        amount: 40
      },
      {
        id: 'line-1',
        lineNumber: 1,
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        amount: 60
      }
    ]

    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      50,
      {
        enabledCommitmentTypes: ['1'],
        mappings: [
          config.mappings[0],
          {
            ...config.mappings[1],
            streamCommitmentId: 'stream-commitment-1'
          }
        ]
      }
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 30 },
        { commitmentLineId: 'line-2', amount: 20 }
      ]
    })
  })

  it('respects remaining balances when generated payment lines are capped by previous payments', async () => {
    const state = createState()
    state.paidLines = [
      {
        commitmentLineId: 'line-1',
        amount: 50,
        paymentStatus: 'paid'
      }
    ]

    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      20,
      config
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 10 },
        { commitmentLineId: 'line-2', amount: 10 }
      ]
    })
  })

  it('matches duplicate stream commitment lines by outcome provenance', async () => {
    const state = createState()
    state.commitments[0] = {
      ...state.commitments[0]!,
      allocationVersionId: 'version-1'
    }
    state.allocations = [
      {
        ...allocations[0],
        stream_commitment_id: 'stream-commitment-1',
        allocation_value: 60
      },
      {
        ...allocations[1],
        stream_commitment_id: 'stream-commitment-1',
        allocation_value: 40
      }
    ]
    state.commitmentLines = [
      {
        id: 'line-1',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-1',
        amount: 60
      },
      {
        id: 'line-2',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-2',
        amount: 40
      }
    ]

    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      50,
      {
        enabledCommitmentTypes: ['1'],
        mappings: [
          {
            ...config.mappings[0],
            streamCommitmentId: 'stream-commitment-1'
          },
          {
            ...config.mappings[1],
            streamCommitmentId: 'stream-commitment-1'
          }
        ]
      }
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 30 },
        { commitmentLineId: 'line-2', amount: 20 }
      ]
    })
  })

  it('uses the generated commitment provenance version after a newer version becomes active', async () => {
    const state = createState()
    state.commitments[0] = {
      ...state.commitments[0]!,
      allocationVersionId: 'version-1'
    }
    state.versions = [
      {
        ...state.versions[0]!,
        status: 'inactive'
      },
      {
        ...state.versions[0]!,
        id: 'version-2',
        version_number: 2,
        status: 'active'
      }
    ]
    state.allocations = [
      {
        ...allocations[0],
        stream_commitment_id: 'stream-commitment-1',
        allocation_value: 60
      },
      {
        ...allocations[1],
        stream_commitment_id: 'stream-commitment-1',
        allocation_value: 40
      },
      {
        ...allocations[0],
        allocation_version_id: 'version-2',
        stream_commitment_id: 'stream-commitment-1',
        allocation_value: 10
      },
      {
        ...allocations[1],
        allocation_version_id: 'version-2',
        stream_commitment_id: 'stream-commitment-1',
        allocation_value: 90
      }
    ]
    state.commitmentLines = [
      {
        id: 'line-1',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-1',
        allocationVersionId: 'version-1',
        amount: 60
      },
      {
        id: 'line-2',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-2',
        allocationVersionId: 'version-1',
        amount: 40
      }
    ]

    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      50,
      {
        enabledCommitmentTypes: ['1'],
        mappings: [
          {
            ...config.mappings[0],
            streamCommitmentId: 'stream-commitment-1'
          },
          {
            ...config.mappings[1],
            streamCommitmentId: 'stream-commitment-1'
          }
        ]
      }
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 30 },
        { commitmentLineId: 'line-2', amount: 20 }
      ]
    })
  })

  it('uses immutable generated amounts after current config, labels, outcomes, funding, and mixed allocation methods drift', async () => {
    const state = createState()
    state.commitments[0] = {
      ...state.commitments[0]!,
      allocationVersionId: 'version-1'
    }
    state.allocations = [
      {
        ...allocations[0],
        allocation_method: 'percentage',
        allocation_value: 10
      },
      {
        ...allocations[1],
        allocation_method: 'amount',
        allocation_value: 90
      }
    ]
    state.commitmentLines = [
      {
        id: 'line-1',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-1',
        allocationVersionId: 'version-1',
        amount: 70,
        generatedAmount: 70
      },
      {
        id: 'line-2',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-2',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-2',
        allocationVersionId: 'version-1',
        amount: 30,
        generatedAmount: 30
      }
    ]

    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      50,
      {
        enabledCommitmentTypes: [],
        mappings: []
      }
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 35 },
        { commitmentLineId: 'line-2', amount: 15 }
      ]
    })
    expect(state.currentReferenceReads).toBe(0)
  })

  it('uses recorded stream commitment coordinates after current mappings change', async () => {
    const state = createState()
    state.commitments[0] = {
      ...state.commitments[0]!,
      allocationVersionId: 'version-1'
    }
    state.commitmentLines = [
      {
        id: 'line-1',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-1',
        allocationVersionId: 'version-1',
        amount: 60
      },
      {
        id: 'line-2',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-2',
        agreementBudgetFiscalYearId: 'budget-year-1',
        outcomeId: 'outcome-2',
        allocationVersionId: 'version-1',
        amount: 40
      }
    ]

    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      50,
      {
        enabledCommitmentTypes: ['1'],
        mappings: [
          {
            ...config.mappings[0],
            streamCommitmentId: 'stream-commitment-2'
          },
          {
            ...config.mappings[1],
            streamCommitmentId: 'stream-commitment-1'
          }
        ]
      }
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 30 },
        { commitmentLineId: 'line-2', amount: 20 }
      ]
    })
  })

  it('does not require the selected commitment type to carry the full agreement allocation', async () => {
    const state = createState()
    state.allocations = [
      {
        allocation_version_id: 'version-1',
        commitment_type: '1',
        stream_commitment_id: 'stream-commitment-1',
        agreement_budget_fiscal_year_id: 'budget-year-1',
        outcome_id: 'outcome-1',
        allocation_method: 'amount',
        allocation_value: 60
      },
      {
        allocation_version_id: 'version-1',
        commitment_type: '2',
        stream_commitment_id: 'stream-commitment-2',
        agreement_budget_fiscal_year_id: 'budget-year-1',
        outcome_id: 'outcome-2',
        allocation_method: 'amount',
        allocation_value: 40
      }
    ]
    state.commitmentLines = [
      {
        id: 'line-1',
        commitmentId: 'commitment-1',
        streamCommitmentId: 'stream-commitment-1',
        amount: 60
      }
    ]

    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'commitment-1',
      'budget-year-1',
      30,
      {
        enabledCommitmentTypes: ['1', '2'],
        mappings: config.mappings
      }
    )

    expect(result).toEqual({
      status: 'handled',
      issues: [],
      lines: [
        { commitmentLineId: 'line-1', amount: 30 }
      ]
    })
  })

  it('rejects cost allocations that would underfund existing payment lines on another stream commitment', async () => {
    const state = createState()
    state.paidLines = [
      {
        commitmentLineId: 'line-2',
        amount: 10,
        paymentStatus: 'inprogress',
        agreementBudgetFiscalYearId: 'budget-year-1'
      }
    ]
    state.allocations = [
      {
        allocation_version_id: 'version-1',
        commitment_type: '1',
        stream_commitment_id: 'stream-commitment-1',
        agreement_budget_fiscal_year_id: 'budget-year-1',
        outcome_id: 'outcome-1',
        allocation_method: 'amount',
        allocation_value: 100
      }
    ]

    const issues = await validateAllocationPaymentCoverage(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      config,
      toAllocationInputs(state.allocations)
    )

    expect(issues.map(issue => issue.code)).toEqual([
      'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE'
    ])
  })

  it('continues to host manual creation when the commitment type is not configured', async () => {
    const state = createState()
    const result = await getGeneratedPaymentLines(
      createFakeDb(state),
      'agreement-1',
      'stream-1',
      'paye-1',
      'budget-year-1',
      50,
      config
    )

    expect(result).toEqual({ status: 'continue' })
    expect(state.forUpdateCount).toBe(0)
  })
})
