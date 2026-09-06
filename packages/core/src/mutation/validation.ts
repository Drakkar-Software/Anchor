export type ValidationConfig<InsertRow = unknown, UpdateRow = unknown> = {
  /** Validator for insert operations */
  insert?: Validator<InsertRow>

  /** Validator for update operations */
  update?: Validator<UpdateRow>
}

/**
 * Validator function type — accepts data, returns true or array of error strings.
 * Compatible with Zod, Ajv, or any custom validator.
 */
export type Validator<T = unknown> = (
  data: T,
) => true | string[]

export class ValidationError extends Error {
  public readonly errors: string[]

  constructor(errors: string[]) {
    super(`Validation failed: ${errors.join(", ")}`)
    this.name = "ValidationError"
    this.errors = errors
  }
}

/**
 * Run a validator and throw ValidationError on failure.
 */
export function runValidation<T>(
  validator: Validator<T> | undefined,
  data: T,
  _operation: string,
): void {
  if (!validator) {return}

  const result = validator(data)

  if (result !== true) {
    throw new ValidationError(result)
  }
}

/**
 * Create a Zod-compatible validator from a Zod schema.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * const schema = z.object({ title: z.string().min(1), completed: z.boolean() })
 * const validator = zodValidator(schema)
 * ```
 */
export function zodValidator<T>(schema: {
  safeParse: (data: unknown) => { error?: { issues: { message: string }[] }; success: boolean; }
}): Validator<T> {
  return (data: T) => {
    const result = schema.safeParse(data)

    if (result.success) {return true}

    return result.error?.issues.map((i) => i.message) ?? ["Validation failed"]
  }
}
