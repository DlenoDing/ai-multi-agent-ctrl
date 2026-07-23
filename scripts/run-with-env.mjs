#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , target, ...targetArgs] = process.argv;
if (!target) {
  console.error("usage: node scripts/run-with-env.mjs <script.mjs> [args...]");
  process.exit(64);
}

loadDotEnv(resolve(process.cwd(), ".env"));

const targetPath = resolve(process.cwd(), target);
process.argv = [process.argv[0], targetPath, ...targetArgs];
await import(pathToFileURL(targetPath).href);

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const [, key, valueRaw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(valueRaw.trim());
  }
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s#/u);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}
