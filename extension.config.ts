import { defineGcsExtension } from '@gcs-ssc/extensions'

export default defineGcsExtension({
  key: 'gcs-outcome-cost-allocation',
  sdkVersion: '^0.2.0',
  requiredHostCapabilities: [
    'stream-config-modal',
    'entity-tabs',
    'create-actions',
    'server-handlers',
    'server-handler-rbac',
    'migrations',
    'extension-ui',
    'extension-api-client',
    'host-api-client',
    'extension-create-operation-hooks',
    'extension-lifecycle-hooks',
    'lifecycle-entities'
  ],
  name: {
    en: 'Outcome cost allocation',
    fr: 'Repartition des couts par resultat'
  },
  description: {
    en: 'Allocates agreement program funding by outcome and generates commitment lines from stream chart-of-account mappings.',
    fr: 'Repartit le financement de programme par resultat et genere les lignes d engagement a partir des correspondances du volet.'
  },
  entities: [{
    type: 'allocation-version',
    label: { en: 'Outcome cost allocation version', fr: 'Version de repartition des couts par resultat' },
    completion: 'supported',
    approvalSubmission: 'on_completion',
    standardWorkflow: 'explicit',
    supportsDirectReviews: false,
    ownerKind: 'agreement',
    assignmentMode: 'inherited',
    adapter: { path: './server/allocation-version-adapter.ts' }
  }],
  admin: {
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
          fr: 'Repartition des couts'
        },
        icon: 'i-lucide-chart-no-axes-combined',
        path: './components/AgreementOutcomeCostAllocationTab.vue',
        rbac: {
          subject: 'agreement',
          action: 'update'
        }
      }
    ],
    createActions: [
      {
        operation: 'agreement.commitments.create',
        id: 'create-outcome-commitment',
        mode: 'replace',
        label: {
          en: 'Add commitment',
          fr: 'Ajouter un engagement'
        },
        icon: 'i-lucide-plus',
        path: './components/CreateOutcomeCommitmentAction.vue',
        rbac: {
          subject: 'agreement',
          action: 'update'
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
    },
    {
      path: './server/migrations/0004_showcase_seed.ts'
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
  nitroPlugin: './server/plugins/create-hooks.ts'
})
