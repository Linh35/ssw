import { effect, type Signal } from '@preact/signals-core'
import type { KeyState, WorkerMessage } from './protocol'
import { ctx, isStateSignal, type StoreDefinition } from './defineStore'

export interface KeyMeta {
  originClientId?: string
  originSeq?: number
}

export interface StoreRuntime {
  signals: Record<string, Signal>
  signalKeys: string[]
  actions: Record<string, (...args: unknown[]) => unknown>
  actionNames: string[]
  meta: Record<string, KeyMeta>
  subscribers: Set<MessagePort>
}

export function instantiate(def: StoreDefinition<Record<string, unknown>>): StoreRuntime {
  const result = def.setup(ctx)
  const signals: Record<string, Signal> = {}
  const actions: Record<string, (...args: unknown[]) => unknown> = {}
  const meta: Record<string, KeyMeta> = {}
  for (const [key, val] of Object.entries(result)) {
    if (isStateSignal(val)) {
      signals[key] = val
      meta[key] = {}
    } else if (typeof val === 'function') {
      actions[key] = val as (...args: unknown[]) => unknown
    }
  }
  return {
    signals,
    signalKeys: Object.keys(signals),
    actions,
    actionNames: Object.keys(actions),
    meta,
    subscribers: new Set(),
  }
}

export function registerEffect(storeId: string, store: StoreRuntime) {
  const lastValues: Record<string, unknown> = {}
  let first = true
  effect(() => {
    if (first) {
      for (const k of store.signalKeys) lastValues[k] = store.signals[k]!.value
      first = false
      return
    }
    const changed: Record<string, KeyState> = {}
    let any = false
    for (const k of store.signalKeys) {
      const v = store.signals[k]!.value
      if (v === lastValues[k]) continue
      changed[k] = { value: v, ...store.meta[k]! }
      lastValues[k] = v
      any = true
    }
    if (!any) return
    if (store.subscribers.size === 0) return
    const patch: WorkerMessage = { type: 'patch', storeId, state: changed }
    for (const port of store.subscribers) port.postMessage(patch)
  })
}
