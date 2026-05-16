import { batch } from '@preact/signals-core'
import type { CallOp, WorkerMessage } from './protocol'
import { isAsyncFn } from './defineStore'
import type { KeyMeta, StoreRuntime } from './storeRuntime'

export function handleCall(
  port: MessagePort,
  op: CallOp,
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
  op: CallOp,
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
  op: CallOp,
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
