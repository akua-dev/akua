import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { provenanceStatement } from "./signing"

describe("publish provenance", () => {
  it.effect("identifies the documented builder and preserves its CLI version", () =>
    Effect.sync(() => {
      const bytes = provenanceStatement({
        reference: "oci://registry.example.test/team/package",
        tag: "1.0.0",
        manifestDigest: "sha256:abc123",
        lock: Option.none(),
        version: "0.13.13"
      })
      const statement = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
        subject: Schema.Array(Schema.Struct({
          name: Schema.String,
          digest: Schema.Record(Schema.String, Schema.String)
        })),
        predicate: Schema.Struct({
          runDetails: Schema.Struct({
            builder: Schema.Struct({
              id: Schema.String,
              version: Schema.Record(Schema.String, Schema.String)
            })
          })
        })
      })))(new TextDecoder().decode(bytes))
      expect(statement.subject).toEqual([{
        name: "registry.example.test/team/package",
        digest: { sha256: "abc123" }
      }])
      expect(statement.predicate.runDetails.builder).toEqual({
        id: "https://docs.akua.dev/akua/cli",
        version: { akuapkg: "0.13.13" }
      })
    })
  )
})
