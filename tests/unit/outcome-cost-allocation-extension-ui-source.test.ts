import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('outcome cost allocation extension UI', () => {
  it('renders stream configuration and agreement allocation editors as tables', async () => {
    const [streamConfig, agreementTab, manifest] = await Promise.all([
      readFile(join(process.cwd(), 'components/StreamOutcomeCostAllocationConfig.vue'), 'utf8'),
      readFile(join(process.cwd(), 'components/AgreementOutcomeCostAllocationTab.vue'), 'utf8'),
      readFile(join(process.cwd(), 'extension.config.ts'), 'utf8')
    ])

    expect(streamConfig).toContain('<ExtensionTable')
    expect(streamConfig).toContain('mappingColumns')
    expect(streamConfig).not.toContain('getGroupedRowModel')
    expect(streamConfig).toContain('AssociationTableRow')
    expect(streamConfig).toContain('HierarchyTableRow')
    expect(streamConfig).toContain('openCreateAssociation')
    expect(streamConfig).toContain('removeAssociation')
    expect(streamConfig).toContain("expandedRows.value[groupId] === true")
    expect(agreementTab).toContain('<ExtensionTable')
    expect(agreementTab).toContain('allocationColumns')
    expect(agreementTab).toContain('ConfiguredAssociationRow')
    expect(agreementTab).toContain('getAllocationAmount')
    expect(agreementTab).toContain('selectedVersionId')
    expect(agreementTab).toContain('completeSelectedVersion')
    expect(agreementTab).toContain('createDraftVersion')
    expect(agreementTab).toContain('hasDraftVersion')
    expect(agreementTab).toContain('openGenerateRows')
    expect(agreementTab).toContain('applyGeneratedRows')
    expect(agreementTab).toContain('generateRows')
    expect(agreementTab).not.toContain('addRows')
    expect(agreementTab).not.toContain('regenerateRows')
    expect(agreementTab).not.toContain('generationMode')
    expect(agreementTab).toContain('displayedAssociationRows')
    expect(agreementTab).toContain('generationYearIds')
    expect(agreementTab).toContain('useExtensionConfirmDialog')
    expect(agreementTab).toContain('Number(year.program_funding) <= 0')
    expect(agreementTab).toContain('multiple')
    expect(agreementTab).not.toContain('type="multiple"')
    expect(agreementTab).toContain("id: 'amount'")
    expect(agreementTab).toContain("id: 'unallocated'")
    expect(agreementTab).toContain("en: 'Unallocated'")
    expect(agreementTab).toContain('getVersionUnallocated')
    expect(agreementTab).toContain('return getVersionUnallocated(selectedVersionId.value)')
    expect(agreementTab).not.toContain('getCommitmentTypeUnallocated')
    expect(agreementTab).toContain('return getFiscalYearUnallocated(row.yearId)')
    expect(agreementTab).toContain(':max="getAllocationValueMaximum(row.original.association)"')
    expect(agreementTab).toContain('text-error')
    expect(agreementTab).toContain('outcome-cost-allocation-table')
    expect(agreementTab).toContain('table-layout: fixed')
    expect(agreementTab).toContain('overflow-wrap: anywhere')
    expect(agreementTab).toContain('<ExtensionSaveButton')
    expect(manifest).toContain("en: 'Cost Allocation'")
    expect(manifest).toContain("completion: 'supported'")
    expect(manifest).toContain("approvalSubmission: 'on_completion'")
    expect(manifest).toContain("standardWorkflow: 'explicit'")
    expect(manifest).not.toContain('workflowRequired')
  })

  it('does not create draft allocation rows as a render side effect', async () => {
    const agreementTab = await readFile(
      join(process.cwd(), 'components/AgreementOutcomeCostAllocationTab.vue'),
      'utf8'
    )

    expect(agreementTab).toContain('const getAllocation = (association: ConfiguredAssociationRow): VersionedOutcomeAllocationInput | null')
    expect(agreementTab).toContain('const ensureAllocation = (association: ConfiguredAssociationRow)')
    expect(agreementTab).not.toContain('const getAllocation = (association: ConfiguredAssociationRow): OutcomeAllocationInput =>')
    expect(agreementTab).not.toContain(':model-value="getAllocation(row.original.association).allocationMethod"')
    expect(agreementTab).not.toContain(':model-value="getAllocation(row.original.association).allocationValue"')
  })
})
