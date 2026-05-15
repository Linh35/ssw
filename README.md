# ssw

A signal-based store API where canonical state lives in a `SharedWorker` and every connected tab gets a reactive mirror. Cross-tab state for free, with a Pinia-shaped surface and `@preact/signals-core` under the hood.

Status: experimental. Roughly 3.5 KB gzipped on top of the signals lib.

## Why

- **Multi-tab state without ceremony.** Opening the app in three tabs gives you three views of the same state. No `BroadcastChannel` wiring, no manual sync.
- **Sync ergonomics over an async boundary.** `store.count++` looks synchronous and feels synchronous; the worker handshake is hidden behind microtask-batched ops + optimistic local updates.
- **Signals all the way down.** Mirrors are real preact signals — `effect()`, `computed()`, and signal-aware UI bindings work out of the box.

## Install / run the demo

```bash
git clone git@github.com:Linh35/ssw.git
cd ssw
npm install
npm run dev
```

Open the printed URL in two tabs. Click `+1` in one; the other moves too.

## Quick start

```ts
// src/stores/counter.ts
import { defineStore } from './lib'

export const counterStore = defineStore('counter', ({ signal, computed }) => {
  const count = signal(0)
  const doubled = computed(() => count.value * 2)

  const bump = (by: number) => { count.value += by }
  const reset = () => { count.value = 0 }
  const fetchRemote = async () => {
    const r = await fetch('/state').then((x) => x.json())
    count.value = r.count
  }

  return { count, doubled, bump, reset, fetchRemote }
})
```

```ts
// src/worker.ts  — bundled as a SharedWorker entry
import { createHost } from './lib'
import { counterStore } from './stores/counter'

createHost([counterStore])
```

```ts
// src/main.ts
import { createClient, effect } from './lib'
import { counterStore } from './stores/counter'

const { useStore } = createClient(new URL('./worker.ts', import.meta.url))
const store = useStore(counterStore)

effect(() => console.log(store.count, store.doubled))

store.count++             // optimistic, propagates to other tabs
store.bump(3)             // sync action — fire-and-forget
await store.fetchRemote() // async action — round-trips
await store.ready         // wait for the first snapshot if needed
```

## API surface

### `defineStore(id, setup)`

`setup` receives `{ signal, computed }` and returns a record. Values are interpreted by shape:

| Returned value | Becomes |
| --- | --- |
| `signal(initial)` | writable state — `store.foo` reads, `store.foo = x` writes |
| `computed(fn)` | derived state — `store.foo` reads, no setter |
| plain function (sync) | optimistic action — runs locally and on the worker, no return value exposed |
| `async` function | async action — only runs on the worker, returns the awaited result |

The same definition module is imported in both the worker and the main thread. **Setup must be deterministic** — it executes in each context independently.

### `createClient(workerUrl, name?)`

Connects to a `SharedWorker` at `workerUrl`. Returns `{ useStore }`. The `name` lets multiple disjoint clients coexist (default `"ssw"`).

### `useStore(def)` (returned from `createClient` / `clientFromPort`)

Returns a plain object whose accessors are wired via `Object.defineProperty` to the local signal mirror. `await store.ready` resolves once the initial snapshot has been applied. `useStore` can only be called once per store id per client; call it once and pass the resulting object around.

### `$ (store)`

Returns an object of the underlying `Signal` / `ReadonlySignal` instances. Use it when you need to hand a raw signal to another reactive system, or when you need `peek()` / `subscribe()` directly.

### `createHost(defs[])`

Call once inside the SharedWorker entry. Instantiates each store and binds `SharedWorkerGlobalScope.connect`.

### `clientFromPort(port)` / `bindHost(defs)` (low-level)

Port-level entry points used by the test suite. They take any `MessagePort` (e.g. `new MessageChannel().port1`) and let you run the host/client without a real `SharedWorker` — handy for tests and for adapting to other transports.

### `effect`, `batch` (re-exports from `@preact/signals-core`)

Re-exported so you don't have to depend on the underlying lib separately.

## Architecture

```
+----- main thread (per tab) -----+      +------ SharedWorker ------+
|                                 |      |                          |
|   store.count = 5               | ops  |   signals (canonical)    |
|   └─ mirror signal updated      |─────►|   meta[key]: origin+seq  |
|      immediately (optimistic)   |      |                          |
|      op queued for microtask    |      |   set → batch() apply    |
|                                 |      |   call → action body     |
|   apply patch:                  | patch|                          |
|   ├─ stale self-echo → drop     |◄─────│   per-port effect emits  |
|   ├─ remote w/ unacked → skip   |      |   the diff every tick    |
|   └─ otherwise → assign         |      |                          |
+---------------------------------+      +--------------------------+
```

**Setup runs in both contexts.** The worker uses its instance as the canonical state. The main thread uses its instance for shape detection and to seed the initial mirror; computeds and action closures stay connected to the same in-context signals so reactivity reconnects without any cross-realm tricks.

**Ops protocol.** Every client maintains a microtask-batched queue of operations:

| Op | When |
| --- | --- |
| `{kind:'set', key, value, seq}` | direct property assignment via the proxy setter |
| `{kind:'call', action, args, callId, seq}` | sync or async action invocation |

The whole queue ships in one `{type:'ops'}` message at the next microtask. Multiple writes to the same key inside that microtask collapse to the last value, so a slider drag becomes a single message.

**Two ack channels.** When the worker processes a set, the originating tab needs to know its `seq` has been acknowledged so that later remote writes are no longer suspect.

- For **value-changed sets**, the resulting patch is broadcast to everyone including the originator, carrying `originClientId` and `originSeq`. The originator advances `ackedSeq` from the patch metadata.
- For **idempotent sets** (value didn't actually change), the per-port effect doesn't fire. The worker's per-port effect *force-includes* those keys in the next patch to the originator so the ack still flows through. This is the only role of the `activeSet` context inside `bindHost`.

**Per-key flicker filter.** On the client, every applied patch is checked against two counters per key:

- `latestLocalSeq[k]` — highest `seq` of any local write we've issued for `k`.
- `ackedSeq[k]` — highest `seq` we've seen reflected back as `originClientId === me`.

The filter rules:

```
if originClientId === me:
  if state.seq < latestLocalSeq[k]: drop (a stale echo of an older write)
  else: apply, advance ackedSeq[k]
else (remote or initial snapshot):
  if ackedSeq[k] < latestLocalSeq[k]: skip (we have unacked pending writes)
  else: apply
```

This is what makes concurrent writes from multiple tabs converge cleanly to a single value without intermediate flicker.

## Limitations

- **No persistence.** State evaporates when the last tab closes. Add IndexedDB if you need it.
- **SharedWorker support is the gating constraint.** Safari 16+, Firefox, modern Chrome are fine. Older mobile contexts may not have it; there's no dedicated-worker fallback (it would lose cross-tab sync).
- **Setup determinism.** `Math.random`, `Date.now`, `fetch`, anything stateful inside `setup` will diverge between the worker's instance and the main thread's. Sync actions inherit this rule — non-deterministic action bodies should be `async`.
- **Value-replacement only.** `store.items.push(x)` mutates the array in place; the setter never fires. Use `store.items = [...store.items, x]`.
- **Sets execute before calls within one microtask.** If you write `store.x = 1; store.action(); store.x = 2;` synchronously, the worker's `action()` runs against `x = 2`, not `x = 1`. Locally the action saw `x = 1`. To force ordering, `await` between them so the microtask flushes.
- **No port cleanup.** When a tab closes the worker's per-port effect keeps a reference. MessagePort has no native close event; explicit "leave" messages or a heartbeat would fix it (not done yet).
- **Single-author auth.** Worker can't authenticate writers right now — every tab on the same origin can mutate any store.

## Roadmap

- IndexedDB persistence layer.
- Port disconnect detection + cleanup.
- Devtools panel (stream of patches, time-travel).
- Per-signal effects on the worker for stores with very large key counts.

## Scripts

```bash
npm run dev        # vite dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

## License

MIT.
