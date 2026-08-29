import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedExtensionE2eDependencies } from '../../../../scripts/extension-managed-e2e'
import {
  outcomeAllocationManagedE2eConfig,
  runManagedOutcomeAllocationE2e
} from '../../scripts/test-e2e-managed'

const ownedSpec = 'tests/e2e/allocation-lifecycle.spec.ts'

const controlledChild = (exitCode?: number) => {
  let finish: ((code: number) => void) | undefined
  const exited = exitCode === undefined
    ? new Promise<number>(resolve => { finish = resolve })
    : Promise.resolve(exitCode)
  return {
    child: {
      exited,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        finish?.(143)
        return true
      })
    }
  }
}

const fixture = (playwrightExitCode: number | null = 0, serverExitCode: number | null = null) => {
  const server = controlledChild(serverExitCode ?? undefined)
  const playwright = controlledChild(playwrightExitCode ?? undefined)
  const signalSource = new EventEmitter()
  const cleanup = vi.fn(async () => {})
  const exit = vi.fn()
  const spawn = vi.fn((command: string[]) => command[0] === 'node' ? server.child : playwright.child)
  const dependencies: ManagedExtensionE2eDependencies = {
    allocatePort: vi.fn(async () => 43125),
    createDataPaths: vi.fn(async () => ({
      cleanup,
      localFileStorageDir: '/tmp/outcome-allocation-files-owned',
      ownsLocalFileStorageDir: true,
      ownsPgliteDataDir: true,
      pgliteDataDir: '/tmp/outcome-allocation-pglite-owned'
    })),
    exit,
    prepareHost: vi.fn(async () => {}),
    signalSource,
    spawn,
    waitForHost: vi.fn(async () => {})
  }
  return { cleanup, dependencies, exit, playwright, server, signalSource, spawn }
}

describe('Outcome Allocation managed E2E runner', () => {
  it('has an exact one-spec inventory and runs it with disposable database and storage', async () => {
    expect(outcomeAllocationManagedE2eConfig.acceptedSpec).toBe(ownedSpec)
    const state = fixture()
    await runManagedOutcomeAllocationE2e([ownedSpec], { DATABASE_URL: 'postgres://must-not-leak' }, state.dependencies)

    const environment = vi.mocked(state.dependencies.prepareHost).mock.calls[0]![0]
    expect(environment).toMatchObject({
      GCS_E2E_EXTENSION_WORKSPACE: 'gcs-outcome-cost-allocation',
      GCS_LOCAL_FILE_STORAGE_DIR: '/tmp/outcome-allocation-files-owned',
      PGLITE_DATA_DIR: '/tmp/outcome-allocation-pglite-owned'
    })
    expect(environment.DATABASE_URL).toBeUndefined()
    expect(state.spawn.mock.calls[1]![0]).toEqual([
      'bun', 'x', 'playwright', 'test', '--config', 'playwright.config.ts', ownedSpec
    ])
    expect(state.cleanup).toHaveBeenCalledOnce()
  })

  it('rejects arbitrary specs before allocating resources', async () => {
    const state = fixture()
    await expect(runManagedOutcomeAllocationE2e(['../foreign.spec.ts'], {}, state.dependencies))
      .rejects.toThrow(`accepts only the exact owned spec: ${ownedSpec}`)
    expect(state.dependencies.createDataPaths).not.toHaveBeenCalled()
  })

  it('cleans all owned state when the managed host exits', async () => {
    const state = fixture(null, 7)
    await expect(runManagedOutcomeAllocationE2e([ownedSpec], {}, state.dependencies))
      .rejects.toThrow('Managed gcs-outcome-cost-allocation host exited during Playwright with code 7')
    expect(state.playwright.child.kill).toHaveBeenCalledOnce()
    expect(state.cleanup).toHaveBeenCalledOnce()
  })

  it('cleans children and owned state on SIGINT', async () => {
    const state = fixture(null)
    const running = runManagedOutcomeAllocationE2e([ownedSpec], {}, state.dependencies)
    const rejected = expect(running).rejects.toThrow('Playwright exited with code 143')
    await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(2))
    state.signalSource.emit('SIGINT')
    await vi.waitFor(() => expect(state.exit).toHaveBeenCalledWith(130))
    await rejected
    expect(state.cleanup).toHaveBeenCalledOnce()
  })
})
