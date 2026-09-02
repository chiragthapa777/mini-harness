import { z } from "zod";

/**
 * JSON Schema (what MCP servers publish) → zod (what an `AgentTool` carries).
 *
 * The harness renders every tool's schema back to JSON Schema for the prompt
 * and parses model arguments through it, so the conversion only has to
 * preserve what those two steps use: field names, rough types, descriptions,
 * and which fields are required. Anything more exotic — oneOf, $ref, pattern —
 * degrades to `unknown` rather than failing, because a tool with a loose
 * schema is still usable and a tool that throws on load is not.
 */

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
}

export function jsonSchemaToZod(schema: unknown): z.ZodObject<z.ZodRawShape> {
  const root = (schema ?? {}) as JsonSchema;
  const properties = root.properties ?? {};
  const required = new Set(root.required ?? []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, property] of Object.entries(properties)) {
    const field = convert(property);
    shape[key] = required.has(key) ? field : field.optional();
  }

  return z.object(shape);
}

function convert(schema: JsonSchema): z.ZodTypeAny {
  // A union of types ("string" | "null") is not worth modelling precisely;
  // the first entry carries the useful information.
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  const base = ((): z.ZodTypeAny => {
    if (schema.enum?.length) {
      // Enums reach the model through the rendered schema, which is what
      // actually constrains it — so keep the values, not the strictness.
      return z.enum(schema.enum.map(String) as [string, ...string[]]);
    }

    switch (type) {
      case "string":
        return z.string();
      case "number":
      case "integer":
        return z.number();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(schema.items ? convert(schema.items) : z.unknown());
      case "object":
        return schema.properties ? jsonSchemaToZod(schema) : z.record(z.string(), z.unknown());
      default:
        return z.unknown();
    }
  })();

  return schema.description ? base.describe(schema.description) : base;
}
