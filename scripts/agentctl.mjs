#!/usr/bin/env node
const args = parseArgs(process.argv.slice(2));
const action = args._.join(" ");
const serverUrl = String(args.server || process.env.AIMAC_PUBLIC_URL || "http://127.0.0.1:4317").replace(/\/+$/u, "");

if (action !== "join-token create" && action !== "nodes list" && action !== "doctor") {
  throw new Error("usage: agentctl join-token create|nodes list|doctor --server=<url> [options]");
}

if (action === "doctor") {
  const health = await request("/api/health");
  const manifest = await request("/api/agent/v1/bootstrap-manifest");
  if (health.mcp?.transport !== "streamable-http" || manifest.localMcpServerAllowed !== false) throw new Error("server is not configured for centralized MCP and lightweight Agent Runtime");
  console.log(`agent gateway doctor ok: ${manifest.serverUrl}`);
  process.exit(0);
}

const sessionToken = args["session-token"] || process.env.AIMAC_SESSION_TOKEN || await login();

if (action === "nodes list") {
  const nodes = await request("/api/agent-nodes", {token: sessionToken});
  console.log(JSON.stringify(nodes, null, 2));
  process.exit(0);
}

const projectId = args.project || args["project-id"];
if (!projectId) throw new Error("--project is required");
const result = await request("/api/agent-join-tokens", {
  method: "POST",
  token: sessionToken,
  idempotencyKey: args["idempotency-key"] || `agentctl-${Date.now()}`,
  body: {
    projectId,
    nodeName: args["node-name"] || undefined,
    allowedRoles: args.roles ? String(args.roles).split(",").map((item) => item.trim()).filter(Boolean) : ["agent-runtime"],
    ttlSeconds: parseDurationSeconds(args.ttl || 1800),
    maxUses: Number(args["max-uses"] || 1)
  }
});
console.log(args.verified ? result.verifiedInstallCommand : result.installCommand);
console.log(`joinTokenId=${result.joinTokenRecord.joinTokenId}`);
console.log(`expiresAt=${result.joinTokenRecord.expiresAt}`);

async function login() {
  const email = args.email || process.env.AIMAC_ADMIN_EMAIL || "system.admin@local";
  const token = args.token || process.env.AIMAC_ADMIN_TOKEN || process.env.AIMAC_BOOTSTRAP_TOKEN;
  if (!token) throw new Error("--session-token or --token/AIMAC_ADMIN_TOKEN is required");
  const result = await request("/api/auth/login", {method: "POST", body: {email, token}});
  return result.sessionToken;
}

async function request(path, options = {}) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {
      accept: "application/json",
      ...(options.body ? {"content-type": "application/json"} : {}),
      ...(options.token ? {authorization: `Bearer ${options.token}`} : {}),
      ...(options.idempotencyKey ? {"idempotency-key": options.idempotencyKey} : {})
    },
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.error || "request_failed"}: ${payload.message || response.status}`);
  return payload;
}

function parseArgs(argv) {
  const result = {_ : []};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) result._.push(arg);
    else if (arg.includes("=")) result[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) result[arg.slice(2)] = argv[++index];
    else result[arg.slice(2)] = true;
  }
  return result;
}

function parseDurationSeconds(value) {
  if (typeof value === "number") return value;
  const raw = String(value || "").trim();
  if (/^\d+$/u.test(raw)) return Number(raw);
  const match = raw.match(/^(\d+)(s|m|h|d)$/u);
  if (!match) throw new Error(`invalid --ttl duration: ${raw}`);
  const amount = Number(match[1]);
  const scale = {s: 1, m: 60, h: 3600, d: 86400}[match[2]];
  return amount * scale;
}
