import extension from '../../extension.config'
// Integration adapter from the host tooling checkout; production code uses only the SDK.
const { verifyExtensionAuditContract } = await import(new URL(
  '../../../../tooling/gcs-ssc/tests/fixtures/extension-audit-contract.ts', import.meta.url
).href)

verifyExtensionAuditContract(extension, [
  {
    'table': 'extensions.gcs_outcome_cost_allocation_versions',
    'row': {
      'id': '1',
      'agreement_id': '301',
      'allocation_version_id': '1'
    },
    'agencies': [
      '11'
    ]
  },
  {
    'table': 'extensions.gcs_outcome_cost_allocation_allocations',
    'row': {
      'id': '2',
      'agreement_id': '301',
      'allocation_version_id': '1'
    },
    'agencies': [
      '11'
    ]
  },
  {
    'table': 'extensions.gcs_outcome_cost_allocation_commitment_lines',
    'row': {
      'id': '3',
      'agreement_id': '301',
      'allocation_version_id': '1'
    },
    'agencies': [
      '11'
    ]
  },
  {
    'table': 'extensions.agency_enablement',
    'row': {
      'id': '90',
      'agency_id': '11',
      'extension_key': 'gcs-outcome-cost-allocation'
    },
    'agencies': [
      '11'
    ]
  },
  {
    'table': 'extensions.stream_configuration',
    'row': {
      'id': '91',
      'stream_id': '201',
      'extension_key': 'gcs-outcome-cost-allocation'
    },
    'agencies': [
      '11'
    ]
  }
])
