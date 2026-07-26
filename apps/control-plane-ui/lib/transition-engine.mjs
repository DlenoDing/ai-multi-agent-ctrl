import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runtime parser + resolution engine for spec/state-machines.yaml and spec/gates.yaml.
// This project deliberately ships zero external dependencies, so this module implements a
// small, fail-closed YAML subset reader that only covers the structures the two spec files
// actually use (2-space indentation, "- " block sequences, `key: "value"` scalars, nested
// maps, and inline `["a", "b"]` flow sequences). Any unexpected structure throws.

const controlPlaneRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const parseCache = new Map();

export class TransitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
    this.failureCode = details.failureCode || code;
    this.details = details;
  }
}

function failClosed(message) {
  throw new TransitionError("spec.parse_error", `state-machine spec parse error: ${message}`);
}

// --- zero-dependency YAML subset reader -------------------------------------------------

function toLines(yamlText) {
  const lines = [];
  const rawLines = yamlText.split(/\r?\n/);
  for (const raw of rawLines) {
    if (/^\s*$/.test(raw)) continue; // skip blank lines
    if (/^\s*#/.test(raw)) continue; // skip comment-only lines
    if (raw.includes("\t")) failClosed("tab indentation is not supported");
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) failClosed(`indentation must be a multiple of 2: "${raw}"`);
    lines.push({ indent, text: raw.trim() });
  }
  return lines;
}

function splitFlow(inner) {
  const parts = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      inString = !inString;
      current += ch;
      continue;
    }
    if (ch === "," && !inString) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function parseFlowSequence(str) {
  const inner = str.slice(1, -1).trim();
  if (inner === "") return [];
  return splitFlow(inner).map((item) => parseScalar(item.trim()));
}

function parseScalar(str) {
  const value = str.trim();
  if (value === "") return null;
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) failClosed(`malformed inline sequence: "${str}"`);
    return parseFlowSequence(value);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) failClosed(`malformed quoted scalar: "${str}"`);
    try {
      return JSON.parse(value);
    } catch {
      failClosed(`malformed quoted scalar: "${str}"`);
    }
  }
  return value; // bareword scalar
}

function parseNode(lines, index, indent) {
  if (index >= lines.length || lines[index].indent < indent) return [null, index];
  if (lines[index].indent !== indent) failClosed(`unexpected indentation at "${lines[index].text}"`);
  const text = lines[index].text;
  if (text === "-" || text.startsWith("- ")) return parseSequence(lines, index, indent);
  return parseMapping(lines, index, indent);
}

function parseSequence(lines, index, indent) {
  const items = [];
  let i = index;
  while (i < lines.length && lines[i].indent === indent && (lines[i].text === "-" || lines[i].text.startsWith("- "))) {
    const text = lines[i].text;
    const rest = text === "-" ? "" : text.slice(2).trim();
    if (rest === "") {
      // Nested block belongs to this item on the following, more-indented lines.
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        const [child, next] = parseNode(lines, i, lines[i].indent);
        items.push(child);
        i = next;
      } else {
        items.push(null);
      }
      continue;
    }
    if (/^[^:\s][^:]*:(\s|$)/.test(rest)) {
      // Map item that begins inline after "- "; align its keys to indent + 2.
      const childIndent = indent + 2;
      lines[i] = { indent: childIndent, text: rest };
      const [map, next] = parseMapping(lines, i, childIndent);
      items.push(map);
      i = next;
      continue;
    }
    items.push(parseScalar(rest));
    i += 1;
  }
  return [items, i];
}

function parseMapping(lines, index, indent) {
  const map = {};
  let i = index;
  while (i < lines.length && lines[i].indent === indent && !(lines[i].text === "-" || lines[i].text.startsWith("- "))) {
    const text = lines[i].text;
    const match = text.match(/^([^:]+):(.*)$/);
    if (!match) failClosed(`invalid mapping entry: "${text}"`);
    const key = match[1].trim();
    const valuePart = match[2].trim();
    i += 1;
    if (valuePart === "") {
      if (i < lines.length && lines[i].indent > indent) {
        const [child, next] = parseNode(lines, i, lines[i].indent);
        map[key] = child;
        i = next;
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalar(valuePart);
    }
  }
  return [map, i];
}

function parseYamlSubset(yamlText) {
  const lines = toLines(yamlText);
  if (lines.length === 0) return {};
  const [value, next] = parseNode(lines, 0, 0);
  if (next !== lines.length) failClosed(`unexpected trailing content at "${lines[next]?.text}"`);
  return value;
}

function loadSpec(relativePath) {
  if (parseCache.has(relativePath)) return parseCache.get(relativePath);
  let parsed;
  try {
    parsed = parseYamlSubset(readFileSync(join(controlPlaneRoot, relativePath), "utf8"));
  } catch (error) {
    if (error instanceof TransitionError) throw error;
    throw new TransitionError("spec.load_error", `failed to load ${relativePath}: ${error.message}`);
  }
  parseCache.set(relativePath, parsed);
  return parsed;
}

// --- public spec loaders ----------------------------------------------------------------

export function loadStateMachines() {
  const doc = loadSpec("spec/state-machines.yaml");
  if (!doc || typeof doc !== "object" || !doc.machines || typeof doc.machines !== "object") {
    failClosed("state-machines.yaml missing machines map");
  }
  return doc;
}

export function loadGateCatalog() {
  const doc = loadSpec("spec/gates.yaml");
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.resolvers)) {
    failClosed("gates.yaml missing resolvers list");
  }
  return doc;
}

// --- gate resolution --------------------------------------------------------------------

// resolverSelection: first_matching_specificity — exact-id resolvers win over pattern
// resolvers, and within each class the first one listed in the catalog wins.
export function resolveGate(gateId, catalog = loadGateCatalog()) {
  const resolvers = catalog.resolvers || [];
  for (const resolver of resolvers) {
    const exactIds = resolver?.match?.exactIds;
    if (Array.isArray(exactIds) && exactIds.includes(gateId)) return resolver;
  }
  for (const resolver of resolvers) {
    const pattern = resolver?.match?.pattern;
    if (typeof pattern === "string" && pattern.length) {
      let regex;
      try {
        regex = new RegExp(pattern);
      } catch (error) {
        throw new TransitionError("gate.resolver_invalid_regex", `resolver ${resolver.id} has invalid regex: ${error.message}`, { gateId });
      }
      if (regex.test(gateId)) return resolver;
    }
  }
  // unresolvedGate: reject_transition
  throw new TransitionError("gate.unresolved", `no resolver matches gate "${gateId}"`, { gateId });
}

// --- transition assertion ---------------------------------------------------------------

export function canonicalTransition(machineName, from, to) {
  const machine = loadStateMachines().machines[machineName];
  if (!machine) return undefined;
  return (machine.transitions || []).find((transition) => transition.from === from && transition.to === to);
}

function normalizeRequiresValues(requiresValues, requires) {
  if (requiresValues instanceof Map) return requiresValues;
  if (Array.isArray(requiresValues)) {
    return new Map(requires.map((gateId, position) => [gateId, requiresValues[position]]));
  }
  if (requiresValues && typeof requiresValues === "object") {
    return new Map(Object.entries(requiresValues));
  }
  return new Map();
}

function isNonEmptyEvidence(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => isNonEmptyEvidence(item));
  return String(value).trim().length > 0;
}

// assertTransition enforces core-control-plane-spec §8 rule 6 at runtime:
//  (a) from/to must be declared states of the machine;
//  (b) a modeled transition must exist for (from, to, actor);
//  (c) every `requires` gate must resolve through the gate catalog and have non-empty
//      corresponding evidence in requiresValues.
// On failure it throws a TransitionError carrying a failureCode.
export function assertTransition(state, machineName, from, to, actor, requiresValues = {}) {
  const machines = loadStateMachines().machines;
  const machine = machines[machineName];
  if (!machine) {
    throw new TransitionError("transition.unknown_machine", `unknown state machine "${machineName}"`, { machineName });
  }
  const states = Array.isArray(machine.states) ? machine.states : [];
  if (!states.includes(from)) {
    throw new TransitionError("transition.unknown_from_state", `${machineName}: "${from}" is not a declared state`, { machineName, from });
  }
  if (!states.includes(to)) {
    throw new TransitionError("transition.unknown_to_state", `${machineName}: "${to}" is not a declared state`, { machineName, to });
  }
  const candidates = (machine.transitions || []).filter((transition) => transition.from === from && transition.to === to);
  if (candidates.length === 0) {
    throw new TransitionError("transition.not_modeled", `${machineName}: no modeled transition ${from}->${to}`, { machineName, from, to });
  }
  const modeled = candidates.find((transition) => transition.actor === actor);
  if (!modeled) {
    throw new TransitionError(
      "transition.actor_not_authorized",
      `${machineName}: actor "${actor}" may not perform ${from}->${to}`,
      { machineName, from, to, actor, expectedActors: candidates.map((transition) => transition.actor) }
    );
  }
  const catalog = loadGateCatalog();
  const requires = Array.isArray(modeled.requires) ? modeled.requires : [];
  const values = normalizeRequiresValues(requiresValues, requires);
  for (const gateId of requires) {
    const resolver = resolveGate(gateId, catalog); // throws gate.unresolved when unmatched
    if (!isNonEmptyEvidence(values.get(gateId))) {
      throw new TransitionError(
        resolver.failureCode || "transition.requires_evidence_missing",
        `${machineName}: transition ${from}->${to} is missing evidence for gate "${gateId}"`,
        { machineName, from, to, gateId, failureCode: resolver.failureCode }
      );
    }
  }
  return { machine: machineName, from, to, actor, requires };
}

// Flatten a requiresValues map/object/array into the flat evidenceRefs array persisted on
// transitionEvidence records (kept as an array for backward-compatible consumers).
export function requiresValuesToEvidenceRefs(requiresValues) {
  if (Array.isArray(requiresValues)) {
    return requiresValues.filter((item) => isNonEmptyEvidence(item)).map((item) => String(item));
  }
  if (requiresValues instanceof Map) {
    return [...requiresValues.entries()]
      .filter(([, value]) => isNonEmptyEvidence(value))
      .map(([gateId, value]) => `${gateId}:${String(value)}`);
  }
  if (requiresValues && typeof requiresValues === "object") {
    return Object.entries(requiresValues)
      .filter(([, value]) => isNonEmptyEvidence(value))
      .map(([gateId, value]) => `${gateId}:${String(value)}`);
  }
  return [];
}
