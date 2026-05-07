/* eslint-disable jsdoc/require-jsdoc */
import { defineGcsExtension } from '@gcs-ssc/extensions'

export default defineGcsExtension({
  key: 'gcs-outcome-cost-allocation',
  name: {
    en: 'Outcome cost allocation',
    fr: 'Repartition des couts par resultat'
  },
  description: {
    en: 'Allocates agreement program funding by outcome and generates commitment lines from stream commitment mappings.',
    fr: 'Repartit le financement de programme par resultat et genere les lignes d engagement a partir des correspondances du volet.'
  },
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
          en: 'Outcome cost allocation',
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
    }
  ],
  nitroPlugin: './server/plugins/create-hooks.ts'
})
