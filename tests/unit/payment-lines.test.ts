/* eslint-disable jsdoc/require-jsdoc */
import { describe, expect, it } from 'vitest'
import { getGeneratedPaymentLines } from '../../server/allocation-data'

interface FakeDbState {
  forUpdateCount: number
  commitments: Array<{
    id: string
    agreementId: string
    type: string
  }>
  commitmentLines: Array<{
    id: string
    commitmentId: string
    streamCommitmentId: string
    amount: number
  }>
  paidLines: Array<{
    commitmentLineId: string
    amount: number
    paymentStatus: string
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

const allocations = [
  {
    allocation_version_id: 'version-1',
    commitment_type: 'commitment',
    stream_commitment_id: 'stream-commitment-1',
    agreement_budget_fiscal_year_id: 'budget-year-1',
    outcome_id: 'outcome-1',
    allocation_method: 'amount',
    allocation_value: 60
  },
  {
    allocation_version_id: 'version-1',
    commitment_type: 'commitment',
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
      return [{
        id: 'version-1',
        agreement_id: 'agreement-1',
        version_number: 1,
        status: 'active',
        created_at: '2026-05-09T00:00:00.000Z',
        completed_at: '2026-05-09T00:00:00.000Z'
      }]
    }

    if (this.table === 'extensions.gcs_outcome_cost_allocation_allocations') {
      return allocations
    }

    if (this.table === 'Funding_Case_Agreement_Budget_Fiscal_Year') {
      return budgetYears
    }

    if (this.table === 'Funding_Case_Agreement_Activity') {
      return [
        { id: 'outcome-1', label_en: 'Outcome 1', label_fr: 'Resultat 1' },
        { id: 'outcome-2', label_en: 'Outcome 2', label_fr: 'Resultat 2' }
      ]
    }

    if (this.table === 'Transfer_Payment_Stream_Commitment') {
      return [
        { id: 'stream-commitment-1' },
        { id: 'stream-commitment-2' }
      ]
    }

    if (this.table === 'Funding_Case_Agreement_Commitment') {
      const commitmentId = this.findWhereValue('id')
      return this.state.commitments
        .filter(commitment => commitment.id === commitmentId)
        .map(commitment => ({
          id: commitment.id,
          egcs_fc_type: commitment.type
        }))
    }

    if (this.table === 'Funding_Case_Agreement_Commitment_Line') {
      const commitmentId = this.findWhereValue('egcs_fc_commitment')
      const streamCommitmentIds = this.findWhereValue('egcs_fc_transferpaymentstreamcommitment') as string[]
      return this.state.commitmentLines
        .filter(line => line.commitmentId === commitmentId)
        .filter(line => streamCommitmentIds.includes(line.streamCommitmentId))
        .map(line => ({
          id: line.id,
          egcs_fc_transferpaymentstreamcommitment: line.streamCommitmentId,
          egcs_fc_amount: line.amount
        }))
    }

    if (this.table === 'Funding_Case_Agreement_Payment_Line') {
      const commitmentLineIds = this.findWhereValue('Funding_Case_Agreement_Payment_Line.egcs_fc_fundingagreementcommitmentline') as string[]
      return commitmentLineIds.flatMap(commitmentLineId => {
        const paidAmount = this.state.paidLines
          .filter(line => line.commitmentLineId === commitmentLineId)
          .filter(line => line.paymentStatus !== 'denied')
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

const createFakeDb = (state: FakeDbState) => ({
  selectFrom: (table: string) => new FakeQuery(state, table)
})

const config = {
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
      streamCommitmentId: 'stream-commitment-2'
    }
  ]
}

const createState = (): FakeDbState => ({
  forUpdateCount: 0,
  commitments: [
    {
      id: 'commitment-1',
      agreementId: 'agreement-1',
      type: 'commitment'
    },
    {
      id: 'paye-1',
      agreementId: 'agreement-1',
      type: 'paye'
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
  paidLines: []
})

describe('outcome cost allocation payment generation', () => {
  it('generates payment lines from the active cost allocation and selected commitment lines', async () => {
    const state = createState()
    const result = await getGeneratedPaymentLines(
      createFakeDb(state) as never,
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
      createFakeDb(state) as never,
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

  it('continues to host manual creation when the commitment type is not configured', async () => {
    const state = createState()
    const result = await getGeneratedPaymentLines(
      createFakeDb(state) as never,
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
