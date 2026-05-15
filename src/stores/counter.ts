import { defineStore } from '../lib'

export const counterStore = defineStore('counter', ({ signal, computed }) => {
  const count = signal(0)
  const doubled = computed(() => count.value * 2)

  const reset = () => {
    count.value = 0
  }
  const bump = (by: number) => {
    count.value += by
  }

  return { count, doubled, reset, bump }
})
