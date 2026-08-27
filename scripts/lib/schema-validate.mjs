// 规范校验器。此前它只存在于 contract-check 内部，于是"按记录自报的 schemaVersion 校验"这套核对
// 只能作用在契约门自己造的数据上；而真正跑出来的记录（checkpoint 的提交/推送证据、真实派发、
// 真实评审包）在 e2e 那一侧，够不着它。抽出来的唯一目的就是让 e2e 的产出也被同一套规范压一遍。
//
// 不认识的关键字要么实现、要么显式报错 —— 静默跳过会让一份看上去有约束的 schema 什么都不验。
// 同目录 $ref 一律真去加载（原先只硬编码特例了 language-policy，其余静默跳过）。
import { existsSync, readFileSync } from "node:fs";
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

// 「不受规范约束的集合数」这个棘轮有【四个调用点】：控制面 e2e、远程 agent e2e、
// 契约门的种子数据与编排产出。清掉一个集合时四处都会变，而我每次只降一个、再被下一处
// 顶红一次 —— 一步走了三轮。数字只放这一处，四个调用点都从这里取。
// 改动方式：清掉一个集合 -> 这里对应的数减一 -> 变异登记里的锚点跟着改。
// 2026-08-23：四处全部清到 0 —— 每一份真实产出里的每个非空集合都至少有记录声明了自己的规范。
// 到 0 之后这个棘轮的作用反过来了：它挡的是【新集合悄悄混进来】。
export const UNCOVERED_CEILINGS = {
  "控制面 e2e 产出": 0,
  "远程 agent e2e 产出": 0,
  "MCP e2e 产出": 0,
  "种子数据": 0,
  "编排产出": 0
};

// 凡是带 schemaVersion 的记录，一律按它【自己声明的】那份规范校验：映射取自记录自身，
// 不需要维护对照表，也就不会因为漏登记而少验一类。
export function sweepRecordsAgainstDeclaredSchemas(state, options = {}) {
  const {specDir, label = "记录", minValidated = 0, maxUncovered} = options;
  const {validateSchema} = createSchemaValidator(specDir);
  const cache = new Map();
  const output = [];
  let validated = 0;
  let selfIdentified = 0;   // 靠规范里的 const 自指认（而非 schemaVersion）验到的条数
  const loadSpec = (name) => {
    if (cache.has(name)) return cache.get(name);
    let schema = null;
    try { schema = JSON.parse(readFileSync(join(specDir, `${name}.schema.json`), "utf8")); } catch { schema = null; }
    cache.set(name, schema);
    return schema;
  };
  const declaredSchemaFor = (record) => {
    const declared = String(record?.schemaVersion || "");
    const stem = declared.replace(/\/v\d+$/u, "");
    if (!stem || stem === declared) return null; // 没有 "<名>/vN" 形状就不是可定位的规范
    return loadSpec(SCHEMA_FILE_ALIASES[stem] || stem);
  };
  // 不是所有记录都用 schemaVersion 自报家门：agentTaskContracts 用的是 contractVersion
  // （它的规范 additionalProperties:false 且根本没有 schemaVersion 这个字段，硬要求它声明
  // 等于要求记录违反自己的规范）。只认一个字段名的话，这类集合就整个悄悄退出校验 ——
  // 41 个键与规范一字不差，却一条都没被验过。
  //
  // 判据不写字段名对照表（那种表一定会漂），改成【让规范自己指认】：
  // 记录的某个字符串字段形如 "<名>/vN"，且 spec/<名>.schema.json 里【同名字段】的 const
  // 恰好等于这个取值 —— 那才算自报。同一条记录上的 protocolVersion:"control-plane/v1"
  // 因此不会被误认（没有那份规范文件，规范里也没把它钉成 const）。
  const selfIdentifiedSchemaFor = (record) => {
    for (const [field, value] of Object.entries(record)) {
      if (typeof value !== "string" || !/^[a-z0-9-]+\/v\d+$/u.test(value)) continue;
      const stem = value.replace(/\/v\d+$/u, "");
      const schema = loadSpec(SCHEMA_FILE_ALIASES[stem] || stem);
      if (schema?.properties?.[field]?.const === value) return {schema, field};
    }
    return null;
  };
  // 不带 schemaVersion 的记录会被静默跳过 —— 于是"N 条全部符合规范"读起来像全覆盖，
  // 而整整一个集合可能一条都没被看过。所以按集合记下"看没看过"，并把没看过的点名报出来。
  const uncovered = [];
  for (const [collection, items] of Object.entries(state || {})) {
    if (!Array.isArray(items)) continue;
    let objects = 0, declaring = 0;
    for (const [index, item] of items.entries()) {
      if (!item || typeof item !== "object") continue;
      objects += 1;
      if (!item.schemaVersion) {
        const alternate = selfIdentifiedSchemaFor(item);
        if (!alternate) continue;
        declaring += 1;
        validated += 1;
        selfIdentified += 1;
        validateSchema(item, alternate.schema, `${label}.${collection}[${index}]`, output);
        continue;
      }
      declaring += 1;
      const schema = declaredSchemaFor(item);
      if (!schema) {
        output.push(`${label} ${collection}[${index}] 声明 schemaVersion "${item.schemaVersion}"，但 spec 下没有对应的规范文件 —— 这条记录声称遵守一份不存在的契约`);
        continue;
      }
      validated += 1;
      validateSchema(item, schema, `${label}.${collection}[${index}]`, output);
    }
    if (objects && !declaring) uncovered.push({collection, count: objects, spec: specFileFor(collection, specDir)});
    // 部分带、部分不带最危险：按 schemaVersion 派发的校验把不带的那些【静默跳过】，
    // 而报数只会说"N 条全部合规"。同一个集合有几个写入点时，漏掉一个就是这个样子 ——
    // 那一整条写路径从此不受规范约束，门照样绿。（此前只有契约门查这一项，两套 e2e 没查。）
    if (declaring && declaring < objects) {
      output.push(`${label} ${collection}：${objects} 条里有 ${objects - declaring} 条没有 schemaVersion —— `
        + "按记录自身规范派发的校验会把这几条静默跳过，而它们恰恰是最可能漂了的那几条"
        + "（多半是某个写入点没跟上）");
    }
  }
  // 规范存在、记录却不声明它 = 接线断了：这类记录本来验得了，现在一条都不验，而门照样绿。
  // （少一个 schemaVersion 赋值就会变成这样，minValidated 只在总量掉很多时才拦得住。）
  for (const {collection, count, spec} of uncovered) {
    if (spec) {
      output.push(`${label} ${collection}（${count} 条）没有任何记录声明 schemaVersion，而 spec/${spec}.schema.json 是存在的`
        + " —— 这一整个集合因此退出了规范校验，接线断了");
    }
  }
  // 「没有任何记录声明规范」的集合数要棘轮住。有规范文件的那些上面已经直接报错了；
  // 剩下这些是【连规范文件都没有】的 —— 新集合可以静默混进来，从此不受任何规范约束，
  // 而这一行只是打印一句"本次未核对"，读起来像一句无害的说明。
  if (Number.isFinite(maxUncovered) && uncovered.length > maxUncovered) {
    const added = uncovered.map((item) => item.collection).sort().join("、");
    output.push(`${label}：不受规范约束的集合从 ${maxUncovered} 涨到 ${uncovered.length} —— `
      + `新集合要么补一份 spec，要么明确它为什么不需要（当前清单：${added}）`);
  }
  if (Number.isFinite(maxUncovered) && uncovered.length < maxUncovered) {
    output.push(`${label}：不受规范约束的集合已降到 ${uncovered.length}（棘轮还写着 ${maxUncovered}）—— `
      + "把它改小，否则它挡不住下一次回升");
  }
  if (validated < minValidated) {
    output.push(`${label}规范核对只校验到 ${validated} 条记录，远少于预期的 ${minValidated} —— 提取逻辑已与数据结构脱节，本条可能在空转`);
  }
  // 「把 undefined 拼进字符串」这一族：`account:${x}` 里 x 是 undefined 时，得到的不是空、
  // 不是报错，而是一个长得很正常的值 "account:undefined"。它随记录一路展示，看起来像署名/像证据。
  // 2026-08-23 这道扫描一上来就抓到两处真缺陷：房间消息的署名（accountFromRequest 返回的是
  // {session, account}，账号 id 在里层，取到了 undefined），以及每一个检查点的改动证据
  // （校验函数根本没把 finalCommit 带出来，于是 "git-diff:<base>:undefined"）。
  // 同族还有 [object Object]（把对象拼进串）与 NaN（把算坏的数拼进串）。
  {
    const suspicious = /undefined|\[object Object\]|\bNaN\b/u;
    const byField = new Map();
    const walk = (node, path, depth) => {
      if (depth > 12 || byField.size > 40) return;
      if (typeof node === "string") {
        if (suspicious.test(node)) {
          const key = path.replace(/\[\d+\]/gu, "[]");
          if (!byField.has(key)) byField.set(key, node.slice(0, 80));
        }
        return;
      }
      if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1)); return; }
      if (node && typeof node === "object") { for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`, depth + 1); }
    };
    walk(state || {}, label, 0);
    for (const [field, sample] of byField) {
      output.push(`${field} 里拼进了 undefined / [object Object] / NaN：「${sample}」 —— `
        + "这不是空值也不是报错，它长得像一个正常的值，会一路展示给人看");
    }
  }

  // 这条数要露在外面：靠 const 自指认的那条路一旦断了（改个字段名、规范里的 const 没了），
  // 表现是"少验了一整个集合"而不是报错 —— 数掉到 0 才看得出来。
  return {errors: output, validated, selfIdentified, uncovered,
    uncoveredNote: uncoveredNote(uncovered) + (selfIdentified ? `；其中 ${selfIdentified} 条不带 schemaVersion，是靠规范里的 const 自指认认出来的` : "")};
}

// 集合名 → 规范文件名：taskGroups→task-group、policies→policy。只用来回答"这个集合本来验得了吗"。
// 判据不是"规范文件存不存在"，而是【那份规范自己用不用 schemaVersion 自识别】：
// agent-task-contract 就是 additionalProperties:false 且根本没有 schemaVersion 字段
// （它用 contractVersion），按"文件存在就该声明"去要求，等于要求记录违反自己的规范 ——
// 我第一版就是这么写的，当场造出一条假红。
function specFileFor(collection, specDir) {
  const kebab = collection.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
  for (const candidate of [kebab.replace(/ies$/u, "y"), kebab.replace(/s$/u, ""), kebab]) {
    const file = join(specDir, `${candidate}.schema.json`);
    if (!existsSync(file)) continue;
    try {
      if (JSON.parse(readFileSync(file, "utf8"))?.properties?.schemaVersion) return candidate;
    } catch { /* 规范读不出来就当它不适用，坏文件由别的门去报 */ }
    return null;
  }
  return null;
}

// 报数必须自己说清没看过什么，否则"0 条不符"和"查过了"长得一样。
function uncoveredNote(uncovered) {
  if (!uncovered.length) return "所有非空集合都至少有记录声明了规范";
  const names = uncovered.map(({collection, count}) => `${collection}(${count})`).join("、");
  return `另有 ${uncovered.length} 个集合没有任何记录声明规范（要么没有规范文件，要么那份规范本就不用 schemaVersion 自识别），本次未核对：${names}`;
}
