import type { ReadonlySignal, Signal } from '@preact/signals-core'
import type { CallOp, ClientMessage, KeyState, SetOp, WorkerMessage } from './protocol'
import {
  ctx,
  isAsyncFn,
  isDerivedSignal,
  isStateSignal,
  type StoreDefinition,
} from './defineStore'

const SIGNALS = Symbol.for('ssw.signals')

type ActionResult<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => R extends Promise<unknown> ? R : void
  : never

export type Store<S> = {
  [K in keyof S]: S[K] extends Signal<infer T>
    ? T
    : S[K] extends ReadonlySignal<infer T>
      ? T
      : S[K] extends (...args: any[]) => any
        ? ActionResult<S[K]>
        : S[K]
} & {
  readonly ready: Promise<void>
}

export function $<S extends Record<string, unknown>>(
  store: Store<S>,
): { [K in keyof S]: S[K] extends Signal<infer T> ? Signal<T> : S[K] } {
  return (store as unknown as Record<symbol, unknown>)[SIGNALS] as never
}

interface MirrorRuntime {
  signals: Map<string, Signal>
  rawSignals: Record<string, Signal | ReadonlySignal>
  ready: Promise<void>
  resolveReady: () => void
  latestLocalSeq: Map<string, number>
}

export function createClient(workerUrl: URL | string, name = 'ssw') {
  const worker = new SharedWorker(workerUrl, { type: 'module', name })
  const port = worker.port
  const clientId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  let nextSeq = 0
  let nextCallId = 1
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()
  const mirrors = new Map<string, MirrorRuntime>()

  let setQueue: Map<string, Map<string, SetOp>> = new Map()
  let callQueue: CallOp[] = []
  let flushScheduled = false

  function schedule() {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(flush)
  }

  function enqueueSet(op: SetOp) {
    let m = setQueue.get(op.storeId)
    if (!m) {
      m = new Map()
      setQueue.set(op.storeId, m)
    }
    m.set(op.key, op)
    schedule()
  }

  function enqueueCall(op: CallOp) {
    callQueue.push(op)
    schedule()
  }

  function flush() {
    flushScheduled = false
    const sets: SetOp[] = []
    for (const m of setQueue.values()) for (const op of m.values()) sets.push(op)
    const calls = callQueue
    setQueue = new Map()
    callQueue = []
    if (sets.length === 0 && calls.length === 0) return
    port.postMessage({
      type: 'ops',
      clientId,
      ops: [...sets, ...calls],
    } satisfies ClientMessage)
  }

  function applyKeyState(mirror: MirrorRuntime, key: string, state: KeyState) {
    const sig = mirror.signals.get(key)
    if (!sig) return
    if (state.originClientId === clientId && state.originSeq != null) {
      const localMax = mirror.latestLocalSeq.get(key) ?? 0
      if (state.originSeq < localMax) return
    }
    if (sig.peek() !== state.value) sig.value = state.value
  }

  port.addEventListener('message', (ev) => {
    const msg = ev.data as WorkerMessage
    if (msg.type === 'snapshot' || msg.type === 'patch') {
      const m = mirrors.get(msg.storeId)
      if (!m) return
      for (const [k, ks] of Object.entries(msg.state)) applyKeyState(m, k, ks)
      if (msg.type === 'snapshot') m.resolveReady()
    } else if (msg.type === 'result') {
      const p = pending.get(msg.callId)
      if (!p) return
      pending.delete(msg.callId)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error))
    } else if (msg.type === 'error') {
      console.error('[ssw]', msg.message)
    }
  })
  port.start()

  function useStore<S extends Record<string, unknown>>(def: StoreDefinition<S>): Store<S> {
    if (mirrors.has(def.id)) {
      throw new Error(`[ssw] store "${def.id}" already created on this client`)
    }

    let resolveReady!: () => void
    const ready = new Promise<void>((r) => (resolveReady = r))
    const mirror: MirrorRuntime = {
      signals: new Map(),
      rawSignals: Object.create(null),
      ready,
      resolveReady,
      latestLocalSeq: new Map(),
    }
    mirrors.set(def.id, mirror)

    const store: Record<string, unknown> = Object.create(null)
    Object.defineProperty(store, 'ready', { value: ready, enumerable: true })
    Object.defineProperty(store, SIGNALS, { value: mirror.rawSignals })

    const shape = def.setup(ctx)
    for (const [key, val] of Object.entries(shape)) {
      if (isStateSignal(val)) {
        const sig = val as Signal
        mirror.signals.set(key, sig)
        mirror.rawSignals[key] = sig
        Object.defineProperty(store, key, {
          enumerable: true,
          get: () => sig.value,
          set: (v) => {
            const seq = ++nextSeq
            mirror.latestLocalSeq.set(key, seq)
            sig.value = v
            enqueueSet({ kind: 'set', storeId: def.id, key, value: v, seq })
          },
        })
      } else if (isDerivedSignal(val)) {
        const der = val as ReadonlySignal
        mirror.rawSignals[key] = der
        Object.defineProperty(store, key, {
          enumerable: true,
          get: () => der.value,
        })
      } else if (typeof val === 'function') {
        const fn = isAsyncFn(val)
          ? makeAsyncCall(def.id, key)
          : makeOptimisticCall(def.id, key, val as (...a: unknown[]) => unknown, mirror)
        Object.defineProperty(store, key, { value: fn, enumerable: true })
      }
    }

    port.postMessage({ type: 'subscribe', storeId: def.id, clientId } satisfies ClientMessage)
    return store as Store<S>
  }

  function makeOptimisticCall(
    storeId: string,
    actionName: string,
    body: (...args: unknown[]) => unknown,
    mirror: MirrorRuntime,
  ) {
    return (...args: unknown[]) => {
      const before = new Map<string, unknown>()
      for (const [k, sig] of mirror.signals) before.set(k, sig.peek())
      try {
        body(...args)
      } catch (err) {
        console.error('[ssw] optimistic action threw:', err)
      }
      const seq = ++nextSeq
      for (const [k, sig] of mirror.signals) {
        if (sig.peek() !== before.get(k)) mirror.latestLocalSeq.set(k, seq)
      }
      const callId = nextCallId++
      enqueueCall({ kind: 'call', storeId, action: actionName, args, callId, seq })
    }
  }

  function makeAsyncCall(storeId: string, actionName: string) {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const callId = nextCallId++
        const seq = ++nextSeq
        pending.set(callId, { resolve, reject })
        enqueueCall({ kind: 'call', storeId, action: actionName, args, callId, seq })
      })
  }

  return { useStore }
}
