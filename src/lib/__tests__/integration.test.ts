import { describe, it, expect } from 'vitest'
import { $, bindHost, clientFromPort, defineStore, effect, type Store } from '../index'

function makeCounter() {
  return defineStore('counter', ({ signal, computed }) => {
    const count = signal(0)
    const doubled = computed(() => count.value * 2)
    const reset = () => {
      count.value = 0
    }
    const bump = (by: number) => {
      count.value += by
    }
    const bumpAsync = async (by: number) => {
      count.value += by
      return count.value
    }
    return { count, doubled, reset, bump, bumpAsync }
  })
}

type CounterDef = ReturnType<typeof makeCounter>
type CounterShape = ReturnType<CounterDef['setup']>

function setup() {
  const def = makeCounter()
  const onConnect = bindHost([def as never])
  function newTab(): Store<CounterShape> {
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    return useStore(def)
  }
  return { def, newTab }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
async function settle(turns = 3) {
  for (let i = 0; i < turns; i++) await tick()
}

describe('client + host over MessageChannel', () => {
  it('seeds values from snapshot and resolves ready', async () => {
    const { newTab } = setup()
    const store = newTab()
    await store.ready
    expect(store.count).toBe(0)
    expect(store.doubled).toBe(0)
  })

  it('writes propagate to other tabs', async () => {
    const { newTab } = setup()
    const a = newTab()
    const b = newTab()
    await Promise.all([a.ready, b.ready])

    a.count = 5
    expect(a.count).toBe(5)
    await settle()
    expect(b.count).toBe(5)
  })

  it('computed re-derives on patch', async () => {
    const { newTab } = setup()
    const a = newTab()
    const b = newTab()
    await Promise.all([a.ready, b.ready])

    a.count = 3
    await settle()
    expect(b.doubled).toBe(6)
  })

  it('sync action mutates optimistically and propagates', async () => {
    const { newTab } = setup()
    const a = newTab()
    const b = newTab()
    await Promise.all([a.ready, b.ready])

    a.bump(5)
    expect(a.count).toBe(5)
    await settle()
    expect(b.count).toBe(5)
  })

  it('async action returns worker value', async () => {
    const { newTab } = setup()
    const a = newTab()
    await a.ready
    const result = await a.bumpAsync(4)
    expect(result).toBe(4)
    expect(a.count).toBe(4)
  })

  it('coalesces successive writes to the same key', async () => {
    const { newTab } = setup()
    const a = newTab()
    const b = newTab()
    await Promise.all([a.ready, b.ready])
    a.count = 1
    a.count = 2
    a.count = 3
    await settle()
    expect(a.count).toBe(3)
    expect(b.count).toBe(3)
  })
})

describe('regressions', () => {
  it('computed updates on main thread when state changes locally', async () => {
    const { newTab } = setup()
    const store = newTab()
    await store.ready
    store.count = 7
    expect(store.doubled).toBe(14)
    store.bump(3)
    expect(store.doubled).toBe(20)
  })

  it('snapshot does not overwrite a pre-ready optimistic write', async () => {
    const def = makeCounter()
    const onConnect = bindHost([def as never])
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    const store = useStore(def)

    store.count = 99
    expect(store.count).toBe(99)
    await store.ready
    await settle()
    expect(store.count).toBe(99)
  })

  it('concurrent writes from two tabs converge', async () => {
    const { newTab } = setup()
    const a = newTab()
    const b = newTab()
    await Promise.all([a.ready, b.ready])

    a.count = 5
    b.count = 6
    await settle()

    expect(a.count).toBe(b.count)
  })
})

describe('error and lifecycle', () => {
  it('ready rejects when the worker does not know the store', async () => {
    const known = defineStore('known', ({ signal }) => ({ x: signal(0) }))
    const unknown = defineStore('unknown', ({ signal }) => ({ x: signal(0) }))
    const onConnect = bindHost([known as never])
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    const store = useStore(unknown)
    await expect(store.ready).rejects.toThrow(/unknown/)
  })

  it('async action rejects when the worker throws', async () => {
    const def = defineStore('throws', ({ signal }) => {
      const x = signal(0)
      const explode = async () => {
        throw new Error('boom')
      }
      return { x, explode }
    })
    const onConnect = bindHost([def as never])
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    const store = useStore(def)
    await store.ready
    await expect(store.explode()).rejects.toThrow(/boom/)
  })
})

describe('interop', () => {
  it('$ exposes the underlying signals for direct read/subscribe', async () => {
    const def = defineStore('iop', ({ signal, computed }) => {
      const n = signal(2)
      const sq = computed(() => n.value * n.value)
      return { n, sq }
    })
    const onConnect = bindHost([def as never])
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    const store = useStore(def)
    await store.ready

    const sigs = $(store)
    expect(sigs.n.value).toBe(2)
    expect(sigs.sq.value).toBe(4)
    const seen: number[] = []
    const dispose = effect(() => {
      seen.push(sigs.sq.value)
    })
    store.n = 5
    expect(seen).toEqual([4, 25])
    dispose()
  })

  it('effect reactivity tracks store property reads', async () => {
    const def = defineStore('react', ({ signal, computed }) => {
      const a = signal(1)
      const b = computed(() => a.value + 10)
      return { a, b }
    })
    const onConnect = bindHost([def as never])
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    const store = useStore(def)
    await store.ready

    const log: number[] = []
    effect(() => {
      log.push(store.b)
    })
    store.a = 4
    expect(log).toEqual([11, 14])
  })

  it('a single client can host multiple stores', async () => {
    const counter = defineStore('m_counter', ({ signal }) => ({ c: signal(0) }))
    const flags = defineStore('m_flags', ({ signal }) => ({ on: signal(false) }))

    const onConnect = bindHost([counter as never, flags as never])
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    const cs = useStore(counter)
    const fs = useStore(flags)
    await Promise.all([cs.ready, fs.ready])

    cs.c = 9
    fs.on = true
    const settle3 = () =>
      new Promise<void>((r) => setTimeout(r, 0)).then(() =>
        new Promise<void>((r) => setTimeout(r, 0)),
      )
    await settle3()
    expect(cs.c).toBe(9)
    expect(fs.on).toBe(true)
  })
})
