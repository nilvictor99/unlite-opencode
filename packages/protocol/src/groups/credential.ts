import { Credential } from "@opencode/schema/credential"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, InvalidRequestError } from "../errors.js"
import { optional, NonNegativeInt } from "@opencode/schema/schema"

export const CredentialGroup = HttpApiGroup.make("server.credential")
  .add(
    HttpApiEndpoint.get("credential.list", "/api/credential", {
      success: Schema.Struct({ data: Schema.Array(Credential.Entry) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.list",
        summary: "List credentials",
        description: "List every stored integration credential, including its secret value.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("credential.create", "/api/credential", {
      payload: Credential.CreateInput,
      success: Schema.Struct({ data: Credential.Entry }),
      error: [ConflictError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.create",
        summary: "Create credential",
        description:
          "Store an integration credential. It becomes the integration's active credential unless activate is false and the integration already has one. Fails with a conflict when the requested ID already exists, and with an invalid request when an `integration.connect` policy denies the integration.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("credential.update", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      payload: Schema.Struct({ label: Schema.String }),
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.update",
          summary: "Update credential",
          description: "Update a stored credential label.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("credential.credit", "/api/credential/:credentialID/credit", {
      params: { credentialID: Credential.ID },
      payload: Schema.Struct({
        /** Estado conocido del crédito: "ok", "exhausted" o "unknown". */
        creditState: optional(Schema.Literal("ok", "exhausted", "unknown")),
        /** Saldo de créditos conocido, cuando el proveedor lo expone. */
        credits: optional(Schema.Number),
        /** Marca de tiempo (ms) de la última verificación de crédito. */
        creditsCheckedAt: optional(NonNegativeInt),
        /** Hasta qué marca de tiempo (ms) la key se considera sin crédito. */
        creditExhaustedUntil: optional(NonNegativeInt),
      }),
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.credit",
          summary: "Update credit state",
          description:
            "Update the credit state of a stored key credential (ok/exhausted/unknown, balance, last check and exhausted-until). The client can call this when opening the app to validate whether each key still has credits, and mark exhausted keys so they are not used again until they are validated as ok.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("credential.validate", "/api/credential/:credentialID/validate", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.validate",
          summary: "Validate credit",
          description:
            "Probes the provider with the stored key to determine whether it still has credits. Marks the credential as `ok` when the probe succeeds and as `exhausted` when it fails with authentication or quota errors. Intended to run when the app opens so exhausted keys are not selected again until their credits are renewed.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "credential" }))
  .add(
    HttpApiEndpoint.post("credential.activate", "/api/credential/:credentialID/activate", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.activate",
          summary: "Activate credential",
          description: "Activate a stored integration credential.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("credential.remove", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.remove",
          summary: "Remove credential",
          description: "Remove a stored integration credential.",
        }),
      ),
  )
