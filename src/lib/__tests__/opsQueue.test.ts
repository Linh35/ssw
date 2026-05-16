import { describe, it, expect } from 'vitest'
import { createOpsQueue } from '../opsQueue'
import type { ClientMessage } from '../protocol'

const tick = () => new Promise<void>((r) => queueMicrotask(r))

function makeSink() {
  const sent: ClientMessage[] = []
  return { sent, send: (m: ClientMessage) => sent.push(m) }
}

describe('opsQueue', () => {
  it('flushes nothing when the queue stays empty', async () => {
    const sink = makeSink()
    createOpsQueue(sink.send, 'c1')
    await tick()
    expect(sink.sent).toHaveLength(0)
  })

  it('batches synchronous enqueues into one ops message', async () => {
    const sink = makeSink()
    const q = createOpsQueue(sink.send, 'c1')
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'a', value: 1, seq: 1 })
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'b', value: 2, seq: 2 })
    q.enqueueCall({ kind: 'call', storeId: 's', action: 'go', args: [], callId: 1, seq: 3 })
    expect(sink.sent).toHaveLength(0)
    await tick()
    expect(sink.sent).toHaveLength(1)
    const msg = sink.sent[0]!
    expect(msg.type).toBe('ops')
    if (msg.type !== 'ops') throw new Error('unreachable')
    expect(msg.clientId).toBe('c1')
    expect(msg.ops).toHaveLength(3)
    expect(msg.ops[0]!.kind).toBe('set')
    expect(msg.ops[2]!.kind).toBe('call')
  })

  it('coalesces successive sets to the same key, keeping the last', async () => {
    const sink = makeSink()
    const q = createOpsQueue(sink.send, 'c1')
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'x', value: 1, seq: 1 })
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'x', value: 2, seq: 2 })
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'x', value: 3, seq: 3 })
    await tick()
    expect(sink.sent).toHaveLength(1)
    const msg = sink.sent[0]!
    if (msg.type !== 'ops') throw new Error('unreachable')
    expect(msg.ops).toHaveLength(1)
    expect(msg.ops[0]).toEqual({ kind: 'set', storeId: 's', key: 'x', value: 3, seq: 3 })
  })

  it('keeps sets across different keys distinct', async () => {
    const sink = makeSink()
    const q = createOpsQueue(sink.send, 'c1')
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'a', value: 1, seq: 1 })
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'b', value: 2, seq: 2 })
    await tick()
    const msg = sink.sent[0]!
    if (msg.type !== 'ops') throw new Error('unreachable')
    expect(msg.ops).toHaveLength(2)
  })

  it('keeps every call op (no coalescing)', async () => {
    const sink = makeSink()
    const q = createOpsQueue(sink.send, 'c1')
    q.enqueueCall({ kind: 'call', storeId: 's', action: 'a', args: [], callId: 1, seq: 1 })
    q.enqueueCall({ kind: 'call', storeId: 's', action: 'a', args: [], callId: 2, seq: 2 })
    await tick()
    const msg = sink.sent[0]!
    if (msg.type !== 'ops') throw new Error('unreachable')
    expect(msg.ops).toHaveLength(2)
  })

  it('emits sets before calls in the flushed batch', async () => {
    const sink = makeSink()
    const q = createOpsQueue(sink.send, 'c1')
    q.enqueueCall({ kind: 'call', storeId: 's', action: 'a', args: [], callId: 1, seq: 1 })
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'x', value: 1, seq: 2 })
    await tick()
    const msg = sink.sent[0]!
    if (msg.type !== 'ops') throw new Error('unreachable')
    expect(msg.ops[0]!.kind).toBe('set')
    expect(msg.ops[1]!.kind).toBe('call')
  })

  it('schedules a new flush after the previous one drains', async () => {
    const sink = makeSink()
    const q = createOpsQueue(sink.send, 'c1')
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'a', value: 1, seq: 1 })
    await tick()
    expect(sink.sent).toHaveLength(1)
    q.enqueueSet({ kind: 'set', storeId: 's', key: 'a', value: 2, seq: 2 })
    await tick()
    expect(sink.sent).toHaveLength(2)
  })
})
