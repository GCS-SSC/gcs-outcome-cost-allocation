import { COMMITMENT_TYPES, type CommitmentType } from './allocation'

export interface StreamOutcomeAssociationTableRow {
  id: string
  commitmentType: CommitmentType
  commitmentTypeGroup: string
  fiscalYearGroup: string
  streamBudgetId: string
  streamCommitmentId: string
  outcomeId: string
  lineLabel: string
  outcomeLabel: string
}

export interface StreamOutcomeHierarchyTableRow {
  id: string
  rowType: 'commitmentType' | 'fiscalYear' | 'association'
  commitmentType?: CommitmentType
  commitmentTypeGroup: string
  fiscalYearGroup: string
  streamBudgetId: string
  lineLabel: string
  outcomeLabel: string
  associationCount: number
  association?: StreamOutcomeAssociationTableRow
}

const getCommitmentTypeGroupId = (commitmentType: CommitmentType) => `type:${commitmentType}`
const getFiscalYearGroupId = (commitmentType: CommitmentType, fiscalYearGroup: string) => `year:${commitmentType}:${fiscalYearGroup}`

/**
 * Builds hierarchy table rows for stream outcome cost allocation mappings.
 *
 * @param associations - Flat association rows.
 * @param options - Expansion predicate and localized records label.
 * @param options.isExpanded - Returns whether a group row is expanded.
 * @param options.recordsLabel - Localized records label.
 * @returns Hierarchy rows for the config table.
 */
export const buildStreamOutcomeAllocationTableRows = (
  associations: StreamOutcomeAssociationTableRow[],
  options: {
    isExpanded: (groupId: string) => boolean
    recordsLabel: string
  }
): StreamOutcomeHierarchyTableRow[] => {
  const rows: StreamOutcomeHierarchyTableRow[] = []

  for (const commitmentType of COMMITMENT_TYPES) {
    const typeRows = associations.filter(row => row.commitmentType === commitmentType)
    if (typeRows.length === 0) {
      continue
    }

    const commitmentTypeGroup = typeRows[0]?.commitmentTypeGroup ?? commitmentType
    const typeGroupId = getCommitmentTypeGroupId(commitmentType)
    rows.push({
      id: typeGroupId,
      rowType: 'commitmentType',
      commitmentType,
      commitmentTypeGroup,
      fiscalYearGroup: '',
      streamBudgetId: '',
      lineLabel: commitmentTypeGroup,
      outcomeLabel: `${typeRows.length} ${options.recordsLabel}`,
      associationCount: typeRows.length
    })

    if (!options.isExpanded(typeGroupId)) {
      continue
    }

    const fiscalYears = Array.from(new Set(typeRows.map(row => row.fiscalYearGroup))).sort()
    for (const fiscalYearGroup of fiscalYears) {
      const yearRows = typeRows.filter(row => row.fiscalYearGroup === fiscalYearGroup)
      const yearGroupId = getFiscalYearGroupId(commitmentType, fiscalYearGroup)
      rows.push({
        id: yearGroupId,
        rowType: 'fiscalYear',
        commitmentType,
        commitmentTypeGroup,
        fiscalYearGroup,
        streamBudgetId: '',
        lineLabel: fiscalYearGroup,
        outcomeLabel: `${yearRows.length} ${options.recordsLabel}`,
        associationCount: yearRows.length
      })

      if (!options.isExpanded(yearGroupId)) {
        continue
      }

      rows.push(...yearRows.map(row => ({
        id: row.id,
        rowType: 'association' as const,
        commitmentType,
        commitmentTypeGroup,
        fiscalYearGroup,
        streamBudgetId: row.streamBudgetId,
        lineLabel: row.lineLabel,
        outcomeLabel: row.outcomeLabel,
        associationCount: 1,
        association: row
      })))
    }
  }

  return rows
}
