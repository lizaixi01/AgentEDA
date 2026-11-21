/** Minimal zod -> JSON Schema for the flat shapes used by our tools (string/number/boolean, optional). */
import { z } from "zod"

export function zodToJsonSchema(shape: z.ZodRawShape) {
  const properties: Record<string, any> = {}
  const required: string[] = []
  for (const [key, schema] of Object.entries(shape) as [string, z.ZodTypeAny][]) {
    let s: any = schema
    const optional = schema.isOptional()
    const description = s.description
    while (s?._def?.innerType) s = s._def.innerType
    const t = s?._def?.typeName
    const prop: any = {}
    if (t === "ZodNumber") {
      const isInt = (s._def.checks ?? []).some((c: any) => c.kind === "int")
      prop.type = isInt ? "integer" : "number"
      for (const c of s._def.checks ?? []) {
        if (c.kind === "min") prop.minimum = c.value
        if (c.kind === "max") prop.maximum = c.value
      }
    } else if (t === "ZodBoolean") prop.type = "boolean"
    else prop.type = "string"
    const desc = description ?? s.description
    if (desc) prop.description = desc
    properties[key] = prop
    if (!optional) required.push(key)
  }
  return { type: "object" as const, properties, required, additionalProperties: false }
}
