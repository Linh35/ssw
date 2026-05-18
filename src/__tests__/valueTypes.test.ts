import { describe, it, expect } from 'vitest'
import {
  bindHost,
  clientFromPort,
  defineStore,
  effect,
  type Store,
} from '../index'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
async function settle(turns = 3) {
  for (let i = 0; i < turns; i++) await tick()
}

function pair<S extends Record<string, unknown>>(def: ReturnType<typeof defineStore<S>>) {
  const onConnect = bindHost([def as never])
  const newTab = (): Store<S> => {
    const ch = new MessageChannel()
    onConnect(ch.port2 as unknown as MessagePort)
    const { useStore } = clientFromPort(ch.port1 as unknown as MessagePort)
    return useStore(def)
  }
  return { writer: newTab(), reader: newTab() }
}

describe('value types: primitives', () => {
  it('propagates string values', async () => {
    const def = defineStore('s', ({ signal }) => ({ name: signal('alice') }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.name = 'bob'
    await settle()
    expect(reader.name).toBe('bob')
  })

  it('propagates boolean values', async () => {
    const def = defineStore('b', ({ signal }) => ({ on: signal(false) }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.on = true
    await settle()
    expect(reader.on).toBe(true)
    writer.on = false
    await settle()
    expect(reader.on).toBe(false)
  })

  it('propagates null', async () => {
    const def = defineStore('n', ({ signal }) => ({
      val: signal<string | null>('thing'),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.val = null
    await settle()
    expect(reader.val).toBeNull()
  })

  it('propagates undefined', async () => {
    const def = defineStore('u', ({ signal }) => ({
      val: signal<number | undefined>(undefined),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    expect(reader.val).toBeUndefined()
    writer.val = 7
    await settle()
    expect(reader.val).toBe(7)
    writer.val = undefined
    await settle()
    expect(reader.val).toBeUndefined()
  })

  it('preserves NaN identity through the wire', async () => {
    const def = defineStore('nan', ({ signal }) => ({ x: signal(0) }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.x = Number.NaN
    await settle()
    expect(Number.isNaN(reader.x)).toBe(true)
  })

  it('preserves negative zero', async () => {
    const def = defineStore('nz', ({ signal }) => ({ x: signal(1) }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.x = -0
    await settle()
    expect(Object.is(reader.x, -0)).toBe(true)
  })

  it('propagates bigint values', async () => {
    const def = defineStore('big', ({ signal }) => ({
      n: signal<bigint>(0n),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.n = 9007199254740993n
    await settle()
    expect(reader.n).toBe(9007199254740993n)
  })
})

describe('value types: containers', () => {
  it('propagates array values by replacement', async () => {
    const def = defineStore('arr', ({ signal }) => ({
      items: signal<number[]>([1, 2, 3]),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.items = [4, 5, 6, 7]
    await settle()
    expect(reader.items).toEqual([4, 5, 6, 7])
  })

  it('in-place array mutation does not propagate', async () => {
    const def = defineStore('arr2', ({ signal }) => ({
      items: signal<number[]>([1]),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.items.push(2)
    await settle()
    expect(reader.items).toEqual([1])
  })

  it('propagates plain object values', async () => {
    interface User { name: string; age: number }
    const def = defineStore('obj', ({ signal }) => ({
      user: signal<User>({ name: 'a', age: 1 }),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.user = { name: 'b', age: 42 }
    await settle()
    expect(reader.user).toEqual({ name: 'b', age: 42 })
  })

  it('propagates deeply nested objects', async () => {
    const def = defineStore('deep', ({ signal }) => ({
      tree: signal<{ a: { b: { c: number[] } } }>({ a: { b: { c: [1] } } }),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.tree = { a: { b: { c: [1, 2, 3] } } }
    await settle()
    expect(reader.tree).toEqual({ a: { b: { c: [1, 2, 3] } } })
  })

  it('propagates Map values', async () => {
    const def = defineStore('m', ({ signal }) => ({
      m: signal<Map<string, number>>(new Map([['a', 1]])),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.m = new Map([['a', 1], ['b', 2]])
    await settle()
    expect(reader.m).toBeInstanceOf(Map)
    expect(reader.m.get('b')).toBe(2)
    expect(reader.m.size).toBe(2)
  })

  it('propagates Set values', async () => {
    const def = defineStore('s', ({ signal }) => ({
      s: signal<Set<string>>(new Set(['a'])),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.s = new Set(['a', 'b', 'c'])
    await settle()
    expect(reader.s).toBeInstanceOf(Set)
    expect(reader.s.has('b')).toBe(true)
    expect(reader.s.size).toBe(3)
  })

  it('propagates Date values', async () => {
    const def = defineStore('d', ({ signal }) => ({
      when: signal<Date>(new Date('2025-01-01T00:00:00Z')),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    const next = new Date('2026-05-18T12:00:00Z')
    writer.when = next
    await settle()
    expect(reader.when).toBeInstanceOf(Date)
    expect(reader.when.toISOString()).toBe(next.toISOString())
  })

  it('Uint8Array round-trips and stays a typed array', async () => {
    const def = defineStore('u8', ({ signal }) => ({
      buf: signal<Uint8Array>(new Uint8Array([1, 2, 3])),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.buf = new Uint8Array([9, 8, 7, 6])
    await settle()
    expect(reader.buf).toBeInstanceOf(Uint8Array)
    expect(Array.from(reader.buf)).toEqual([9, 8, 7, 6])
  })

  it('propagates the empty string', async () => {
    const def = defineStore('es', ({ signal }) => ({ s: signal('init') }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.s = ''
    await settle()
    expect(reader.s).toBe('')
  })

  it('propagates the empty array', async () => {
    const def = defineStore('ea', ({ signal }) => ({
      xs: signal<number[]>([1, 2]),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.xs = []
    await settle()
    expect(reader.xs).toEqual([])
  })
})

describe('mixed-type stores', () => {
  it('handles a store with state of varied types together', async () => {
    interface Profile { name: string; age: number }
    const def = defineStore('mixed', ({ signal, computed }) => {
      const count = signal(0)
      const name = signal('alice')
      const flags = signal<{ active: boolean }>({ active: false })
      const tags = signal<string[]>([])
      const label = computed(() => `${name.value}:${count.value}`)
      const profile: Profile = { name: 'init', age: 0 }
      const owner = signal<Profile>(profile)
      return { count, name, flags, tags, label, owner }
    })
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])

    writer.count = 5
    writer.name = 'bob'
    writer.flags = { active: true }
    writer.tags = ['admin', 'dev']
    writer.owner = { name: 'carol', age: 30 }
    await settle()

    expect(reader.count).toBe(5)
    expect(reader.name).toBe('bob')
    expect(reader.flags).toEqual({ active: true })
    expect(reader.tags).toEqual(['admin', 'dev'])
    expect(reader.label).toBe('bob:5')
    expect(reader.owner).toEqual({ name: 'carol', age: 30 })
  })

  it('computed across mixed types updates reactively', async () => {
    const def = defineStore('cmix', ({ signal, computed }) => {
      const enabled = signal(false)
      const count = signal(3)
      const summary = computed(() =>
        enabled.value ? `on (${count.value})` : 'off',
      )
      return { enabled, count, summary }
    })
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    expect(reader.summary).toBe('off')
    writer.enabled = true
    await settle()
    expect(reader.summary).toBe('on (3)')
    writer.count = 7
    await settle()
    expect(reader.summary).toBe('on (7)')
  })
})

describe('actions with varied argument types', () => {
  it('passes strings, arrays and objects through action args', async () => {
    const def = defineStore('args', ({ signal }) => {
      const log = signal<string[]>([])
      const meta = signal<{ tag: string; nums: number[] } | null>(null)
      const push = (s: string) => {
        log.value = [...log.value, s]
      }
      const setMeta = (tag: string, nums: number[]) => {
        meta.value = { tag, nums }
      }
      return { log, meta, push, setMeta }
    })
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])

    writer.push('a')
    writer.push('b')
    writer.setMeta('items', [1, 2, 3])
    await settle()

    expect(reader.log).toEqual(['a', 'b'])
    expect(reader.meta).toEqual({ tag: 'items', nums: [1, 2, 3] })
  })

  it('async action returns object value', async () => {
    const def = defineStore('asyncObj', ({ signal }) => {
      const x = signal(0)
      const fetchProfile = async (id: number) => {
        x.value = id
        return { id, name: `user-${id}` }
      }
      return { x, fetchProfile }
    })
    const { writer } = pair(def)
    await writer.ready
    const result = await writer.fetchProfile(5)
    expect(result).toEqual({ id: 5, name: 'user-5' })
    expect(writer.x).toBe(5)
  })
})

describe('store shapes', () => {
  it('store with only state, no actions', async () => {
    const def = defineStore('onlyState', ({ signal }) => ({
      a: signal(1),
      b: signal('two'),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.a = 10
    writer.b = 'updated'
    await settle()
    expect(reader.a).toBe(10)
    expect(reader.b).toBe('updated')
  })

  it('store with only actions, no state', async () => {
    let sideEffect: string | null = null
    const def = defineStore('onlyActions', () => {
      const note = (s: string) => {
        sideEffect = s
      }
      return { note }
    })
    const { writer } = pair(def)
    await writer.ready
    writer.note('hello')
    await settle()
    expect(sideEffect).toBe('hello')
  })

  it('empty store (no state, no actions)', async () => {
    const def = defineStore('empty', () => ({}))
    const { writer } = pair(def)
    await expect(writer.ready).resolves.toBeUndefined()
  })

  it('multiple computed depending on the same signal', async () => {
    const def = defineStore('multi-computed', ({ signal, computed }) => {
      const n = signal(2)
      const dbl = computed(() => n.value * 2)
      const sq = computed(() => n.value * n.value)
      const str = computed(() => `n=${n.value}`)
      return { n, dbl, sq, str }
    })
    const { writer } = pair(def)
    await writer.ready
    expect(writer.dbl).toBe(4)
    expect(writer.sq).toBe(4)
    expect(writer.str).toBe('n=2')
    writer.n = 5
    expect(writer.dbl).toBe(10)
    expect(writer.sq).toBe(25)
    expect(writer.str).toBe('n=5')
  })
})

describe('value types: exotic but cloneable', () => {
  it('propagates RegExp values', async () => {
    const def = defineStore('rx', ({ signal }) => ({
      pat: signal<RegExp>(/foo/i),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.pat = /bar/g
    await settle()
    expect(reader.pat).toBeInstanceOf(RegExp)
    expect(reader.pat.source).toBe('bar')
    expect(reader.pat.flags).toBe('g')
  })

  it('propagates Error values, preserving name and message', async () => {
    const def = defineStore('err', ({ signal }) => ({
      last: signal<Error | null>(null),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.last = new TypeError('nope')
    await settle()
    expect(reader.last).toBeInstanceOf(Error)
    expect(reader.last?.name).toBe('TypeError')
    expect(reader.last?.message).toBe('nope')
  })

  it('propagates ArrayBuffer contents', async () => {
    const def = defineStore('ab', ({ signal }) => ({
      buf: signal<ArrayBuffer>(new ArrayBuffer(0)),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    const ab = new ArrayBuffer(4)
    new Uint8Array(ab).set([10, 20, 30, 40])
    writer.buf = ab
    await settle()
    expect(reader.buf).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(reader.buf))).toEqual([10, 20, 30, 40])
  })

  it('propagates cyclic object references', async () => {
    interface Node { name: string; self?: Node }
    const def = defineStore('cyc', ({ signal }) => ({
      n: signal<Node>({ name: 'init' }),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    const node: Node = { name: 'me' }
    node.self = node
    writer.n = node
    await settle()
    expect(reader.n.name).toBe('me')
    expect(reader.n.self).toBe(reader.n)
  })
})

describe('action error behavior', () => {
  it('sync action throwing leaves prior writes intact and store usable', async () => {
    const def = defineStore('thrower', ({ signal }) => {
      const a = signal(0)
      const b = signal(0)
      const boom = () => {
        a.value = 5
        throw new Error('nope')
      }
      const safe = () => {
        b.value = 9
      }
      return { a, b, boom, safe }
    })
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    writer.boom()
    await settle()
    expect(reader.a).toBe(5)
    writer.safe()
    await settle()
    expect(reader.b).toBe(9)
  })

  it('async action rejection does not leave the store frozen', async () => {
    const def = defineStore('asyncThrow', ({ signal }) => {
      const x = signal(0)
      const explode = async () => {
        x.value = 11
        throw new Error('bang')
      }
      const fix = (v: number) => {
        x.value = v
      }
      return { x, explode, fix }
    })
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])
    await expect(writer.explode()).rejects.toThrow(/bang/)
    expect(reader.x).toBe(11)
    writer.fix(42)
    await settle()
    expect(reader.x).toBe(42)
  })
})

describe('reactivity invariants', () => {
  it('effect fires for each distinct value transition', async () => {
    const def = defineStore('reflow', ({ signal }) => ({
      s: signal<string>('a'),
    }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])

    const seen: string[] = []
    const dispose = effect(() => {
      seen.push(reader.s)
    })
    writer.s = 'b'
    await settle()
    writer.s = 'c'
    await settle()
    expect(seen).toEqual(['a', 'b', 'c'])
    dispose()
  })

  it('setting a state key to the same value does not refire effects', async () => {
    const def = defineStore('idem', ({ signal }) => ({ n: signal(1) }))
    const { writer, reader } = pair(def)
    await Promise.all([writer.ready, reader.ready])

    let fires = 0
    const dispose = effect(() => {
      void reader.n
      fires += 1
    })
    expect(fires).toBe(1)
    writer.n = 1
    await settle()
    expect(fires).toBe(1)
    dispose()
  })
})
