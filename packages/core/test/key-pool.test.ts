import { testEffect } from "./lib/effect"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { KeyPool } from "@opencode/core/key-pool"

const it = testEffect(LayerNode.compile(KeyPool.node))

it.effect("devuelve la siguiente key disponible y rota tras agotar una", () =>
  Effect.gen(function* () {
    const pool = yield* KeyPool.Service
    const id1 = Credential.ID.create()
    const id2 = Credential.ID.create()
    const integrationID = Integration.ID.make("opencode")

    yield* pool.load({
      integrationID,
      keys: [
        { id: id1, key: "key-uno" },
        { id: id2, key: "key-dos" },
      ],
    })

    const first = yield* pool.next(integrationID)
    expect(first?.key).toBe("key-uno")

    // Marca la primera como agotada por un minuto
    yield* pool.markExhausted({
      integrationID,
      keyID: id1,
      until: Date.now() + 60_000,
    })

    const second = yield* pool.next(integrationID)
    expect(second?.key).toBe("key-dos")

    // Tras reset, vuelve a estar disponible la primera
    yield* pool.reset(integrationID)
    const again = yield* pool.next(integrationID)
    expect(again?.key).toBe("key-uno")
  }),
)

it.effect("devuelve undefined cuando no hay keys registradas", () =>
  Effect.gen(function* () {
    const pool = yield* KeyPool.Service
    const result = yield* pool.next(Integration.ID.make("opencode"))
    expect(result).toBeUndefined()
  }),
)

it.effect("devuelve la key aunque esté agotada si es la única", () =>
  Effect.gen(function* () {
    const pool = yield* KeyPool.Service
    const id = Credential.ID.create()
    const integrationID = Integration.ID.make("opencode")

    yield* pool.load({
      integrationID,
      keys: [{ id, key: "key-una" }],
    })

    yield* pool.markExhausted({
      integrationID,
      keyID: id,
      until: Date.now() + 60_000,
    })

    const result = yield* pool.next(integrationID)
    expect(result?.key).toBe("key-una")
  }),
)
