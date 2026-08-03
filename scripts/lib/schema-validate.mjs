// 规范校验器。此前它只存在于 contract-check 内部，于是"按记录自报的 schemaVersion 校验"这套核对
// 只能作用在契约门自己造的数据上；而真正跑出来的记录（checkpoint 的提交/推送证据、真实派发、
// 真实评审包）在 e2e 那一侧，够不着它。抽出来的唯一目的就是让 e2e 的产出也被同一套规范压一遍。
//
// 不认识的关键字要么实现、要么显式报错 —— 静默跳过会让一份看上去有约束的 schema 什么都不验。
// 同目录 $ref 一律真去加载（原先只硬编码特例了 language-policy，其余静默跳过）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function createSchemaValidator(specDir) {
  const siblingCache = new Map();
  function siblingSchema(fileName) {
    if (siblingCache.has(fileName)) return siblingCache.get(fileName);
    let loaded = null;
    try { loaded = JSON.parse(readFileSync(join(specDir, fileName), "utf8")); } catch { loaded = null; }
    siblingCache.set(fileName, loaded);
    return loaded;
  }

  function resolveInternalRef(ref, root) {
    const parts = ref.slice(2).split("/");
    let node = root;
    for (const part of parts) {
      if (node == null || typeof node !== "object") return null;
      node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return node && typeof node === "object" ? node : null;
  }

  // True iff `value` satisfies `schema` with zero errors — used to evaluate if/then/else, not, any/oneOf.
  function schemaMatches(value, schema, root, depth) {
    const scratch = [];
    validateSchema(value, schema, "", scratch, root, depth);
    return scratch.length === 0;
  }

  // A pragmatic JSON-Schema subset validator. Supports const/enum/type/minLength/minimum, array
  // items/minItems/uniqueItems/contains, object required/properties/additionalProperties, the
  // combinators allOf/anyOf/oneOf/if-then-else/not, and local $ref (#/$defs/...). This breadth matters:
  // the conditional guarantees (e.g. a subagent placement REQUIRING subagentSafetyProof with every safety
  // flag true, or CloseBarrier.satisfied implying all gates passed) live in allOf/if/then/$ref — a
  // validator that skipped those keywords validated nothing and let a regressed producer pass silently.
  function validateSchema(value, schema, path, output, root, depth = 0) {
    if (!schema || typeof schema !== "object") return;
    if (root === undefined) root = schema;
    // A $ref is the only unbounded-recursion vector; bound the follow depth so a (mistakenly) self- or
    // cyclically-referential schema fails loudly instead of hanging the gate.
    if (depth > 256) { output.push(`${path} $ref recursion too deep (possible schema cycle)`); return; }
    if (schema.$ref !== undefined) {
      if (schema.$ref.startsWith("#/")) {
        const resolved = resolveInternalRef(schema.$ref, root);
        // Unresolvable local $ref must ERROR, not silently pass — a typo'd pointer would otherwise validate
        // nothing (re-introducing the vacuous-gate class this validator was completed to prevent).
        if (resolved) validateSchema(value, resolved, path, output, root, depth + 1);
        else output.push(`${path} unresolved local $ref ${schema.$ref}`);
        return;
      }
      // 同目录的 schema 一律真去加载。原先只特例了 language-policy，其余外部 $ref 静默跳过 ——
      // 于是 checkpoint 的 commitRefs / pushRefs（关闭门赖以判定的提交与推送证据）整块没人校验：
      // 引用写在那里，看上去有约束，实际什么都不验。"解析不了就跳过"必须是解析不了才跳过，
      // 而不是"没写特例就跳过"；同目录文件明明加载得到。
      if (/^[a-z0-9-]+\.schema\.json$/u.test(schema.$ref)) {
        const sibling = siblingSchema(schema.$ref);
        if (sibling) { validateSchema(value, sibling, path, output, sibling, depth + 1); return; }
        output.push(`${path} 引用了不存在的同目录 schema ${schema.$ref}`);
        return;
      }
      return; // unknown external ref: not resolvable here, skip
    }
    if (schema.const !== undefined && value !== schema.const) output.push(`${path} expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    if (schema.enum && !schema.enum.includes(value)) output.push(`${path} expected enum ${schema.enum.join("|")}, got ${JSON.stringify(value)}`);
    if (schema.type) validateType(value, schema.type, path, output);
    if (schema.type === "string" && schema.minLength && String(value || "").length < schema.minLength) output.push(`${path} expected minLength ${schema.minLength}`);
    // pattern 此前完全没有实现，而 spec 里 37 份 schema 用了它、共 93 处 —— 那些约束一直在验空气：
    // 产出方写出格式不合法的 id / 摘要 / 引用，这道门照样是绿的。反向更隐蔽：{not: {pattern}} 的
    // 内层因为没有任何可判定关键字而恒为"匹配"，于是每一个合法值都被判成违规（假红）。
    // 不认识的关键字必须要么实现、要么显式报错，不能当成"通过"。
    if (schema.pattern !== undefined && typeof value === "string") {
      let regex = null;
      try { regex = new RegExp(schema.pattern, "u"); }
      catch { try { regex = new RegExp(schema.pattern); } catch { output.push(`${path} schema 的 pattern 不是合法正则：${schema.pattern}`); } }
      if (regex && !regex.test(value)) output.push(`${path} 不匹配 pattern ${schema.pattern}（实得 ${JSON.stringify(String(value).slice(0, 80))}）`);
    }
    if ((schema.type === "integer" || schema.type === "number") && schema.minimum !== undefined && Number(value) < schema.minimum) output.push(`${path} expected minimum ${schema.minimum}`);
    // Array keywords apply to any array instance (not gated on a declared type — the `contains` subschema
    // under the placement `not` clause declares no type).
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) output.push(`${path} expected minItems ${schema.minItems}`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) output.push(`${path} expected maxItems ${schema.maxItems}, got ${value.length}`);
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) output.push(`${path} expected uniqueItems`);
      if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, output, root, depth));
      if (schema.contains && !value.some((item) => schemaMatches(item, schema.contains, root, depth))) output.push(`${path} expected at least one item matching contains`);
    }
    // Object keywords apply to any object instance (an if/then subschema carries required/properties with
    // no declared type; gating on schema.type==="object" would make every if-condition vacuously match).
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of schema.required || []) {
        if (value[key] === undefined) output.push(`${path}.${key} is required`);
      }
      const properties = schema.properties || {};
      const patternProperties = schema.patternProperties || {};
      const patternRegexes = Object.keys(patternProperties).map((pattern) => new RegExp(pattern));
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          const known = Object.prototype.hasOwnProperty.call(properties, key) || patternRegexes.some((re) => re.test(key));
          if (!known) output.push(`${path}.${key} is not allowed by schema`);
        }
      }
      for (const [key, childSchema] of Object.entries(properties)) {
        if (value[key] !== undefined) validateSchema(value[key], childSchema, `${path}.${key}`, output, root, depth);
      }
      for (const [pattern, childSchema] of Object.entries(patternProperties)) {
        const re = new RegExp(pattern);
        for (const key of Object.keys(value)) {
          if (re.test(key)) validateSchema(value[key], childSchema, `${path}.${key}`, output, root, depth);
        }
      }
    }
    if (Array.isArray(schema.allOf)) schema.allOf.forEach((sub, index) => validateSchema(value, sub, `${path}/allOf[${index}]`, output, root, depth));
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => schemaMatches(value, sub, root, depth))) output.push(`${path} matched no anyOf branch`);
    if (Array.isArray(schema.oneOf)) {
      const matched = schema.oneOf.filter((sub) => schemaMatches(value, sub, root, depth)).length;
      if (matched !== 1) output.push(`${path} expected exactly one oneOf match, got ${matched}`);
    }
    if (schema.if) {
      if (schemaMatches(value, schema.if, root, depth)) { if (schema.then) validateSchema(value, schema.then, path, output, root, depth); }
      else if (schema.else) validateSchema(value, schema.else, path, output, root, depth);
    }
    if (schema.not && schemaMatches(value, schema.not, root, depth)) output.push(`${path} must not match the not-subschema`);
  }

  function validateType(value, type, path, output) {
    if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) output.push(`${path} expected object`);
    if (type === "array" && !Array.isArray(value)) output.push(`${path} expected array`);
    if (type === "string" && typeof value !== "string") output.push(`${path} expected string`);
    if (type === "boolean" && typeof value !== "boolean") output.push(`${path} expected boolean`);
    if (type === "integer" && !Number.isInteger(value)) output.push(`${path} expected integer`);
    if (type === "number" && typeof value !== "number") output.push(`${path} expected number`);
  }
  return {validateSchema, schemaMatches, siblingSchema};
}

// 记录自报的名字与规范文件名不一致时必须显式登记 —— 靠拼写巧合匹配的话，一次改名就会让
// 整类记录悄悄退出校验，而门依然是绿的。
export const SCHEMA_FILE_ALIASES = {"control-event": "control-events"};

// 凡是带 schemaVersion 的记录，一律按它【自己声明的】那份规范校验：映射取自记录自身，
// 不需要维护对照表，也就不会因为漏登记而少验一类。
export function sweepRecordsAgainstDeclaredSchemas(state, options = {}) {
  const {specDir, label = "记录", minValidated = 0} = options;
  const {validateSchema} = createSchemaValidator(specDir);
  const cache = new Map();
  const output = [];
  let validated = 0;
  const declaredSchemaFor = (record) => {
    const declared = String(record?.schemaVersion || "");
    const stem = declared.replace(/\/v\d+$/u, "");
    if (!stem || stem === declared) return null; // 没有 "<名>/vN" 形状就不是可定位的规范
    const name = SCHEMA_FILE_ALIASES[stem] || stem;
    if (cache.has(name)) return cache.get(name);
    let schema = null;
    try { schema = JSON.parse(readFileSync(join(specDir, `${name}.schema.json`), "utf8")); } catch { schema = null; }
    cache.set(name, schema);
    return schema;
  };
  for (const [collection, items] of Object.entries(state || {})) {
    if (!Array.isArray(items)) continue;
    for (const [index, item] of items.entries()) {
      if (!item || typeof item !== "object" || !item.schemaVersion) continue;
      const schema = declaredSchemaFor(item);
      if (!schema) {
        output.push(`${label} ${collection}[${index}] 声明 schemaVersion "${item.schemaVersion}"，但 spec 下没有对应的规范文件 —— 这条记录声称遵守一份不存在的契约`);
        continue;
      }
      validated += 1;
      validateSchema(item, schema, `${label}.${collection}[${index}]`, output);
    }
  }
  if (validated < minValidated) {
    output.push(`${label}规范核对只校验到 ${validated} 条记录，远少于预期的 ${minValidated} —— 提取逻辑已与数据结构脱节，本条可能在空转`);
  }
  return {errors: output, validated};
}
