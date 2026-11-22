/**
 * Inline Standard Schema v1 specification (zero runtime dependencies).
 * Compatible with Zod, Valibot, ArkType, and any Standard Schema v1 validator.
 *
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** Standard Schema v1 metadata and validation hook. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  /** Standard Schema v1 property bag attached under `"~standard"`. */
  export interface Props<Input = unknown, Output = Input> {
    /** Specification version number (always `1`). */
    readonly version: 1
    /** Name of the schema library vendor. */
    readonly vendor: string
    /** Validate an unknown value synchronously or asynchronously. */
    readonly validate: (
      value: unknown
    ) => Result<Output> | Promise<Result<Output>>
    /** Phantom type carrier for input and output type inference. */
    readonly types?: Types<Input, Output> | undefined
  }

  /** Union of validation success and failure outcomes. */
  export type Result<Output> = SuccessResult<Output> | FailureResult

  /** Successful validation result containing the parsed output value. */
  export interface SuccessResult<Output> {
    /** Validated and possibly transformed output value. */
    readonly value: Output
    /** Always absent on success. */
    readonly issues?: undefined
  }

  /** Failed validation result containing one or more issues. */
  export interface FailureResult {
    /** Non-empty list of validation issues. */
    readonly issues: ReadonlyArray<Issue>
  }

  /** Single validation failure issue reported by a schema. */
  export interface Issue {
    /** Human-readable error message. */
    readonly message: string
    /** Optional path pointing to the invalid value. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }

  /** Object-form path segment carrying a property key. */
  export interface PathSegment {
    /** Key for this path segment. */
    readonly key: PropertyKey
  }

  /** Type-level input/output descriptor. */
  export interface Types<Input = unknown, Output = Input> {
    /** Raw input type accepted by the schema. */
    readonly input: Input
    /** Validated output type produced by the schema. */
    readonly output: Output
  }

  /** Extract the input type from a Standard Schema v1 validator. */
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input']

  /** Extract the output type from a Standard Schema v1 validator. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output']
}

/** Infer the input type accepted by a Standard Schema v1 validator. */
export type InferInput<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferInput<Schema>

/** Infer the validated output type produced by a Standard Schema v1 validator. */
export type InferOutput<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<Schema>

/** JSON-serializable validation issue normalized from a Standard Schema failure. */
export interface StandardSchemaIssue {
  /** Human-readable validation error message. */
  readonly message: string
  /** Optional JSON-safe property path to the failing field. */
  readonly path?: readonly (string | number)[]
}

/** Normalized result returned by `validateStandardSchema`. */
export type StandardSchemaValidationResult<Output> =
  | {
      /** Validation succeeded. */
      readonly ok: true
      /** Validated output value. */
      readonly value: Output
    }
  | {
      /** Validation failed. */
      readonly ok: false
      /** Normalized list of validation issues. */
      readonly issues: readonly StandardSchemaIssue[]
    }

/** Runtime guard checking whether a value implements Standard Schema v1. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return false
  }

  const standard = (value as Record<string, unknown>)['~standard']
  if (typeof standard !== 'object' || standard === null) {
    return false
  }

  const props = standard as Record<string, unknown>
  return (
    props.version === 1 &&
    typeof props.vendor === 'string' &&
    typeof props.validate === 'function'
  )
}

function normalizeIssuePath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined
): readonly (string | number)[] | undefined {
  if (!path || path.length === 0) {
    return undefined
  }

  return path.map((segment) => {
    const key =
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? segment.key
        : segment
    return typeof key === 'symbol' ? String(key) : key
  })
}

/**
 * Validate an unknown value against a Standard Schema v1 validator.
 * Supports both synchronous and asynchronous validators and normalizes issues
 * into a JSON-serializable format suitable for JSON-RPC `-32602` error data.
 */
export async function validateStandardSchema<S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): Promise<StandardSchemaValidationResult<InferOutput<S>>> {
  const result = await schema['~standard'].validate(input)

  if (result.issues) {
    const issues: StandardSchemaIssue[] = result.issues.map((issue) => {
      const path = normalizeIssuePath(issue.path)
      return path
        ? { message: issue.message, path }
        : { message: issue.message }
    })
    return { ok: false, issues }
  }

  return { ok: true, value: result.value as InferOutput<S> }
}
