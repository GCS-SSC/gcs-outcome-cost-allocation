import type { Generated, JSONColumnType, Kysely } from 'kysely'
import type { AllocationVersionStatus } from '../shared/allocation.ts'

export interface OutcomeCostAllocationHostDatabase {
  'Common_Status': {
    id: string
    egcs_cn_agency: string
    egcs_cn_isdraft: boolean
    egcs_cn_readonly: boolean
    egcs_cn_terminal: boolean
    _deleted: boolean
  }
  'Common_Completion': {
    id: string
    egcs_cn_entitytype: string
    egcs_cn_entityid: string
    _deleted: boolean
  }
  'Funding_Case_Agreement_Profile': {
    id: string
    egcs_fc_transferpaymentstream: string
    _deleted: boolean
  }
  'Funding_Case_Agreement_Activity': {
    id: string
    egcs_fc_fundingagreement: string
    _deleted: boolean
  }
  'Funding_Case_Agreement_Outcome_Activity': {
    id: string
    egcs_fc_activity: string
    egcs_fc_outcomes: string
    _deleted: boolean
  }
  'Transfer_Payment_Outcome': {
    id: string
    egcs_tp_transferpaymentprofile: string
    egcs_tp_name_en: string
    egcs_tp_name_fr: string
    _deleted: boolean
  }
  'Funding_Case_Agreement_Budget_Fiscal_Year': {
    id: string
    egcs_fc_fundingagreement: string
    egcs_fc_fiscalyear: string
    egcs_fc_budgetversion: string
    egcs_fc_originalbudgetfiscalyear: string | null
    _deleted: boolean
  }
  'Funding_Case_Agreement_Budget_Version': {
    id: string
    egcs_fc_fundingagreement: string
    egcs_fc_iscurrent: boolean
    _deleted: boolean
  }
  'Funding_Case_Agreement_Budget_Line_Item': {
    id: string
    egcs_fc_fundingagreementbudgetfiscalyear: string
    egcs_fc_programfunding: number
    _deleted: boolean
  }
  'Transfer_Payment_Stream_Budget': {
    id: string
    egcs_tp_transferpaymentstream: string
    egcs_tp_transferpaymentbudget: string
    _deleted: boolean
  }
  'Transfer_Payment_Stream': {
    id: string
    egcs_tp_transferpaymentprofile: string
    _deleted: boolean
  }
  'Transfer_Payment_Profile': {
    id: string
    egcs_tp_agency: string
    _deleted: boolean
  }
  'Transfer_Payment_Fiscal_Year_Budget': {
    id: string
    egcs_tp_transferpaymentprofile: string
    egcs_tp_fiscalyear: string
    _deleted: boolean
  }
  'Transfer_Payment_Stream_Chart_of_Account': {
    id: string
    egcs_tp_streambudget: string
    egcs_tp_transferpaymentstream: string
    egcs_tp_accountingdimensions: JSONColumnType<Array<{ label_en: string, label_fr: string, value: string }>>
    _deleted: boolean
  }
  'Transfer_Payment_Stream_Commitment_Type': {
    id: string
    egcs_tp_name_en: string
    egcs_tp_name_fr: string
    egcs_tp_transferpaymentstream: string
    _deleted: boolean
  }
  'Agency_Fiscal_Year': {
    id: string
    egcs_ay_fiscalyeardisplay: string
    egcs_ay_fiscalyear: number
    _deleted: boolean
  }
  'Funding_Case_Agreement_Commitment': {
    id: Generated<string>
    egcs_fc_fundingagreement: string
    egcs_fc_type: string
    egcs_fc_status: string
    egcs_fc_financialsystemnumber: string | null
    egcs_fc_active?: boolean
    _deleted?: boolean
  }
  'Funding_Case_Agreement_Commitment_Line': {
    id: Generated<string>
    egcs_fc_commitment: string
    egcs_fc_commitmentlinenumber: number
    egcs_fc_transferpaymentstreamchartofaccount: string
    egcs_fc_amount: string
    _deleted?: boolean
  }
  'Funding_Case_Agreement_Payment': {
    id: Generated<string>
    egcs_fc_fundingagreementcommitment: string
    egcs_fc_fiscalyear: string
    egcs_fc_paymentamount: string
    egcs_fc_status: string
    _deleted?: boolean
  }
  'Funding_Case_Agreement_Payment_Line': {
    id: Generated<string>
    egcs_fc_fundingagreementpayment: string
    egcs_fc_fundingagreementcommitmentline: string
    egcs_fc_amount: string
    _deleted?: boolean
  }
  'extensions.gcs_outcome_cost_allocation_versions': {
    id: Generated<string>
    agreement_id: string
    version_number: number
    status: AllocationVersionStatus
    lifecycle_status_id: Generated<string>
    created_at: Generated<Date | string>
    completed_at: Date | string | null
    funding_basis_amount: string | null
    _deleted?: boolean
  }
  'extensions.gcs_outcome_cost_allocation_allocations': {
    id: Generated<string>
    allocation_version_id: string
    agreement_id: string
    commitment_type: string
    stream_commitment_id: string
    agreement_budget_fiscal_year_id: string
    outcome_id: string
    allocation_method: 'amount' | 'percentage'
    allocation_value: string
    resolved_amount: string | null
    funding_basis_amount: string | null
    outcome_label_en: string | null
    outcome_label_fr: string | null
    commitment_label_en: string | null
    commitment_label_fr: string | null
    fiscal_year_display: string | null
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
    generated_amount: string
    _deleted?: boolean
  }
  'extensions.agency_enablement': {
    agency_id: string
    extension_key: string
    enabled: boolean
    config: unknown
    _deleted: boolean
  }
  'extensions.stream_configuration': {
    stream_id: string
    extension_key: string
    enabled: boolean
    config: unknown
    _deleted: boolean
  }
}

export type OutcomeCostAllocationDb = Kysely<OutcomeCostAllocationHostDatabase>

/**
 * Narrows the host database to the tables used by outcome-cost-allocation services.
 */
export const asOutcomeCostAllocationDb = (db: unknown): OutcomeCostAllocationDb =>
  db as OutcomeCostAllocationDb
