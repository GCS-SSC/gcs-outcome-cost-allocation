import { computed, onScopeDispose, shallowRef } from 'vue'

type RequestState<T> =
  | { kind: 'idle' }
  | { kind: 'pending'; controller: AbortController; data: T | null }
  | { kind: 'success'; data: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'disposed' }

/** Owns one replaceable request; financial drafts and mutation lanes stay with their editor. */
export const useAllocationRequest = <T>() => {
  const state = shallowRef<RequestState<T>>({ kind: 'idle' })
  const data = computed(() => 'data' in state.value ? state.value.data : null)
  const status = computed(() => state.value.kind === 'disposed' ? 'idle' : state.value.kind)
  const error = computed(() => state.value.kind === 'error' ? state.value.error : null)
  const invalidate = () => {
    if (state.value.kind === 'disposed') return
    if (state.value.kind === 'pending') state.value.controller.abort()
    state.value = { kind: 'idle' }
  }
  const run = async (load: (signal: AbortSignal) => Promise<T>): Promise<boolean> => {
    if (state.value.kind === 'disposed') return false
    const retained = data.value
    if (state.value.kind === 'pending') state.value.controller.abort()
    const pending: RequestState<T> & { kind: 'pending' } = { kind: 'pending', controller: new AbortController(), data: retained }
    state.value = pending
    try {
      const result = await load(pending.controller.signal)
      if (state.value !== pending) return false
      state.value = { kind: 'success', data: result }
      return true
    } catch (cause) {
      if (state.value !== pending) return false
      state.value = { kind: 'error', error: cause }
      return false
    }
  }
  onScopeDispose(() => {
    if (state.value.kind === 'pending') state.value.controller.abort()
    state.value = { kind: 'disposed' }
  })
  return { data, status, error, run, invalidate }
}
