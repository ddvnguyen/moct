/**
 * MCP argument validation — pydantic-v2-lax-faithful, schema-driven.
 *
 * FastMCP validates tools/call arguments against the tool's input schema and,
 * on failure, returns "Error executing tool {name}: ..." with pydantic's exact
 * rendering. This module replicates that layer (probed against the live Python
 * server, pydantic 2.13) so wrong-typed/missing args produce byte-identical
 * responses. Extra keys are ignored; defaults are applied; values are lax-
 * coerced exactly where pydantic lax coerces them.
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import { pyRepr, pyTypeName } from "../../domain/models.js";

const ERROR_URL = "https://errors.pydantic.dev/2.13/v";

export interface SchemaProperty {
  type?: string;
  anyOf?: SchemaProperty[];
  default?: unknown;
  items?: SchemaProperty;
  additionalProperties?: SchemaProperty | boolean;
}

export interface ToolSchema {
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

interface SingleError {
  loc: (string | number)[];
  msg: string;
  type: string;
  input: unknown;
  inputType: string;
}

function pyTypeOf(v: unknown): string {
  return pyTypeName(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const BOOL_TRUE = new Set(["true", "1", "yes", "on"]);
const BOOL_FALSE = new Set(["false", "0", "no", "off"]);

function coerceInt(v: unknown, errors: SingleError[], loc: (string | number)[]): number | null {
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v;
    errors.push({
      loc,
      msg: "Input should be a valid integer, got a number with a fractional part",
      type: "int_from_float",
      input: v,
      inputType: pyTypeOf(v),
    });
    return null;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (/^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
    errors.push({
      loc,
      msg: "Input should be a valid integer, unable to parse string as an integer",
      type: "int_parsing",
      input: v,
      inputType: "str",
    });
    return null;
  }
  errors.push({
    loc,
    msg: "Input should be a valid integer",
    type: "int_type",
    input: v,
    inputType: pyTypeOf(v),
  });
  return null;
}

function coerceBool(v: unknown, errors: SingleError[], loc: (string | number)[]): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isInteger(v)) {
    if (v === 0) return false;
    if (v === 1) return true;
    errors.push({
      loc,
      msg: "Input should be a valid boolean",
      type: "bool_type",
      input: v,
      inputType: pyTypeOf(v),
    });
    return null;
  }
  if (typeof v === "string") {
    const low = v.toLowerCase();
    if (BOOL_TRUE.has(low)) return true;
    if (BOOL_FALSE.has(low)) return false;
    errors.push({
      loc,
      msg: "Input should be a valid boolean, unable to interpret input",
      type: "bool_parsing",
      input: v,
      inputType: "str",
    });
    return null;
  }
  errors.push({
    loc,
    msg: "Input should be a valid boolean",
    type: "bool_type",
    input: v,
    inputType: pyTypeOf(v),
  });
  return null;
}

function checkValue(
  schema: SchemaProperty,
  value: unknown,
  errors: SingleError[],
  loc: (string | number)[],
): unknown {
  const prop = schema;
  if (prop.anyOf) {
    const branches = prop.anyOf;
    const nonNull = branches.filter((s) => s.type !== "null");
    if (value === null || value === undefined) {
      if (nonNull.length !== branches.length) return null;
      if (nonNull.length === 0) {
        errors.push({
          loc,
          msg: "Input should be a valid string",
          type: "string_type",
          input: value,
          inputType: pyTypeOf(value),
        });
        return undefined;
      }
      return checkValue(nonNull[0] ?? { type: "string" }, value, errors, loc);
    }
    if (nonNull.length === 0) {
      // none-only union (anyOf=[{type:"null"}]) with a non-null value.
      errors.push({
        loc,
        msg: "Input should be a valid string",
        type: "string_type",
        input: value,
        inputType: pyTypeOf(value),
      });
      return undefined;
    }
    // pydantic lax union semantics: first branch that validates wins.
    let firstErrors: SingleError[] | null = null;
    for (const branch of nonNull) {
      const trial: SingleError[] = [];
      const checked = checkValue(branch, value, trial, loc);
      if (trial.length === 0) return checked;
      if (firstErrors === null) firstErrors = trial;
    }
    for (const e of firstErrors ?? []) errors.push(e);
    return undefined;
  }
  const t = prop.type;
  if (t === "string") {
    if (typeof value === "string") return value;
    errors.push({
      loc,
      msg: "Input should be a valid string",
      type: "string_type",
      input: value,
      inputType: pyTypeOf(value),
    });
    return undefined;
  }
  if (t === "integer") {
    const before = errors.length;
    const n = coerceInt(value, errors, loc);
    return errors.length > before ? undefined : n;
  }
  if (t === "boolean") {
    const before = errors.length;
    const b = coerceBool(value, errors, loc);
    return errors.length > before ? undefined : b;
  }
  if (t === "array") {
    if (!Array.isArray(value)) {
      errors.push({
        loc,
        msg: "Input should be a valid list",
        type: "list_type",
        input: value,
        inputType: pyTypeOf(value),
      });
      return undefined;
    }
    const out: unknown[] = [];
    let failed = false;
    value.forEach((item, i) => {
      const before = errors.length;
      const checked = checkValue(prop.items ?? { type: "string" }, item, errors, [...loc, i]);
      if (errors.length > before) failed = true;
      else out.push(checked);
    });
    return failed ? undefined : out;
  }
  if (t === "object") {
    if (!isPlainObject(value)) {
      errors.push({
        loc,
        msg: "Input should be a valid dictionary",
        type: "dict_type",
        input: value,
        inputType: pyTypeOf(value),
      });
      return undefined;
    }
    const sub = prop.additionalProperties;
    if (sub !== null && typeof sub === "object") {
      const out: Record<string, unknown> = {};
      let failed = false;
      for (const [k, val] of Object.entries(value)) {
        const before = errors.length;
        const checked = checkValue(sub as SchemaProperty, val, errors, [...loc, k]);
        if (errors.length > before) failed = true;
        else out[k] = checked;
      }
      return failed ? undefined : out;
    }
    return { ...value };
  }
  return value;
}

export function validateToolArgs(
  toolName: string,
  schema: ToolSchema,
  rawArgs: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; text: string } {
  const args = isPlainObject(rawArgs) ? rawArgs : {};
  const errors: SingleError[] = [];
  const out: Record<string, unknown> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const present = Object.prototype.hasOwnProperty.call(args, key);
    if (!present) {
      if (required.has(key)) {
        errors.push({
          loc: [key],
          msg: "Field required",
          type: "missing",
          input: args,
          inputType: "dict",
        });
      } else if ("default" in prop) {
        out[key] = prop.default;
      }
      continue;
    }
    const before = errors.length;
    const checked = checkValue(prop, args[key], errors, [key]);
    if (errors.length === before) out[key] = checked;
  }
  if (!errors.length) return { ok: true, args: out };
  const n = errors.length;
  const blocks = errors.map((e) => {
    const locStr = e.loc.map(String).join(".");
    return `${locStr}\n  ${e.msg} [type=${e.type}, input_value=${pyRepr(e.input)}, input_type=${e.inputType}]\n    For further information visit ${ERROR_URL}/${e.type}`;
  });
  return {
    ok: false,
    text: `Error executing tool ${toolName}: ${n} validation error${n === 1 ? "" : "s"} for ${toolName}Arguments\n${blocks.join("\n")}`,
  };
}
