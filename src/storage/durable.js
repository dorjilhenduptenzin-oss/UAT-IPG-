/**
 * Durable key/value store for serverless (Vercel) deployments.
 *
 * Vercel/AWS Lambda give every invocation a cold `os.tmpdir()` and a fresh
 * process, so the filesystem + in-memory cache used by storage/transactions.js
 * cannot carry a transaction across the separate HTTP hits that make up one
 * payment (hosted-form GET -> Cardzone server callback -> browser return ->
 * inquiry). This module persists that state to an external store so any
 * invocation can rehydrate it.
 *
 * Backend: the Upstash Redis REST API, which is what Vercel KV exposes. It is
 * called over plain `fetch` (no SDK dependency). Configure with either:
 *   - KV_REST_API_URL / KV_REST_API_TOKEN            (Vercel KV integration)
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash directly)
 *
 * When neither pair is configured every operation is a no-op and the caller
 * falls back to the local filesystem/memory behaviour unchanged. That keeps
 * local development and the test suite working with zero configuration.
 */

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

// UAT diagnostic data has no long-term value; expire it after a day so the
// store cannot fill up with stale test transactions.
const DEFAULT_TTL_SECONDS = 60 * 60 * 24;
const REQUEST_TIMEOUT_MS = 4000;

function durableEnabled() {
  return Boolean(REST_URL && REST_TOKEN);
}

async function runCommand(command) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`durable store ${command[0]} failed: HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function durableGet(key) {
  if (!durableEnabled() || !key) {
    return null;
  }
  try {
    const payload = await runCommand(["GET", key]);
    if (!payload || payload.result === null || payload.result === undefined) {
      return null;
    }
    return JSON.parse(payload.result);
  } catch (error) {
    console.warn(`[WARN] durableGet(${key}) failed: ${error.message}`);
    return null;
  }
}

async function durableSet(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!durableEnabled() || !key) {
    return false;
  }
  try {
    const serialized = JSON.stringify(value);
    const command = ttlSeconds
      ? ["SET", key, serialized, "EX", String(ttlSeconds)]
      : ["SET", key, serialized];
    await runCommand(command);
    return true;
  } catch (error) {
    console.warn(`[WARN] durableSet(${key}) failed: ${error.message}`);
    return false;
  }
}

async function durableDel(key) {
  if (!durableEnabled() || !key) {
    return false;
  }
  try {
    await runCommand(["DEL", key]);
    return true;
  } catch (error) {
    console.warn(`[WARN] durableDel(${key}) failed: ${error.message}`);
    return false;
  }
}

module.exports = {
  durableEnabled,
  durableGet,
  durableSet,
  durableDel,
  DEFAULT_TTL_SECONDS
};
