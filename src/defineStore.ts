import { signal, computed, type Signal, type ReadonlySignal } from '@preact/signals-core'

export const STATE_BRAND = Symbol.for('ssw.state')

const AsyncFunction = (async () => {}).constructor as Function

export interface StoreContext {
  signal: <T>(initial: T) => Signal<T>
  computed: <T>(fn: () => T) => ReadonlySignal<T>
}

export const ctx: StoreContext = {
  signal: <T>(initial: T) => {
    const s = signal(initial)
    ;(s as unknown as Record<symbol, true>)[STATE_BRAND] = true
    return s
  },
  computed: (fn) => computed(fn),
}

export function isStateSignal(v: unknown): v is Signal {
  return !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[STATE_BRAND] === true
}

export function isAsyncFn(v: unknown): boolean {
  return typeof v === 'function' && (v as { constructor: unknown }).constructor === AsyncFunction
}

export function isDerivedSignal(v: unknown): v is ReadonlySignal {
  return (
    !!v &&
    typeof v === 'object' &&
    'value' in v &&
    typeof (v as { peek?: unknown }).peek === 'function' &&
    !isStateSignal(v)
  )
}

export interface StoreDefinition<S extends Record<string, unknown>> {
  id: string
  setup: (ctx: StoreContext) => S
}

/** Declare a store. `setup` runs in both contexts — keep it deterministic. */
export function defineStore<S extends Record<string, unknown>>(
  id: string,
  setup: (ctx: StoreContext) => S,
): StoreDefinition<S> {
  return { id, setup }
}
