// Worker thread that owns the single pg.Pool for the Postgres state backend.
// The main thread drives it synchronously via pg-sync-store.mjs (Atomics.wait +
// receiveMessageOnPort), so at most one request is in flight at a time; the pool
// exists to reuse physical connections across sequential requests instead of
// spawning a `psql` process per query (the previous execFileSync approach).
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";

const sig = new Int32Array(workerData.sig);
const port = workerData.port;
const controlPort = parentPort;

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.AIMAC_PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.AIMAC_PG_POOL_IDLE_MS || 30000),
    connectionTimeoutMillis: Number(process.env.AIMAC_PG_POOL_CONNECT_TIMEOUT_MS || 10000)
  });
  // Idle-client errors (e.g. server restart) must not crash the worker; the next
  // checkout surfaces the failure to the caller synchronously.
  pool.on("error", () => {});
  return pool;
}

// Table/column names arrive from the trusted main-thread bridge as fixed
// constants, but validate defensively since they are interpolated into DDL.
function ident(value) {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`pg worker: unsafe identifier ${JSON.stringify(value)}`);
  }
  return value;
}

async function ensureTables(p, table, shardTable) {
  await p.query(`CREATE TABLE IF NOT EXISTS ${ident(table)} (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
  await p.query(`CREATE TABLE IF NOT EXISTS ${ident(shardTable)} (project_id text PRIMARY KEY, shard jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
}

async function writeStateWithShards(p, args) {
  const {table, shardTable, stateId, central, shards, expectedVersion} = args;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await ensureTables(client, table, shardTable);
    let upsert;
    if (expectedVersion === null || expectedVersion === undefined) {
      upsert = await client.query(
        `INSERT INTO ${ident(table)} (id, state, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
         RETURNING id`,
        [stateId, central]
      );
    } else {
      upsert = await client.query(
        `INSERT INTO ${ident(table)} (id, state, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
         WHERE COALESCE((${ident(table)}.state->>'stateVersion')::bigint, 0) = $3
         RETURNING id`,
        [stateId, central, Number(expectedVersion)]
      );
    }
    if (upsert.rowCount === 0) {
      // Version guard failed: existing row moved on. Abort without touching shards.
      await client.query("ROLLBACK");
      return {ok: true, conflict: true};
    }
    if (Array.isArray(shards) && shards.length) {
      await client.query(
        `DELETE FROM ${ident(shardTable)} WHERE project_id <> ALL($1::text[])`,
        [shards.map((shard) => String(shard.projectId))]
      );
      for (const shard of shards) {
        await client.query(
          `INSERT INTO ${ident(shardTable)} (project_id, shard, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET shard = EXCLUDED.shard, updated_at = now()`,
          [String(shard.projectId), JSON.stringify(shard)]
        );
      }
    } else {
      await client.query(`DELETE FROM ${ident(shardTable)}`);
    }
    await client.query("COMMIT");
    return {ok: true, conflict: false};
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection already broken */ }
    throw error;
  } finally {
    client.release();
  }
}

async function handle(op, args) {
  const p = getPool();
  switch (op) {
    case "ensureTables":
      await ensureTables(p, args.table, args.shardTable);
      return {ok: true};
    case "readState": {
      const result = await p.query(`SELECT state FROM ${ident(args.table)} WHERE id = $1`, [args.stateId]);
      return {ok: true, value: result.rows.length ? result.rows[0].state : null};
    }
    case "readShards": {
      const result = await p.query(`SELECT shard FROM ${ident(args.shardTable)} ORDER BY project_id`);
      return {ok: true, value: result.rows.map((row) => row.shard)};
    }
    case "writeStateWithShards":
      return writeStateWithShards(p, args);
    default:
      throw new Error(`pg worker: unknown op ${op}`);
  }
}

port.on("message", async (message) => {
  let response;
  try {
    response = await handle(message.op, message.args || {});
  } catch (error) {
    response = {ok: false, error: String((error && error.message) || error), code: error && error.code};
  }
  // Post the (structured-cloned, arbitrary-size) response first, THEN flip the
  // shared flag: the Atomics write happens-after the postMessage enqueue, so once
  // the main thread's Atomics.wait returns the message is already drainable via
  // receiveMessageOnPort.
  port.postMessage(response);
  Atomics.store(sig, 0, 1);
  Atomics.notify(sig, 0);
});

// Signal readiness to the bridge's control port (best-effort; not required for
// correctness because MessagePort buffers requests posted before this fires).
if (controlPort) controlPort.postMessage({ready: true});
