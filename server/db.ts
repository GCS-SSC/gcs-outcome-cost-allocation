/* eslint-disable jsdoc/require-jsdoc */
import type { Generated, Kysely } from 'kysely'
import type { AllocationVersionStatus } from '../shared/allocation'

export interface OutcomeCostAllocationHostDatabase {
  Funding_Case_Agreement_Profile: {
    id: string
    egcs_fc_transferpaymentstream: string
    _deleted: boolean
  }
  Funding_Case_Agreement_Activity: {
    id: string
    egcs_fc_fundingagreement: string
    _deleted: boolean
  }
  Funding_Case_Agreement_Outcome_Activity: {
    id: string
    egcs_fc_activity: string
    egcs_fc_outcomes: string
    _deleted: boolean
  }
  Transfer_Payment_Outcome: {
    id: string
    egcs_tp_transferpaymentprofile: string
    egcs_tp_name_en: string
    egcs_tp_name_fr: string
    _deleted: boolean
  }
  Funding_Case_Agreement_Budget_Fiscal_Year: {
    id: string
    egcs_fc_fundingagreement: string
    egcs_fc_fiscalyear: string
    _deleted: boolean
  }
  Funding_Case_Agreement_Budget_Line_Item: {
    id: string
    egcs_fc_fundingagreementbudgetfiscalyear: string
    egcs_fc_programfunding: number
    _deleted: boolean
  }
  Transfer_Payment_Stream_Budget: {
    id: string
    egcs_tp_transferpaymentstream: string
    egcs_tp_transferpaymentbudget: string
    _deleted: boolean
  }
  Transfer_Payment_Fiscal_Year_Budget: {
    id: string
    egcs_tp_fiscalyear: string
    _deleted: boolean
  }
  Transfer_Payment_Stream_Commitment: {
    id: string
    egcs_tp_streambudget: string
    egcs_tp_transferpaymentstream: string
    egcs_tp_gl: number
    egcs_tp_gldescription: string
    _deleted: boolean
  }
  Agency_Fiscal_Year: {
    id: string
    egcs_ay_fiscalyeardisplay: string
    egcs_ay_fiscalyear: number
    _deleted: boolean
  }
  Funding_Case_Agreement_Commitment: {
    id: Generated<string>
    egcs_fc_fundingagreement: string
    egcs_fc_type: 'commitment' | 'paye' | 'paye2' | 'pyp'
    egcs_fc_status: string
    egcs_fc_financialsystemnumber: string | null
    egcs_fc_active?: boolean
    _deleted?: boolean
  }
  Funding_Case_Agreement_Commitment_Line: {
    id: Generated<string>
    egcs_fc_commitment: string
    egcs_fc_commitmentlinenumber: number
    egcs_fc_transferpaymentstreamcommitment: string
    egcs_fc_amount: number
    _deleted?: boolean
  }
  Funding_Case_Agreement_Payment: {
    id: Generated<string>
    egcs_fc_fundingagreementcommitment: string
    egcs_fc_status: string
    _deleted?: boolean
  }
  Funding_Case_Agreement_Payment_Line: {
    id: Generated<string>
    egcs_fc_fundingagreementpayment: string
    egcs_fc_fundingagreementcommitmentline: string
    egcs_fc_amount: number
    _deleted?: boolean
  }
  'extensions.gcs_outcome_cost_allocation_versions': {
    id: Generated<string>
    agreement_id: string
    version_number: number
    status: AllocationVersionStatus
    created_at: Generated<Date | string>
    completed_at: Date | string | null
    _deleted?: boolean
  }
  'extensions.gcs_outcome_cost_allocation_allocations': {
    id: Generated<string>
    allocation_version_id: string
    agreement_id: string
    agreement_budget_fiscal_year_id: string
    outcome_id: string
    allocation_method: 'amount' | 'percentage'
    allocation_value: number
    _deleted?: boolean
  }
  'extensions.gcs_outcome_cost_allocation_commitment_lines': {
    id: Generated<string>
    allocation_version_id: string
    generated_commitment_id: string
    commitment_line_id: string
    agreement_id: string
    agreement_budget_fiscal_year_id: string
    outcome_id: string
    stream_commitment_id: string
    generated_amount: number
    _deleted?: boolean
  }
}

export type OutcomeCostAllocationDb = Kysely<OutcomeCostAllocationHostDatabase>

export const asOutcomeCostAllocationDb = (db: unknown): OutcomeCostAllocationDb =>
  db as OutcomeCostAllocationDb
