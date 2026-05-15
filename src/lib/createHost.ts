import { batch, effect, type Signal } from '@preact/signals-core'
import type { ClientMessage, KeyState, WorkerMessage } from './protocol'
import { ctx, isStateSignal, type StoreDefinition } from './defineStore'

interface KeyMeta {
  originClientId?: string
  originSeq?: number
}

interface StoreRuntime {
  signals: Record<string, Signal>
  signalKeys: string[]
  actions: Record<string, (...args: unknown[]) => unknown>
  actionNames: string[]
  meta: Record<string, KeyMeta>
}

function instantiate(def: StoreDefinition<Record<string, unknown>>): StoreRuntime {
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
  }
}

let activeSet: {
  clientId: string
  storeKeys: Map<string, Set<string>>
} | null = null

declare const self: SharedWorkerGlobalScope

/**
 * Call once from the SharedWorker entry. Instantiates each store
 * definition (so `setup` runs in the worker context) and wires
 * `SharedWorkerGlobalScope.connect` to accept incoming tabs.
 */
export function createHost(defs: StoreDefinition<Record<string, unknown>>[]) {
  const onConnect = bindHost(defs)
  self.addEventListener('connect', (event) => {
    const port = (event as MessageEvent).ports[0]
    if (port) onConnect(port)
  })
}

/**
 * Lower-level entry: returns the per-port handler that `createHost` would
 * have attached to the `connect` event. Call the returned function with
 * any `MessagePort` to register a client. Useful for tests that pair the
 * host and client via `new MessageChannel()`.
 */
export function bindHost(defs: StoreDefinition<Record<string, unknown>>[]) {
  const stores = new Map<string, StoreRuntime>()
  for (const def of defs) stores.set(def.id, instantiate(def))

  return function onConnect(port: MessagePort) {
    let portClientId: string | null = null

    port.addEventListener('message', (ev) => {
      const msg = ev.data as ClientMessage

      if (msg.type === 'subscribe') {
        portClientId = msg.clientId
        const store = stores.get(msg.storeId)
        if (!store) {
          port.postMessage({
            type: 'error',
            storeId: msg.storeId,
            message: `unknown store: ${msg.storeId}`,
          } satisfies WorkerMessage)
          return
        }
        subscribePort(port, msg.storeId, store, () => portClientId)
        return
      }

      if (msg.type === 'ops') {
        const setKeysByStore = new Map<string, Set<string>>()
        for (const op of msg.ops) {
          if (op.kind === 'set') {
            let s = setKeysByStore.get(op.storeId)
            if (!s) {
              s = new Set()
              setKeysByStore.set(op.storeId, s)
            }
            s.add(op.key)
          }
        }

        activeSet = { clientId: msg.clientId, storeKeys: setKeysByStore }
        try {
          batch(() => {
            for (const op of msg.ops) {
              if (op.kind !== 'set') continue
              const store = stores.get(op.storeId)
              if (!store) continue
              const sig = store.signals[op.key]
              if (!sig) continue
              store.meta[op.key] = { originClientId: msg.clientId, originSeq: op.seq }
              sig.value = op.value
            }
          })
        } finally {
          activeSet = null
        }

        for (const op of msg.ops) {
          if (op.kind === 'call') handleCall(port, op, msg.clientId, stores)
        }
      }
    })
    port.start()
  }
}

function subscribePort(
  port: MessagePort,
  storeId: string,
  store: StoreRuntime,
  getClientId: () => string | null,
) {
  const lastSent: Record<string, unknown> = {}
  let first = true

  effect(() => {
    if (first) {
      const state: Record<string, KeyState> = {}
      for (const k of store.signalKeys) {
        const v = store.signals[k]!.value
        state[k] = { value: v, ...store.meta[k]! }
        lastSent[k] = v
      }
      port.postMessage({
        type: 'snapshot',
        storeId,
        state,
        actions: store.actionNames,
      } satisfies WorkerMessage)
      first = false
      return
    }

    const portClientId = getClientId()
    const forceKeys =
      activeSet && portClientId === activeSet.clientId
        ? activeSet.storeKeys.get(storeId)
        : undefined

    const changed: Record<string, KeyState> = {}
    let any = false
    for (const k of store.signalKeys) {
      const v = store.signals[k]!.value
      const forced = forceKeys?.has(k) ?? false
      if (v === lastSent[k] && !forced) continue
      changed[k] = { value: v, ...store.meta[k]! }
      lastSent[k] = v
      any = true
    }
    if (any) {
      port.postMessage({ type: 'patch', storeId, state: changed } satisfies WorkerMessage)
    }
  })
}

function handleCall(
  port: MessagePort,
  op: { storeId: string; action: string; args: unknown[]; callId: number; seq: number },
  clientId: string,
  stores: Map<string, StoreRuntime>,
) {
  const store = stores.get(op.storeId)
  if (!store) {
    port.postMessage({
      type: 'result',
      callId: op.callId,
      ok: false,
      error: `unknown store: ${op.storeId}`,
    } satisfies WorkerMessage)
    return
  }
  const fn = store.actions[op.action]
  if (!fn) {
    port.postMessage({
      type: 'result',
      callId: op.callId,
      ok: false,
      error: `unknown action: ${op.action}`,
    } satisfies WorkerMessage)
    return
  }
  const before: Record<string, unknown> = {}
  for (const k of store.signalKeys) before[k] = store.signals[k]!.peek()
  Promise.resolve()
    .then(() => fn(...op.args))
    .then(
      (value) => {
        for (const k of store.signalKeys) {
          if (store.signals[k]!.peek() !== before[k]) {
            store.meta[k] = { originClientId: clientId, originSeq: op.seq }
          }
        }
        port.postMessage({
          type: 'result',
          callId: op.callId,
          ok: true,
          value,
        } satisfies WorkerMessage)
      },
      (err) => {
        port.postMessage({
          type: 'result',
          callId: op.callId,
          ok: false,
          error: String(err),
        } satisfies WorkerMessage)
      },
    )
}
