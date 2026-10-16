// WHY: a tool call's arguments must fit the input schema that was approved, so a poisoned description can't get the
// model to pass along a field the approved tool never had. This is a deliberately small JSON Schema subset: type,
// properties, required, additionalProperties, items, enum, const, minLength/maxLength, minimum/maximum. A schema that
// uses any other keyword is still served as approved, but the broker can't enforce that keyword, and approval lists it
// (unenforced()) so the owner knows.
const ENFORCED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'description', 'title', '$schema', 'default', 'examples']);

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The keywords anywhere in `schema` that the broker does not enforce. */
export function unenforced(schema: unknown, at = '$'): string[] {
  if (!isObj(schema)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(schema)) {
    if (!ENFORCED.has(k)) out.push(`${at}.${k}`);
    if (k === 'properties' && isObj(v)) for (const [p, s] of Object.entries(v)) out.push(...unenforced(s, `${at}.properties.${p}`));
    if ((k === 'items' || k === 'additionalProperties') && isObj(v)) out.push(...unenforced(v, `${at}.${k}`));
  }
  return out;
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const typeOk = (want: unknown, v: unknown): boolean => {
  const list = Array.isArray(want) ? want : [want];
  const t = typeOf(v);
  return list.some((w) => w === t || (w === 'number' && t === 'integer'));
};

/** Why `value` doesn't fit `schema` (the subset above), or null. */
export function schemaProblem(schema: unknown, value: unknown, at = '$'): string | null {
  if (schema === true || schema === undefined || (isObj(schema) && Object.keys(schema).length === 0)) return null;
  if (schema === false) return `${at}: not allowed`;
  if (!isObj(schema)) return null;
  const s = schema as Schema;
  if (s.type !== undefined && !typeOk(s.type, value)) return `${at}: expected ${JSON.stringify(s.type)}, got ${typeOf(value)}`;
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `${at}: not one of the allowed values`;
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) return `${at}: not the allowed value`;
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) return `${at}: shorter than ${s.minLength}`;
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) return `${at}: longer than ${s.maxLength}`;
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return `${at}: below ${s.minimum}`;
    if (typeof s.maximum === 'number' && value > s.maximum) return `${at}: above ${s.maximum}`;
  }
  if (isObj(value)) {
    const props = isObj(s.properties) ? s.properties : {};
    for (const r of Array.isArray(s.required) ? s.required : []) if (typeof r === 'string' && !(r in value)) return `${at}.${r}: required`;
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        const p = schemaProblem(props[k], v, `${at}.${k}`);
        if (p) return p;
      } else if (s.additionalProperties === false) return `${at}.${k}: not in the approved schema`;
      else if (isObj(s.additionalProperties)) {
        const p = schemaProblem(s.additionalProperties, v, `${at}.${k}`);
        if (p) return p;
      }
    }
  }
  if (Array.isArray(value) && s.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const p = schemaProblem(s.items, value[i], `${at}[${i}]`);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Why a tool call's arguments don't fit its approved input schema, or null. Beyond the schema itself, arguments must be
 * an object, and a property the approved schema doesn't name is refused even when the schema leaves additional
 * properties open: a field nobody approved is how a poisoned description smuggles data out.
 */
export function argumentsProblem(inputSchema: unknown, args: unknown): string | null {
  if (args === undefined) args = {};
  if (!isObj(args)) return 'arguments must be an object';
  const props = isObj(inputSchema) && isObj(inputSchema.properties) ? inputSchema.properties : {};
  const extra = Object.keys(args).filter((k) => !(k in props));
  if (extra.length) return `arguments ${extra.join(', ')} are not in the approved schema`;
  return schemaProblem(inputSchema, args);
}
