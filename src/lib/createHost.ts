import { batch, effect, type Signal } from '@preact/signals-core'
import type { ClientMessage, KeyState, WorkerMessage } from './protocol'
import { ctx, isAsyncFn, isStateSignal, type StoreDefinition } from './defineStore'

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
  subscribers: Set<MessagePort>
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
    subscribers: new Set(),
  }
}

function registerEffect(storeId: string, store: StoreRuntime) {
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
    const patch: WorkerMessage = { type: 'patch', storeId, state: changed }
    for (const port of store.subscribers) port.postMessage(patch)
  })
}

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
  if (isAsyncFn(fn)) handleAsyncCall(port, op, clientId, store, fn)
  else handleSyncCall(port, op, clientId, store, fn)
}

function handleSyncCall(
  port: MessagePort,
  op: { storeId: string; action: string; args: unknown[]; callId: number; seq: number },
  clientId: string,
  store: StoreRuntime,
  fn: (...args: unknown[]) => unknown,
) {
  Promise.resolve()
    .then(() => {
      const before: Record<string, unknown> = {}
      const savedMeta: Record<string, KeyMeta> = {}
      const speculativeMeta: KeyMeta = { originClientId: clientId, originSeq: op.seq }
      for (const k of store.signalKeys) {
        before[k] = store.signals[k]!.peek()
        savedMeta[k] = store.meta[k]!
        store.meta[k] = speculativeMeta
      }
      const restoreUnchanged = () => {
        for (const k of store.signalKeys) {
          if (store.signals[k]!.peek() === before[k]) store.meta[k] = savedMeta[k]!
        }
      }
      try {
        let r: unknown
        batch(() => {
          r = fn(...op.args)
        })
        restoreUnchanged()
        return r
      } catch (err) {
        restoreUnchanged()
        throw err
      }
    })
    .then(
      (value) =>
        port.postMessage({
          type: 'result',
          callId: op.callId,
          ok: true,
          value,
        } satisfies WorkerMessage),
      (err) =>
        port.postMessage({
          type: 'result',
          callId: op.callId,
          ok: false,
          error: String(err),
        } satisfies WorkerMessage),
    )
}

function handleAsyncCall(
  port: MessagePort,
  op: { storeId: string; action: string; args: unknown[]; callId: number; seq: number },
  clientId: string,
  store: StoreRuntime,
  fn: (...args: unknown[]) => unknown,
) {
  const before: Record<string, unknown> = {}
  for (const k of store.signalKeys) before[k] = store.signals[k]!.peek()
  Promise.resolve()
    .then(() => fn(...op.args))
    .then(
      (value) => {
        const seqs: Record<string, number> = {}
        let any = false
        for (const k of store.signalKeys) {
          if (store.signals[k]!.peek() !== before[k]) {
            store.meta[k] = { originClientId: clientId, originSeq: op.seq }
            seqs[k] = op.seq
            any = true
          }
        }
        if (any) {
          port.postMessage({
            type: 'ack',
            storeId: op.storeId,
            seqs,
          } satisfies WorkerMessage)
        }
        port.postMessage({
          type: 'result',
          callId: op.callId,
          ok: true,
          value,
        } satisfies WorkerMessage)
      },
      (err) =>
        port.postMessage({
          type: 'result',
          callId: op.callId,
          ok: false,
          error: String(err),
        } satisfies WorkerMessage),
    )
}
