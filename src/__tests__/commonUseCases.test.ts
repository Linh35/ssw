import { describe, it, expect } from 'vitest'
import {
  bindHost,
  clientFromPort,
  defineStore,
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

describe('use case: todo list', () => {
  interface Todo { id: number; text: string; done: boolean }

  const todoStore = () =>
    defineStore('todos', ({ signal, computed }) => {
      const items = signal<Todo[]>([])
      let nextId = 1
      const remaining = computed(() => items.value.filter((t) => !t.done).length)
      const total = computed(() => items.value.length)
      const add = (text: string) => {
        items.value = [...items.value, { id: nextId++, text, done: false }]
      }
      const toggle = (id: number) => {
        items.value = items.value.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
      }
      const remove = (id: number) => {
        items.value = items.value.filter((t) => t.id !== id)
      }
      const clearDone = () => {
        items.value = items.value.filter((t) => !t.done)
      }
      return { items, remaining, total, add, toggle, remove, clearDone }
    })

  it('add / toggle / remove / clearDone propagate to a second tab', async () => {
    const { writer, reader } = pair(todoStore())
    await Promise.all([writer.ready, reader.ready])

    writer.add('milk')
    writer.add('eggs')
    writer.add('bread')
    await settle()
    expect(reader.total).toBe(3)
    expect(reader.remaining).toBe(3)

    writer.toggle(2)
    await settle()
    expect(reader.items[1]!.done).toBe(true)
    expect(reader.remaining).toBe(2)

    writer.remove(1)
    await settle()
    expect(reader.items.map((t) => t.id)).toEqual([2, 3])

    writer.clearDone()
    await settle()
    expect(reader.items.map((t) => t.id)).toEqual([3])
    expect(reader.remaining).toBe(1)
  })

  it('two writers can independently add items, both views converge', async () => {
    const def = todoStore()
    const onConnect = bindHost([def as never])
    const tab = () => {
      const ch = new MessageChannel()
      onConnect(ch.port2 as unknown as MessagePort)
      return clientFromPort(ch.port1 as unknown as MessagePort).useStore(def)
    }
    const a = tab()
    const b = tab()
    await Promise.all([a.ready, b.ready])

    a.add('a1')
    await settle()
    b.add('b1')
    await settle()

    expect(a.total).toBe(2)
    expect(b.total).toBe(2)
    expect(a.items.map((t) => t.text)).toEqual(b.items.map((t) => t.text))
  })
})

describe('use case: shopping cart with computed total', () => {
  interface Line { sku: string; price: number; qty: number }

  const cartStore = () =>
    defineStore('cart', ({ signal, computed }) => {
      const lines = signal<Line[]>([])
      const subtotal = computed(() =>
        lines.value.reduce((s, l) => s + l.price * l.qty, 0),
      )
      const itemCount = computed(() =>
        lines.value.reduce((s, l) => s + l.qty, 0),
      )

      const addItem = (sku: string, price: number, qty = 1) => {
        const existing = lines.value.find((l) => l.sku === sku)
        if (existing) {
          lines.value = lines.value.map((l) =>
            l.sku === sku ? { ...l, qty: l.qty + qty } : l,
          )
        } else {
          lines.value = [...lines.value, { sku, price, qty }]
        }
      }
      const setQty = (sku: string, qty: number) => {
        lines.value =
          qty <= 0
            ? lines.value.filter((l) => l.sku !== sku)
            : lines.value.map((l) => (l.sku === sku ? { ...l, qty } : l))
      }
      const clear = () => {
        lines.value = []
      }

      return { lines, subtotal, itemCount, addItem, setQty, clear }
    })

  it('subtotal and itemCount update as items are added and removed', async () => {
    const { writer, reader } = pair(cartStore())
    await Promise.all([writer.ready, reader.ready])

    writer.addItem('A', 10, 2)
    writer.addItem('B', 5)
    await settle()
    expect(reader.itemCount).toBe(3)
    expect(reader.subtotal).toBe(25)

    writer.addItem('A', 10) // accumulates
    await settle()
    expect(reader.itemCount).toBe(4)
    expect(reader.subtotal).toBe(35)

    writer.setQty('A', 0) // remove
    await settle()
    expect(reader.itemCount).toBe(1)
    expect(reader.subtotal).toBe(5)

    writer.clear()
    await settle()
    expect(reader.lines).toEqual([])
    expect(reader.subtotal).toBe(0)
  })
})

describe('use case: async loading / data / error', () => {
  interface User { id: number; name: string }

  const usersStore = () =>
    defineStore('users', ({ signal }) => {
      const data = signal<User | null>(null)
      const loading = signal(false)
      const error = signal<string | null>(null)
      const fetchUser = async (id: number) => {
        loading.value = true
        error.value = null
        try {
          if (id < 0) throw new Error('invalid id')
          const user: User = { id, name: `user-${id}` }
          data.value = user
          return user
        } catch (e) {
          error.value = (e as Error).message
          throw e
        } finally {
          loading.value = false
        }
      }
      return { data, loading, error, fetchUser }
    })

  it('successful fetch leaves data populated and loading false', async () => {
    const { writer, reader } = pair(usersStore())
    await Promise.all([writer.ready, reader.ready])

    const result = await writer.fetchUser(7)
    expect(result).toEqual({ id: 7, name: 'user-7' })

    await settle()
    expect(reader.data).toEqual({ id: 7, name: 'user-7' })
    expect(reader.loading).toBe(false)
    expect(reader.error).toBeNull()
  })

  it('failed fetch leaves error set, data untouched, loading false', async () => {
    const { writer, reader } = pair(usersStore())
    await Promise.all([writer.ready, reader.ready])

    await expect(writer.fetchUser(-1)).rejects.toThrow(/invalid id/)
    await settle()
    expect(reader.data).toBeNull()
    expect(reader.loading).toBe(false)
    expect(reader.error).toBe('invalid id')
  })

  it('a subsequent successful fetch clears the previous error', async () => {
    const { writer, reader } = pair(usersStore())
    await Promise.all([writer.ready, reader.ready])

    await expect(writer.fetchUser(-1)).rejects.toThrow()
    await settle()
    expect(reader.error).toBe('invalid id')

    await writer.fetchUser(3)
    await settle()
    expect(reader.error).toBeNull()
    expect(reader.data).toEqual({ id: 3, name: 'user-3' })
  })
})

describe('use case: form with validation', () => {
  const formStore = () =>
    defineStore('form', ({ signal, computed }) => {
      const email = signal('')
      const password = signal('')
      const submitted = signal(false)

      const emailValid = computed(() => /.+@.+\..+/.test(email.value))
      const passwordValid = computed(() => password.value.length >= 8)
      const canSubmit = computed(() => emailValid.value && passwordValid.value)

      const submit = () => {
        if (!emailValid.value || !passwordValid.value) return
        submitted.value = true
      }
      const reset = () => {
        email.value = ''
        password.value = ''
        submitted.value = false
      }
      return { email, password, submitted, emailValid, passwordValid, canSubmit, submit, reset }
    })

  it('canSubmit reflects field validity, submit gated on it', async () => {
    const { writer, reader } = pair(formStore())
    await Promise.all([writer.ready, reader.ready])

    expect(reader.canSubmit).toBe(false)

    writer.email = 'not-an-email'
    writer.password = 'short'
    await settle()
    expect(reader.emailValid).toBe(false)
    expect(reader.passwordValid).toBe(false)
    expect(reader.canSubmit).toBe(false)

    writer.submit()
    await settle()
    expect(reader.submitted).toBe(false)

    writer.email = 'me@example.com'
    writer.password = 'longenough'
    await settle()
    expect(reader.canSubmit).toBe(true)

    writer.submit()
    await settle()
    expect(reader.submitted).toBe(true)
  })

  it('reset clears all fields atomically', async () => {
    const { writer, reader } = pair(formStore())
    await Promise.all([writer.ready, reader.ready])

    writer.email = 'me@example.com'
    writer.password = 'longenough'
    writer.submit()
    await settle()
    expect(reader.submitted).toBe(true)

    writer.reset()
    await settle()
    expect(reader.email).toBe('')
    expect(reader.password).toBe('')
    expect(reader.submitted).toBe(false)
    expect(reader.canSubmit).toBe(false)
  })
})

describe('use case: filterable list (search)', () => {
  const peopleStore = () =>
    defineStore('people', ({ signal, computed }) => {
      const people = signal<string[]>([])
      const query = signal('')
      const visible = computed(() => {
        const q = query.value.toLowerCase().trim()
        if (!q) return people.value
        return people.value.filter((p) => p.toLowerCase().includes(q))
      })
      const count = computed(() => visible.value.length)
      const setPeople = (xs: string[]) => {
        people.value = xs
      }
      return { people, query, visible, count, setPeople }
    })

  it('visible recomputes when query changes', async () => {
    const { writer, reader } = pair(peopleStore())
    await Promise.all([writer.ready, reader.ready])

    writer.setPeople(['Alice', 'Bob', 'Carol', 'Dave', 'Alicia'])
    await settle()
    expect(reader.count).toBe(5)

    writer.query = 'ali'
    await settle()
    expect(reader.visible).toEqual(['Alice', 'Alicia'])
    expect(reader.count).toBe(2)

    writer.query = '   '
    await settle()
    expect(reader.count).toBe(5)

    writer.query = 'zzz'
    await settle()
    expect(reader.visible).toEqual([])
    expect(reader.count).toBe(0)
  })
})

describe('use case: notifications queue', () => {
  interface Toast { id: number; text: string; kind: 'info' | 'error' }

  const toastStore = () =>
    defineStore('toasts', ({ signal, computed }) => {
      const queue = signal<Toast[]>([])
      let nextId = 1
      const count = computed(() => queue.value.length)
      const push = (text: string, kind: 'info' | 'error' = 'info') => {
        queue.value = [...queue.value, { id: nextId++, text, kind }]
      }
      const dismiss = (id: number) => {
        queue.value = queue.value.filter((t) => t.id !== id)
      }
      const clear = () => {
        queue.value = []
      }
      return { queue, count, push, dismiss, clear }
    })

  it('push and dismiss flow', async () => {
    const { writer, reader } = pair(toastStore())
    await Promise.all([writer.ready, reader.ready])

    writer.push('saved')
    writer.push('failed', 'error')
    await settle()
    expect(reader.count).toBe(2)
    expect(reader.queue[0]!.kind).toBe('info')
    expect(reader.queue[1]!.kind).toBe('error')

    writer.dismiss(1)
    await settle()
    expect(reader.queue.map((t) => t.id)).toEqual([2])

    writer.clear()
    await settle()
    expect(reader.count).toBe(0)
  })
})

describe('use case: paginated view', () => {
  const pagedStore = () =>
    defineStore('paged', ({ signal, computed }) => {
      const items = signal<number[]>([])
      const page = signal(0)
      const pageSize = signal(5)
      const pageCount = computed(() =>
        Math.max(1, Math.ceil(items.value.length / pageSize.value)),
      )
      const slice = computed(() => {
        const start = page.value * pageSize.value
        return items.value.slice(start, start + pageSize.value)
      })
      const setItems = (xs: number[]) => {
        items.value = xs
      }
      const next = () => {
        page.value = Math.min(page.value + 1, pageCount.value - 1)
      }
      const prev = () => {
        page.value = Math.max(page.value - 1, 0)
      }
      return { items, page, pageSize, pageCount, slice, setItems, next, prev }
    })

  it('slice and pageCount track items / page / pageSize', async () => {
    const { writer, reader } = pair(pagedStore())
    await Promise.all([writer.ready, reader.ready])

    writer.setItems(Array.from({ length: 12 }, (_, i) => i))
    await settle()
    expect(reader.pageCount).toBe(3)
    expect(reader.slice).toEqual([0, 1, 2, 3, 4])

    writer.next()
    await settle()
    expect(reader.slice).toEqual([5, 6, 7, 8, 9])

    writer.next()
    await settle()
    expect(reader.slice).toEqual([10, 11])

    writer.next() // clamped at last page
    await settle()
    expect(reader.page).toBe(2)

    writer.pageSize = 4
    await settle()
    expect(reader.pageCount).toBe(3)
    expect(reader.slice).toEqual([8, 9, 10, 11])
  })
})

describe('use case: theme / preferences toggle', () => {
  const prefsStore = () =>
    defineStore('prefs', ({ signal, computed }) => {
      const theme = signal<'light' | 'dark'>('light')
      const compact = signal(false)
      const bodyClass = computed(() =>
        `${theme.value}${compact.value ? ' compact' : ''}`,
      )
      const toggleTheme = () => {
        theme.value = theme.value === 'light' ? 'dark' : 'light'
      }
      return { theme, compact, bodyClass, toggleTheme }
    })

  it('toggles propagate and the derived className updates', async () => {
    const { writer, reader } = pair(prefsStore())
    await Promise.all([writer.ready, reader.ready])

    expect(reader.bodyClass).toBe('light')
    writer.toggleTheme()
    await settle()
    expect(reader.bodyClass).toBe('dark')
    writer.compact = true
    await settle()
    expect(reader.bodyClass).toBe('dark compact')
  })
})
