import { defineGcsExtension, defineGcsAuditOwnership } from '@gcs-ssc/extensions'

export default defineGcsExtension({
  // Host-managed configuration, KV and secrets keep their host ownership rules.
  auditOwnership: defineGcsAuditOwnership([
    {
      table: 'extensions.gcs_outcome_cost_allocation_versions',
      owner: {
        kind: 'owner',
        owner: 'agreement',
        column: 'agreement_id'
      }
    },
    {
      table: 'extensions.gcs_outcome_cost_allocation_allocations',
      owner: {
        kind: 'owner',
        owner: 'agreement',
        column: 'agreement_id'
      }
    },
    {
      table: 'extensions.gcs_outcome_cost_allocation_commitment_lines',
      owner: {
        kind: 'owner',
        owner: 'agreement',
        column: 'agreement_id'
      }
    }
  ]),
  key: 'gcs-outcome-cost-allocation',
  sdkVersion: '^0.3.17',
  configurationAccess: 'manager',
  requiredHostCapabilities: [
    'agreement-payment-capacity',
    'agency-config',
    'agency-workspace',
    'audit-ownership',
    'stream-config-modal',
    'entity-tabs',
    'entity-detail-pages',
    'coding-allocator',
    'configuration-access',
    'extension-kv',
    'server-handlers',
    'server-handler-rbac',
    'migrations',
    'extension-ui',
    'extension-api-client',
    'host-api-client',
    'extension-lifecycle-hooks',
    'lifecycle-entities'
  ],
  name: {
    en: 'Outcome cost allocation',
    fr: 'Répartition des coûts par résultat'
  },
  description: {
    en: 'Allocates agreement program funding by outcome and generates commitment lines from stream chart-of-account mappings.',
    fr: 'Répartit le financement de programme par résultat et génère les lignes d’engagement à partir des correspondances du volet.'
  },
  entities: [{
    type: 'allocation-version',
    label: { en: 'Outcome cost allocation version', fr: 'Version de répartition des coûts par résultat' },
    completion: 'supported',
    approvalSubmission: 'on_completion',
    standardWorkflow: 'explicit',
    supportsDirectReviews: false,
    ownerKind: 'agreement',
    assignmentMode: 'inherited',
    adapter: { path: './server/allocation-version-adapter.ts' }
  }],
  admin: {
    agency: { path: './components/AgencyCodingConfig.vue' },
    agencyWorkspace: {
      label: { en: 'Cost allocation', fr: 'Répartition des coûts' },
      icon: 'i-lucide-chart-no-axes-combined',
      tabs: [
        { id: 'receivables', label: { en: 'Accounts receivable', fr: 'Comptes débiteurs' }, icon: 'i-lucide-receipt' },
        { id: 'credit-memos', label: { en: 'Credit memos', fr: 'Notes de crédit' }, icon: 'i-lucide-file-minus' }
      ]
    },
    streamConfig: {
      path: './components/StreamOutcomeCostAllocationConfig.vue'
    }
  },
  client: {
    tabs: [
      {
        target: 'agreement',
        id: 'outcome-cost-allocation',
        label: {
          en: 'Cost Allocation',
          fr: 'Répartition des coûts'
        },
        icon: 'i-lucide-chart-no-axes-combined',
        path: './components/AgreementOutcomeCostAllocationTab.vue',
        detailPage: { path: './components/OutcomeAllocationDetail.vue' },
        rbac: {
          subject: 'agreement',
          action: 'read'
        }
      }
    ]
  },
  migrations: [
    {
      path: './server/migrations/0001_outcome_cost_allocation.ts'
    },
    {
      path: './server/migrations/0002_versioned_allocations.ts'
    },
    {
      path: './server/migrations/0003_scoped_allocations.ts'
    }
  ],
  serverHandlers: [
    {
      route: '/agreements/[agreementId]/allocations',
      method: 'get',
      path: './server/api/allocations.get.ts',
      rbac: {
        subject: 'agreement',
        action: 'read',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    },
    {
      route: '/agreements/[agreementId]/allocations',
      method: 'put',
      path: './server/api/allocations.put.ts',
      rbac: {
        subject: 'agreement',
        action: 'update',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    },
    {
      route: '/agreements/[agreementId]/allocation-versions',
      method: 'post',
      path: './server/api/allocation-versions.post.ts',
      rbac: {
        subject: 'agreement',
        action: 'update',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    },
    {
      route: '/agreements/[agreementId]/allocation-versions/[allocationVersionId]',
      method: 'delete',
      path: './server/api/allocation-version.delete.ts',
      rbac: {
        subject: 'agreement',
        action: 'delete',
        entity: {
          target: 'agreement',
          param: 'agreementId'
        }
      }
    }
  ],
  codingAllocator: { path: './server/allocator.ts' },
  nitroPlugin: './server/plugins/create-hooks.ts'
})
