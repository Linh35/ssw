export interface KeyState {
  value: unknown
  originClientId?: string
  originSeq?: number
}

export interface SetOp {
  kind: 'set'
  storeId: string
  key: string
  value: unknown
  seq: number
}

export interface CallOp {
  kind: 'call'
  storeId: string
  action: string
  args: unknown[]
  callId: number
  seq: number
}

export type Op = SetOp | CallOp

export type ClientMessage =
  | { type: 'subscribe'; storeId: string; clientId: string }
  | { type: 'ops'; clientId: string; ops: Op[] }

export type WorkerMessage =
  | {
      type: 'snapshot'
      storeId: string
      state: Record<string, KeyState>
      actions: string[]
    }
  | { type: 'patch'; storeId: string; state: Record<string, KeyState> }
  | { type: 'result'; callId: number; ok: true; value: unknown }
  | { type: 'result'; callId: number; ok: false; error: string }
  | { type: 'error'; storeId?: string; message: string }
