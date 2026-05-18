import { createClient, effect } from '../src'
import { counterStore } from './counter'

const workerUrl = new URL('./worker.ts', import.meta.url)
const { useStore } = createClient(workerUrl)
const store = useStore(counterStore)

const countEl = document.getElementById('count')!
const doubledEl = document.getElementById('doubled')!

effect(() => {
  countEl.textContent = String(store.count)
})
effect(() => {
  doubledEl.textContent = String(store.doubled)
})

document.getElementById('inc')!.addEventListener('click', () => {
  store.count++
})
document.getElementById('dec')!.addEventListener('click', () => {
  store.bump(-1)
})
document.getElementById('reset')!.addEventListener('click', () => {
  store.reset()
})
