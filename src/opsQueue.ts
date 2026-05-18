import type { CallOp, ClientMessage, SetOp } from './protocol'

export interface OpsQueue {
  enqueueSet(op: SetOp): void
  enqueueCall(op: CallOp): void
}

export function createOpsQueue(
  send: (msg: ClientMessage) => void,
  clientId: string,
): OpsQueue {
  let setQueue: Map<string, Map<string, SetOp>> = new Map()
  let callQueue: CallOp[] = []
  let scheduled = false

  function flush() {
    scheduled = false
    const sets: SetOp[] = []
    for (const m of setQueue.values()) for (const op of m.values()) sets.push(op)
    const calls = callQueue
    setQueue = new Map()
    callQueue = []
    if (sets.length === 0 && calls.length === 0) return
    send({ type: 'ops', clientId, ops: [...sets, ...calls] })
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(flush)
  }

  return {
    enqueueSet(op) {
      let m = setQueue.get(op.storeId)
      if (!m) {
        m = new Map()
        setQueue.set(op.storeId, m)
      }
      m.set(op.key, op)
      schedule()
    },
    enqueueCall(op) {
      callQueue.push(op)
      schedule()
    },
  }
}
