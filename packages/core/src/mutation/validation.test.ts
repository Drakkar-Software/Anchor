import { describe, expect,it } from "vitest"

import { runValidation, ValidationError, zodValidator } from "./validation.js"

describe("runValidation", () => {
  it("does nothing when no validator", () => {
    expect(() => runValidation(undefined, { title: "test" }, "insert")).not.toThrow()
  })

  it("passes when validator returns true", () => {
    const validator = () => true as const

    expect(() => runValidation(validator, { title: "test" }, "insert")).not.toThrow()
  })

  it("throws ValidationError when validator returns errors", () => {
    const validator = (data: { title: string }) =>
      data.title.length > 0 ? (true as const) : ["Title is required"]

    expect(() => runValidation(validator, { title: "" }, "insert")).toThrow(
      ValidationError,
    )
  })

  it("ValidationError contains error messages", () => {
    const validator = () => ["Error 1", "Error 2"]

    try {
      runValidation(validator, {}, "insert")
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).errors).toEqual(["Error 1", "Error 2"])
      expect((error as ValidationError).message).toContain("Error 1")
      expect((error as ValidationError).message).toContain("Error 2")
    }
  })
})

describe("zodValidator", () => {
  it("creates validator from zod-like schema", () => {
    // Mock a Zod-like schema
    const schema = {
      safeParse: (data: unknown) => {
        const d = data as { title?: string }

        if (d.title && d.title.length > 0) {
          return { success: true }
        }

        return {
          error: { issues: [{ message: "Title is required" }] },
          success: false,
        }
      },
    }

    const validator = zodValidator(schema)

    expect(validator({ title: "Hello" })).toBe(true)
    expect(validator({ title: "" })).toEqual(["Title is required"])
    expect(validator({})).toEqual(["Title is required"])
  })
})
