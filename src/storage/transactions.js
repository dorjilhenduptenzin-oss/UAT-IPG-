const fs = require("fs");
const path = require("path");
const { getDataRootDir } = require("./paths");
const { durableEnabled, durableGet, durableSet } = require("./durable");

const TRANSACTION_DIR = path.join(getDataRootDir(), "transactions");
const DURABLE_TXN_PREFIX = "uat:txn:";
const memoryCache = new Map();

function ensureDir() {
  fs.mkdirSync(TRANSACTION_DIR, { recursive: true });
}

function getTxnPath(txnId) {
  const safeId = String(txnId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(TRANSACTION_DIR, `txn_${safeId}.json`);
}

function saveTransaction(txn) {
  if (!txn || !txn.txnId) return "";
  memoryCache.set(txn.txnId, JSON.parse(JSON.stringify(txn)));
  try {
    ensureDir();
    const filePath = getTxnPath(txn.txnId);
    fs.writeFileSync(filePath, JSON.stringify(txn, null, 2), "utf8");
    return filePath;
  } catch {
    return "";
  }
}

function loadTransaction(txnId) {
  if (!txnId) return null;
  const rawId = String(txnId).trim();
  const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, "");

  if (memoryCache.has(rawId)) {
    return JSON.parse(JSON.stringify(memoryCache.get(rawId)));
  }
  if (cleanId && memoryCache.has(cleanId)) {
    return JSON.parse(JSON.stringify(memoryCache.get(cleanId)));
  }

  try {
    const filePath = getTxnPath(rawId);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      memoryCache.set(data.txnId || rawId, data);
      return data;
    }
  } catch {
    // Ignore read error and fallback to scan
  }

  // Scan all cached and stored transactions for matching purchaseId or orderRef
  const all = listRecentTransactions(100);
  const found = all.find(
    (t) =>
      t.txnId === rawId ||
      t.txnId === cleanId ||
      t.orderRef === rawId ||
      t.mkReq?.request?.purchaseId === rawId ||
      t.mpiPurchaseDate === rawId
  );
  if (found) {
    memoryCache.set(found.txnId, found);
    return JSON.parse(JSON.stringify(found));
  }

  return null;
}

function transactionExists(txnId) {
  if (!txnId) return false;
  const rawId = String(txnId).trim();
  if (memoryCache.has(rawId)) return true;
  return fs.existsSync(getTxnPath(rawId));
}

function listRecentTransactions(limit = 50) {
  const list = [];
  const seenIds = new Set();

  for (const [id, txn] of memoryCache.entries()) {
    seenIds.add(id);
    list.push(txn);
  }

  try {
    ensureDir();
    const files = fs.readdirSync(TRANSACTION_DIR).filter((f) => f.startsWith("txn_"));
    for (const f of files) {
      try {
        const p = path.join(TRANSACTION_DIR, f);
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw?.txnId && !seenIds.has(raw.txnId)) {
          seenIds.add(raw.txnId);
          list.push(raw);
          memoryCache.set(raw.txnId, raw);
        }
      } catch {
        // Skip corrupted individual file
      }
    }
  } catch {
    // Directory reading fallback
  }

  list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return list.slice(0, limit);
}

/**
 * Pull a transaction from the durable store (if configured) into the local
 * memory cache so the synchronous load/save API can serve it on a cold
 * serverless invocation. No-op when no durable store is configured.
 */
async function hydrateFromDurable(txnId) {
  if (!durableEnabled() || !txnId) {
    return null;
  }
  const key = DURABLE_TXN_PREFIX + String(txnId).trim();
  const record = await durableGet(key);
  if (record && record.txnId) {
    memoryCache.set(record.txnId, record);
    return record;
  }
  return null;
}

/**
 * Flush the current in-memory copy of a transaction to the durable store so
 * the next (possibly different) serverless invocation can rehydrate it.
 */
async function persistToDurable(txnId) {
  if (!durableEnabled() || !txnId) {
    return false;
  }
  const record = memoryCache.get(String(txnId).trim());
  if (!record) {
    return false;
  }
  return durableSet(DURABLE_TXN_PREFIX + record.txnId, record);
}

module.exports = {
  saveTransaction,
  loadTransaction,
  transactionExists,
  listRecentTransactions,
  hydrateFromDurable,
  persistToDurable,
  TRANSACTION_DIR
};
