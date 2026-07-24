import { z } from 'zod'
import { defineGcsExtensionRouteHandler } from '@gcs-ssc/extensions/server'
import { asOutcomeCostAllocationDb } from '../db'
import { saveAllocations } from '../allocation-data'

const AllocationSchema = z.object({
  commitmentType: z.enum(['commitment', 'paye', 'paye2', 'pyp']),
  streamCommitmentId: z.string().min(1),
  agreementBudgetFiscalYearId: z.string().min(1),
  outcomeId: z.string().min(1),
  allocationMethod: z.enum(['amount', 'percentage']),
  allocationValue: z.coerce.number().nonnegative()
})

const SaveAllocationsSchema = z.object({
  allocationVersionId: z.string().min(1),
  allocations: z.array(AllocationSchema)
})

export default defineGcsExtensionRouteHandler(async ({ params, db: rawDb, readBody }) => {
  const body = SaveAllocationsSchema.parse(await readBody())
  const agreementId = params.agreementId ?? ''
  const db = asOutcomeCostAllocationDb(rawDb)

  await saveAllocations(db, agreementId, body.allocationVersionId, body.allocations)

  return {
    ok: true
  }
})
