import { describe, it, expect } from 'vitest'
import { signal } from '@preact/signals-core'
import {
  ctx,
  defineStore,
  isAsyncFn,
  isDerivedSignal,
  isStateSignal,
} from '../defineStore'

describe('defineStore', () => {
  it('returns id and setup', () => {
    const s = defineStore('foo', () => ({}))
    expect(s.id).toBe('foo')
    expect(typeof s.setup).toBe('function')
  })

  it('setup receives signal and computed helpers', () => {
    const s = defineStore('shape', ({ signal, computed }) => {
      const a = signal(1)
      const b = computed(() => a.value + 1)
      return { a, b }
    })
    const out = s.setup(ctx)
    expect(isStateSignal(out.a)).toBe(true)
    expect(isDerivedSignal(out.b)).toBe(true)
    expect(out.a.value).toBe(1)
    expect(out.b.value).toBe(2)
  })
})

describe('brand checks', () => {
  it('isStateSignal recognises ctx.signal()', () => {
    expect(isStateSignal(ctx.signal(0))).toBe(true)
  })

  it('isStateSignal rejects a bare preact signal()', () => {
    expect(isStateSignal(signal(0))).toBe(false)
  })

  it('isStateSignal rejects a computed', () => {
    expect(isStateSignal(ctx.computed(() => 1))).toBe(false)
  })

  it('isDerivedSignal recognises computed', () => {
    expect(isDerivedSignal(ctx.computed(() => 1))).toBe(true)
  })

  it('isDerivedSignal rejects state signal', () => {
    expect(isDerivedSignal(ctx.signal(0))).toBe(false)
  })
})

describe('isAsyncFn', () => {
  it('detects async arrow functions', () => {
    expect(isAsyncFn(async () => {})).toBe(true)
  })

  it('detects async function declarations', () => {
    expect(isAsyncFn(async function f() {})).toBe(true)
  })

  it('rejects sync arrow functions', () => {
    expect(isAsyncFn(() => {})).toBe(false)
  })

  it('rejects sync functions that return a Promise', () => {
    expect(isAsyncFn(() => Promise.resolve(1))).toBe(false)
  })

  it('rejects non-functions', () => {
    expect(isAsyncFn(0)).toBe(false)
    expect(isAsyncFn(null)).toBe(false)
    expect(isAsyncFn({})).toBe(false)
  })
})
