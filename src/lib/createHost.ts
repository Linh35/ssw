import { batch } from '@preact/signals-core'
import type { ClientMessage, KeyState, WorkerMessage } from './protocol'
import type { StoreDefinition } from './defineStore'
import { instantiate, registerEffect, type StoreRuntime } from './storeRuntime'
import { handleCall } from './actionHandlers'

declare const self: SharedWorkerGlobalScope

/** Call from the SharedWorker entry. Registers stores and accepts incoming tabs. */
export function createHost(defs: StoreDefinition<Record<string, unknown>>[]) {
  const onConnect = bindHost(defs)
  self.addEventListener('connect', (event) => {
    const port = (event as MessageEvent).ports[0]
    if (port) onConnect(port)
  })
}

/** Port-level entry — returns onConnect(port) for direct MessagePort wiring. */
export function bindHost(defs: StoreDefinition<Record<string, unknown>>[]) {
  const stores = new Map<string, StoreRuntime>()
  for (const def of defs) {
    const runtime = instantiate(def)
    stores.set(def.id, runtime)
    registerEffect(def.id, runtime)
  }

  return function onConnect(port: MessagePort) {
    port.addEventListener('message', (ev) => {
      const msg = ev.data as ClientMessage

      if (msg.type === 'subscribe') {
        const store = stores.get(msg.storeId)
        if (!store) {
          port.postMessage({
            type: 'error',
            storeId: msg.storeId,
            message: `unknown store: ${msg.storeId}`,
          } satisfies WorkerMessage)
          return
        }
        const state: Record<string, KeyState> = {}
        for (const k of store.signalKeys) {
          state[k] = { value: store.signals[k]!.peek(), ...store.meta[k]! }
        }
        port.postMessage({
          type: 'snapshot',
          storeId: msg.storeId,
          state,
          actions: store.actionNames,
        } satisfies WorkerMessage)
        store.subscribers.add(port)
        return
      }

      if (msg.type === 'ops') {
        const idempotentAcks: Record<string, Record<string, number>> = {}
        batch(() => {
          for (const op of msg.ops) {
            if (op.kind !== 'set') continue
            const store = stores.get(op.storeId)
            if (!store) continue
            const sig = store.signals[op.key]
            if (!sig) continue
            const willChange = sig.peek() !== op.value
            store.meta[op.key] = { originClientId: msg.clientId, originSeq: op.seq }
            sig.value = op.value
            if (!willChange) {
              let s = idempotentAcks[op.storeId]
              if (!s) {
                s = {}
                idempotentAcks[op.storeId] = s
              }
              s[op.key] = op.seq
            }
          }
        })
        for (const [storeId, seqs] of Object.entries(idempotentAcks)) {
          port.postMessage({ type: 'ack', storeId, seqs } satisfies WorkerMessage)
        }

        for (const op of msg.ops) {
          if (op.kind === 'call') handleCall(port, op, msg.clientId, stores)
        }
      }
    })
    port.start()
  }
}
