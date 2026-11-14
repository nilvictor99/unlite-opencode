import { EOL } from "node:os"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { createClient, loadIntegrations, resolveIntegration } from "./shared"
import { errorMessage } from "../../../util/error"

export default Runtime.handler(
  Commands.commands.auth.commands.keys,
  (input) =>
    keys(input).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(errorMessage(error) + EOL)
          process.exitCode = 1
        }),
      ),
    ),
)

const keys = Effect.fn("cli.auth.keys")(function* (input: { target?: string; format?: "default" | "json" }) {
  const client = yield* createClient()
  const integrations = yield* loadIntegrations(client)
  const integration = yield* resolveIntegration(integrations, input.target)

  const credentials = integration.connections.filter(
    (connection) => connection.type === "credential" && connection.method === "key",
  )

  if (input.format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          integration: integration.id,
          name: integration.name,
          keys: credentials.map((credential) => ({
            id: credential.id,
            label: credential.label,
          })),
        },
        null,
        2,
      ) + EOL,
    )
    return
  }

  if (credentials.length === 0) {
    process.stdout.write(`No API keys stored for ${integration.name}` + EOL)
    return
  }

  process.stdout.write(`API keys for ${integration.name}` + EOL)
  process.stdout.write(`Use these names to tell which Zen account each key belongs to.` + EOL)
  process.stdout.write(EOL)
  for (const credential of credentials) {
    process.stdout.write(`  ${credential.label.padEnd(24)}${credential.id}` + EOL)
  }
  process.stdout.write(EOL)
  process.stdout.write(`Tip: opencode auth login ${integration.id} --method key --keep-existing --label "Nombre cuenta"` + EOL)
})
