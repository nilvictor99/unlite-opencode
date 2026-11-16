export * as KeyPool from "./key-pool.js"

import { Context, Effect, Layer, Ref } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"

/** Una credencial de tipo key con su estado de disponibilidad dentro del pool. */
export type PooledKey = {
  readonly id: Credential.ID
  readonly key: string
  /** Marca de tiempo (ms) hasta la que la key se considera agotada temporalmente (rate limit). 0 = disponible. */
  readonly exhaustedUntil: number
  /** Estado conocido del crédito: "ok", "exhausted" o "unknown". */
  readonly creditState: "ok" | "exhausted" | "unknown"
  /** Saldo de créditos conocido, cuando el proveedor lo expone. */
  readonly credits: number | undefined
  /** Marca de tiempo (ms) de la última verificación de crédito. 0 = nunca verificada. */
  readonly creditsCheckedAt: number
  /** Hasta qué marca de tiempo (ms) la key se considera sin crédito. 0 = disponible. */
  readonly creditExhaustedUntil: number
}

/** Estado del pool para una integración. */
type PoolState = ReadonlyMap<string /* integrationID */, ReadonlyArray<PooledKey>>

/**
 * KeyPool gestiona varias API keys de una misma integración (por ejemplo varias cuentas
 * de OpenCode Zen). Cuando una llamada falla por cuota agotada o rate limit, la key
 * usada se marca como agotada durante un periodo y el reintento usa la siguiente key
 * disponible del pool.
 *
 * El estado de crédito se persiste en cada credencial (ver `Credential.Service`), así
 * sobrevive reinicios: una key con crédito agotado no se vuelve a elegir hasta que se
 * marque como válida de nuevo (por ejemplo cuando el usuario valida que sus créditos se
 * renovaron).
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/KeyPool") {}

export interface Interface {
  /**
   * Registra las keys de una integración en el pool. Las claves pasadas sustituyen al
   * conjunto anterior para esa integración. El estado de crédito se lee de cada
   * credencial almacenada.
   */
  readonly load: (input: {
    readonly integrationID: Integration.ID
    readonly keys: ReadonlyArray<{
      readonly id: Credential.ID
      readonly key: string
      readonly value?: Credential.Value
    }>
  }) => Effect.Effect<void>
  /**
   * Devuelve la siguiente key disponible para la integración, o undefined si todas
   * están agotadas (temporal o por crédito) o no hay ninguna registrada.
   */
  readonly next: (integrationID: Integration.ID) => Effect.Effect<PooledKey | undefined>
  /**
   * Marca una key como agotada temporalmente hasta `until` (epoch ms), por ejemplo por
   * un rate limit. No persiste: al reiniciar vuelve a estar disponible.
   */
  readonly markExhausted: (input: {
    readonly integrationID: Integration.ID
    readonly keyID: Credential.ID
    readonly until: number
  }) => Effect.Effect<void>
  /**
   * Marca una key como sin crédito (o vuelve a decir que tiene crédito). Persiste en la
   * credencial para sobrevivir reinicios. Cuando `until` es 0 y `creditState` es
   * "exhausted", la key nunca se selecciona hasta que se marque como "ok".
   */
  readonly markCreditExhausted: (input: {
    readonly integrationID: Integration.ID
    readonly keyID: Credential.ID
    readonly until: number
  }) => Effect.Effect<void>
  readonly markCreditOk: (input: {
    readonly integrationID: Integration.ID
    readonly keyID: Credential.ID
  }) => Effect.Effect<void>
  /** Vuelve todas las keys de una integración a estado disponible (temporal y crédito). */
  readonly reset: (integrationID: Integration.ID) => Effect.Effect<void>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<PoolState>(new Map())

    const now = () => Date.now()

    const toPooledKey = (
      id: Credential.ID,
      key: string,
      value?: Credential.Value,
    ): PooledKey => {
      if (!value || value.type !== "key")
        return { id, key, exhaustedUntil: 0, creditState: "unknown", credits: undefined, creditsCheckedAt: 0, creditExhaustedUntil: 0 }
      return {
        id,
        key,
        exhaustedUntil: 0,
        creditState: value.creditState ?? "unknown",
        credits: value.credits,
        creditsCheckedAt: value.creditsCheckedAt ?? 0,
        creditExhaustedUntil: value.creditExhaustedUntil ?? 0,
      }
    }

    const service: Interface = Service.of({
      load: Effect.fn("KeyPool.load")(({ integrationID, keys }) =>
        Effect.gen(function* () {
          const pooled = keys.map((item) => toPooledKey(item.id, item.key, item.value))
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
            const available =
              item.exhaustedUntil <= time &&
              item.creditExhaustedUntil <= time &&
              item.creditState !== "exhausted"
            if (available) return item
            // Solo es candidato a fallback si se libera en el futuro. Una key con crédito
            // agotado y sin fecha de liberación nunca se elige como fallback.
            const releasesAt = Math.min(item.exhaustedUntil, item.creditExhaustedUntil)
            if (releasesAt > time) {
              if (
                best === undefined ||
                releasesAt < Math.min(best.exhaustedUntil, best.creditExhaustedUntil)
              ) {
                best = item
              }
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
      markCreditExhausted: Effect.fn("KeyPool.markCreditExhausted")(({ integrationID, keyID, until }) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (current) => {
            const pool = current.get(String(integrationID))
            if (!pool) return current
            const next = pool.map((item) =>
              item.id === keyID
                ? { ...item, creditState: "exhausted", creditExhaustedUntil: until }
                : item,
            )
            return new Map(current).set(String(integrationID), next)
          })
        }),
      ),
      markCreditOk: Effect.fn("KeyPool.markCreditOk")(({ integrationID, keyID }) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (current) => {
            const pool = current.get(String(integrationID))
            if (!pool) return current
            const next = pool.map((item) =>
              item.id === keyID
                ? { ...item, creditState: "ok", creditExhaustedUntil: 0 }
                : item,
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
            const next = pool.map((item) => ({
              ...item,
              exhaustedUntil: 0,
              creditState: "ok",
              creditExhaustedUntil: 0,
            }))
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
    .map((item) => ({ id: item.id, key: item.value.key, value: item.value }))
  yield* pool.load({ integrationID, keys })
})
