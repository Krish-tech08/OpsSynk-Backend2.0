import type { ZodTypeAny, z } from "zod";
import { Errors } from "../utils/errors.js";

/** Parse untrusted input with a Zod schema; failures become a 400 with field-level issues. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}
