// db.js — promise-based IndexedDB wrapper for DorkWay.
//
// Self-contained (no `idb` dependency) so the extension runs with no build step.
// Shared by the service worker (writes) and the side panel (reads); both run in the
// extension origin and therefore see the same database.
//
// DB: DorkWayDB
//   Store: sessions { sessionId, name, createdAt, queries[] }
//   Store: results  { id, sessionId, ...ResultEntity }   indexes: sessionId, rootDomain

const DB_NAME = 'DorkWayDB';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains('results')) {
        const store = db.createObjectStore('results', { keyPath: 'compositeKey' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('rootDomain', 'rootDomain', { unique: false });
        store.createIndex('id', 'id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        const stores = Array.isArray(storeNames)
          ? storeNames.map((n) => t.objectStore(n))
          : t.objectStore(storeNames);
        let result;
        Promise.resolve(fn(stores, t))
          .then((r) => {
            result = r;
          })
          .catch(reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      })
  );
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Composite key keeps the same logical result (id) separate per session.
const ckey = (sessionId, id) => `${sessionId}::${id}`;

// ---- Sessions ----------------------------------------------------------------

export async function createSession(name) {
  const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = { sessionId, name: name || `Session ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), queries: [] };
  await tx('sessions', 'readwrite', (store) => reqToPromise(store.put(session)));
  return session;
}

export async function getSession(sessionId) {
  return tx('sessions', 'readonly', (store) => reqToPromise(store.get(sessionId)));
}

export async function listSessions() {
  const all = await tx('sessions', 'readonly', (store) => reqToPromise(store.getAll()));
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function addQueryToSession(sessionId, query) {
  return tx('sessions', 'readwrite', async (store) => {
    const session = await reqToPromise(store.get(sessionId));
    if (!session) return;
    if (!session.queries.includes(query)) {
      session.queries.push(query);
      await reqToPromise(store.put(session));
    }
  });
}

export async function deleteSession(sessionId) {
  await tx(['sessions', 'results'], 'readwrite', async ([sessions, results]) => {
    await reqToPromise(sessions.delete(sessionId));
    const idx = results.index('sessionId');
    const keys = await reqToPromise(idx.getAllKeys(IDBKeyRange.only(sessionId)));
    for (const k of keys) await reqToPromise(results.delete(k));
  });
}

// ---- Results -----------------------------------------------------------------

/**
 * Insert or merge a result. On id collision within a session, merge tags +
 * sourceQuery (kept as a deduped, joined string) rather than overwriting.
 * Returns 'inserted' | 'merged'.
 */
export async function upsertResult(entity) {
  const compositeKey = ckey(entity.sessionId, entity.id);
  return tx('results', 'readwrite', async (store) => {
    const existing = await reqToPromise(store.get(compositeKey));
    if (existing) {
      const tags = [...new Set([...(existing.tags || []), ...(entity.tags || [])])].sort();
      const sources = new Set(
        `${existing.sourceQuery || ''}\n${entity.sourceQuery || ''}`
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const merged = {
        ...existing,
        ...entity,
        compositeKey,
        tags,
        sourceQuery: [...sources].join('\n'),
        // Keep the best (lowest) rank/page seen, and don't clobber a checked status with 0.
        rank: Math.min(existing.rank || Infinity, entity.rank || Infinity),
        page: Math.min(existing.page || Infinity, entity.page || Infinity),
        statusCode: entity.statusCode || existing.statusCode || 0,
        capturedAt: existing.capturedAt || entity.capturedAt
      };
      await reqToPromise(store.put(merged));
      return 'merged';
    }
    await reqToPromise(store.put({ ...entity, compositeKey }));
    return 'inserted';
  });
}

export async function getResults(sessionId) {
  const idx = 'sessionId';
  return tx('results', 'readonly', (store) =>
    reqToPromise(store.index(idx).getAll(IDBKeyRange.only(sessionId)))
  );
}

export async function updateResultStatus(sessionId, id, statusCode) {
  const compositeKey = ckey(sessionId, id);
  return tx('results', 'readwrite', async (store) => {
    const existing = await reqToPromise(store.get(compositeKey));
    if (!existing) return;
    existing.statusCode = statusCode;
    await reqToPromise(store.put(existing));
  });
}

export async function countResults(sessionId) {
  return tx('results', 'readonly', (store) =>
    reqToPromise(store.index('sessionId').count(IDBKeyRange.only(sessionId)))
  );
}

export async function clearResults(sessionId) {
  await tx('results', 'readwrite', async (store) => {
    const keys = await reqToPromise(store.index('sessionId').getAllKeys(IDBKeyRange.only(sessionId)));
    for (const k of keys) await reqToPromise(store.delete(k));
  });
}
