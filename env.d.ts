import '@gcs-ssc/extensions/nuxt'

declare global {
  const $fetch: <T = unknown>(url: string, options?: Record<string, unknown>) => Promise<T>
  const computed: typeof import('vue')['computed']
  const ref: typeof import('vue')['ref']
  const watch: typeof import('vue')['watch']
  const defineProps: typeof import('vue')['defineProps']
  const defineEmits: typeof import('vue')['defineEmits']
  const defineModel: typeof import('vue')['defineModel']
  const useToast: () => {
    add: (message: Record<string, unknown>) => void
  }
}

export {}
