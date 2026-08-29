import { fileURLToPath } from 'node:url'
import {
  runManagedExtensionE2e,
  type ManagedExtensionE2eConfig,
  type ManagedExtensionE2eDependencies
} from '../../../scripts/extension-managed-e2e'

export const outcomeAllocationManagedE2eConfig: ManagedExtensionE2eConfig = {
  acceptedSpec: 'tests/e2e/allocation-lifecycle.spec.ts',
  extensionKey: 'gcs-outcome-cost-allocation',
  extensionRoot: fileURLToPath(new URL('../', import.meta.url)),
  suite: 'extension-outcome-cost-allocation'
}

export const runManagedOutcomeAllocationE2e = async (
  rawArguments: string[],
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  dependencies?: ManagedExtensionE2eDependencies
): Promise<void> => await runManagedExtensionE2e(
  outcomeAllocationManagedE2eConfig,
  rawArguments,
  inheritedEnvironment,
  dependencies
)

const main = async (): Promise<void> => {
  await runManagedOutcomeAllocationE2e(process.argv.slice(2))
}

if (import.meta.main) await main()
