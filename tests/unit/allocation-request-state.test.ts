import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import { useAllocationRequest } from '../../composables/useAllocationRequest'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

describe('allocation request ownership', () => {
  it('retains accepted data and rejects replacement results and failures', async () => {
    const scope = effectScope()
    const request = scope.run(() => useAllocationRequest<string>())!
    await request.run(async () => 'accepted')
    const old = deferred<string>()
    const current = deferred<string>()
    let oldSignal: AbortSignal | undefined
    const oldWork = request.run(signal => { oldSignal = signal; return old.promise })
    expect(request.data.value).toBe('accepted')
    const currentWork = request.run(() => current.promise)
    expect(oldSignal?.aborted).toBe(true)
    old.reject(new Error('stale'))
    expect(await oldWork).toBe(false)
    expect(request.status.value).toBe('pending')
    current.resolve('replacement')
    expect(await currentWork).toBe(true)
    expect(request.data.value).toBe('replacement')
    await request.run(async () => { throw new Error('current') })
    expect(request.status.value).toBe('error')
    expect(request.data.value).toBe(null)
    await request.run(async () => 'recovered')
    expect(request.data.value).toBe('recovered')
    scope.stop()
  })

  it('aborts in-flight reads when its scope stops', async () => {
    const scope = effectScope()
    const request = scope.run(() => useAllocationRequest<string>())!
    const pending = deferred<string>()
    let signal: AbortSignal | undefined
    const work = request.run(value => { signal = value; return pending.promise })
    scope.stop()
    expect(signal?.aborted).toBe(true)
    request.invalidate()
    pending.reject(new Error('late failure'))
    expect(await work).toBe(false)
    expect(request.status.value).toBe('idle')
    expect(request.error.value).toBe(null)
  })

  it('clears identity synchronously and prevents settlement or requests after disposal', async () => {
    const scope = effectScope()
    const request = scope.run(() => useAllocationRequest<string>())!
    await request.run(async () => 'first subject')
    const pending = deferred<string>()
    let signal: AbortSignal | undefined
    const work = request.run(value => { signal = value; return pending.promise })
    request.invalidate()
    expect(signal?.aborted).toBe(true)
    expect(request.data.value).toBe(null)
    expect(request.status.value).toBe('idle')
    scope.stop()
    pending.resolve('stale')
    expect(await work).toBe(false)
    let called = false
    expect(await request.run(async () => { called = true; return 'late' })).toBe(false)
    expect(called).toBe(false)
  })
})
