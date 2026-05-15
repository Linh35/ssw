import { describe, it, expect } from 'vitest'
import { bindHost, clientFromPort, defineStore, type Store } from '../index'

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
