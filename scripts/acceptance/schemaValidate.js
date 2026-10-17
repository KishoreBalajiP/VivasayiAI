// A small, strict JSON Schema (draft 2020-12) validator for the acceptance results file.
//
// The repo has no JSON Schema dependency and this stage adds none, so this covers exactly the keywords
// results.schema.json uses. Any other keyword in a schema throws instead of being silently ignored, so a
// schema edit can never weaken validation without someone noticing.

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$comment", "default", "examples", "$defs"]);
const KEYWORDS = new Set([
  "type", "const", "enum", "required", "properties", "additionalProperties", "items",
  "pattern", "minLength", "minimum", "minItems", "$ref", "anyOf", "oneOf",
]);

const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const matchesType = (value, type) => {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeOf(value) === "object";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    default: throw new Error(`schemaValidate: unsupported type "${type}"`);
  }
};

const resolveRef = (root, ref) => {
  if (!ref.startsWith("#/")) throw new Error(`schemaValidate: only local $ref is supported, got "${ref}"`);
  return ref.slice(2).split("/").reduce((node, part) => {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || !(key in node)) throw new Error(`schemaValidate: unresolved $ref "${ref}"`);
    return node[key];
  }, root);
};

const validateNode = (root, schema, value, path, errors) => {
  if (schema === true) return;
  if (schema === false) { errors.push(`${path}: no value is allowed here`); return; }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`schemaValidate: unsupported keyword "${key}" at ${path}`);
  }
  if (schema.$ref) validateNode(root, resolveRef(root, schema.$ref), value, path, errors);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${typeOf(value)}`);
      return;
    }
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: below minimum ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items !== undefined) value.forEach((item, index) => validateNode(root, schema.items, item, `${path}[${index}]`, errors));
  }
  if (typeOf(value) === "object") {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) validateNode(root, properties[key], child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
      else if (typeOf(schema.additionalProperties) === "object") validateNode(root, schema.additionalProperties, child, `${path}.${key}`, errors);
    }
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((option) => { const sub = []; validateNode(root, option, value, path, sub); return sub.length === 0; });
    if (!ok) errors.push(`${path}: matches none of anyOf`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((option) => { const sub = []; validateNode(root, option, value, path, sub); return sub.length === 0; }).length;
    if (matches !== 1) errors.push(`${path}: matches ${matches} of oneOf (expected exactly 1)`);
  }
};

// Returns { valid, errors[] }. Throws only when the schema itself uses something this validator does not support.
export const validateAgainstSchema = (schema, value) => {
  const errors = [];
  validateNode(schema, schema, value, "$", errors);
  return { valid: errors.length === 0, errors };
};
