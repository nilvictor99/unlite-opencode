export * as KeyPool from "./key-pool.js"

import { Context, Effect, Layer, Ref } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"

/** Una credencial de tipo key con su estado de disponibilidad dentro del pool. */
export type PooledKey = {
  readonly id: Credential.ID
  readonly key: string
  /** Marca de tiempo (ms) hasta la que la key se considera agotada. 0 = disponible. */
  readonly exhaustedUntil: number
}

/** Estado del pool para una integración. */
type PoolState = ReadonlyMap<string /* integrationID */, ReadonlyArray<PooledKey>>

/**
 * KeyPool gestiona varias API keys de una misma integración (por ejemplo varias cuentas
 * de OpenCode Zen). Cuando una llamada falla por cuota agotada o rate limit, la key
 * usada se marca como agotada durante un periodo y el reintento usa la siguiente key
 * disponible del pool.
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/KeyPool") {}

export interface Interface {
  /**
   * Registra las keys de una integración en el pool. Las claves pasadas sustituyen al
   * conjunto anterior para esa integración.
   */
  readonly load: (input: {
    readonly integrationID: Integration.ID
    readonly keys: ReadonlyArray<{ readonly id: Credential.ID; readonly key: string }>
  }) => Effect.Effect<void>
  /**
   * Devuelve la siguiente key disponible para la integración, o undefined si todas
   * están agotadas o no hay ninguna registrada.
   */
  readonly next: (integrationID: Integration.ID) => Effect.Effect<PooledKey | undefined>
  /**
   * Marca una key como agotada hasta el momento indicado (epoch ms). Si `until` está
   * en el pasado, la key vuelve a estar disponible inmediatamente.
   */
  readonly markExhausted: (input: {
    readonly integrationID: Integration.ID
    readonly keyID: Credential.ID
    readonly until: number
  }) => Effect.Effect<void>
  /** Vuelve todas las keys de una integración a estado disponible. */
  readonly reset: (integrationID: Integration.ID) => Effect.Effect<void>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<PoolState>(new Map())

    const now = () => Date.now()

    const service: Interface = Service.of({
      load: Effect.fn("KeyPool.load")(({ integrationID, keys }) =>
        Effect.gen(function* () {
          const pooled = keys.map((item) => ({
            id: item.id,
            key: item.key,
            exhaustedUntil: 0,
          }))
          yield* Ref.update(state, (current) =>
            new Map(current).set(String(integrationID), pooled),
          )
        }),
      ),
      next: Effect.fn("KeyPool.next")((integrationID) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          const pool = current.get(String(integrationID))
          if (!pool || pool.length === 0) return undefined
          const time = now()
          let best: PooledKey | undefined = undefined
          for (const item of pool) {
            if (item.exhaustedUntil <= time) return item
            if (best === undefined || item.exhaustedUntil < best.exhaustedUntil) {
              best = item
            }
          }
          return best
        }),
      ),
      markExhausted: Effect.fn("KeyPool.markExhausted")(({ integrationID, keyID, until }) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (current) => {
            const pool = current.get(String(integrationID))
            if (!pool) return current
            const next = pool.map((item) =>
              item.id === keyID ? { ...item, exhaustedUntil: until } : item,
            )
            return new Map(current).set(String(integrationID), next)
          })
        }),
      ),
      reset: Effect.fn("KeyPool.reset")((integrationID) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (current) => {
            const pool = current.get(String(integrationID))
            if (!pool) return current
            const next = pool.map((item) => ({ ...item, exhaustedUntil: 0 }))
            return new Map(current).set(String(integrationID), next)
          })
        }),
      ),
    })
    return service
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/** Carga en el pool todas las credenciales de tipo `key` de una integración. */
export const loadFromCredentials = Effect.fn("KeyPool.loadFromCredentials")(function* (
  integrationID: Integration.ID,
) {
  const credentials = yield* Credential.Service
  const pool = yield* KeyPool.Service
  const stored = yield* credentials.list(integrationID)
  const keys = stored
    .filter((item) => item.value.type === "key")
    .map((item) => ({ id: item.id, key: item.value.key }))
  yield* pool.load({ integrationID, keys })
})
