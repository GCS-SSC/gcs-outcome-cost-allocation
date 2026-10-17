import { ref } from 'vue'
const state = new Map<string, ReturnType<typeof ref>>()
export const useState = (key: string, init: () => unknown) => {
  if (!state.has(key)) state.set(key, ref(init()))
  return state.get(key)
}
export const useAppConfig = () => ({ ui: { icons: { close: 'close' } } })
export default { ui: {} }
