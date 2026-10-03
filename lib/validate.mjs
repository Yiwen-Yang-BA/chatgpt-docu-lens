/** Validation shared by project handlers and model output checks. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export function assert(condition, message = "输入无效。") {
  if (!condition) throw new ValidationError(message);
}

export function text(value, label = "内容", max = 30000) {
  assert(typeof value === "string", `${label}必须是文本。`);
  const result = value.trim();
  assert(result.length > 0, `请填写${label}。`);
  assert(result.length <= max, `${label}不能超过 ${max} 个字符。`);
  return result;
}

export function enumValue(value, allowed, label = "选项") {
  assert(allowed.includes(value), `${label}无效。`);
  return value;
}

export function stringSchema(options = {}) {
  return { type: "string", ...options };
}
export function arraySchema(items, options = {}) {
  return { type: "array", items, ...options };
}
export function objectSchema(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Checks the schema subset used by these tools, including nested required types. */
export function validateSchema(value, schema, location = "$") {
  assert(schema && typeof schema === "object", "结果结构定义无效。");
  if (schema.anyOf || schema.oneOf) {
    const choices = schema.anyOf || schema.oneOf;
    const matches = choices.filter((choice) => {
      try {
        validateSchema(value, choice, location);
        return true;
      } catch {
        return false;
      }
    }).length;
    assert(
      schema.oneOf ? matches === 1 : matches > 0,
      `${location} 类型不匹配。`,
    );
  }
  if (schema.enum)
    assert(
      schema.enum.some(
        (item) => JSON.stringify(item) === JSON.stringify(value),
      ),
      `${location} 值不在允许范围。`,
    );
  if (Object.hasOwn(schema, "const"))
    assert(
      JSON.stringify(value) === JSON.stringify(schema.const),
      `${location} 值不匹配。`,
    );
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  const isType = (type) =>
    ({
      null: value === null,
      string: typeof value === "string",
      boolean: typeof value === "boolean",
      number: typeof value === "number" && Number.isFinite(value),
      integer: Number.isInteger(value),
      array: Array.isArray(value),
      object:
        value !== null && typeof value === "object" && !Array.isArray(value),
    })[type] === true;
  assert(!types.length || types.some(isType), `${location} 类型不匹配。`);
  if (value === null) return value;
  if (typeof value === "string") {
    if (schema.minLength !== undefined)
      assert(value.length >= schema.minLength, `${location} 文本太短。`);
    if (schema.maxLength !== undefined)
      assert(value.length <= schema.maxLength, `${location} 文本太长。`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined)
      assert(value >= schema.minimum, `${location} 数值太小。`);
    if (schema.maximum !== undefined)
      assert(value <= schema.maximum, `${location} 数值太大。`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined)
      assert(value.length >= schema.minItems, `${location} 项目太少。`);
    if (schema.maxItems !== undefined)
      assert(value.length <= schema.maxItems, `${location} 项目太多。`);
    if (schema.items)
      value.forEach((item, index) =>
        validateSchema(item, schema.items, `${location}[${index}]`),
      );
  } else if (typeof value === "object") {
    for (const key of schema.required || [])
      assert(Object.hasOwn(value, key), `${location}.${key} 缺失。`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key))
        validateSchema(item, schema.properties[key], `${location}.${key}`);
      else if (schema.additionalProperties === false)
        assert(false, `${location}.${key} 不属于预期结构。`);
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        validateSchema(item, schema.additionalProperties, `${location}.${key}`);
    }
  }
  return value;
}
