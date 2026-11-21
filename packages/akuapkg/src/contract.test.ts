import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ERROR_CATALOG } from "./error-catalog"
import { ExitCode, fail, packageMissing } from "./contract"

describe("structured error documentation", () => {
  it.effect("links every catalog error directly to its canonical reference page", () =>
    Effect.sync(() => {
      for (const { code } of ERROR_CATALOG) {
        const error = fail(code, "test failure", ExitCode.userError).error
        expect(error.docs).toBe(`https://docs.akua.dev/akua/errors/${code}`)
      }
    })
  )

  it.effect("keeps the missing-package recovery details with its direct docs link", () =>
    Effect.sync(() => {
      const failure = packageMissing("missing/Package.k")
      expect(failure.exitCode).toBe(ExitCode.userError)
      expect(failure.error).toEqual({
        level: "error",
        code: "E_PACKAGE_MISSING",
        message: "Package.k not found",
        path: "missing/Package.k",
        suggestion: "pass the Package.k path explicitly or cd to its directory",
        docs: "https://docs.akua.dev/akua/errors/E_PACKAGE_MISSING"
      })
    })
  )
})
