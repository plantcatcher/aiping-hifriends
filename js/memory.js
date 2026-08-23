// ===== 长期记忆存储（IndexedDB） =====
// 按人物隔离：每条记忆挂在 characterId 下
// topic 用于去重：同主题新记忆替换旧记忆（体现时间线演变）
// 每条记忆：{ id, characterId, topic, text, ts, importance }

const DB_NAME = 'hifriends_memory';
const DB_VERSION = 1;
const STORE = 'memories';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('characterId', 'characterId', { unique: false });
        store.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const dbPromise = openDB();
    dbPromise.then(db => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }).catch(reject);
  });
}

// 保存一条记忆；同人物同 topic 的旧记忆被替换（保留原 ts 用于排序权重）
export async function saveMemory(characterId, { topic, text, importance = 3 }) {
  return tx(STORE, 'readwrite', (s) => {
    const existing = s.index('characterId').getAll(characterId);
    existing.onsuccess = () => {
      const old = (existing.result || []).find(m => m.topic === topic);
      const now = Date.now();
      if (old) {
        const merged = { ...old, text, ts: now, importance, updated: now };
        s.put(merged);
      } else {
        s.put({ id: 'm' + now + Math.random().toString(36).slice(2, 7), characterId, topic, text, ts: now, importance });
      }
    };
  });
}

// 按人物取全部记忆，按时间倒序
export async function getMemories(characterId) {
  return tx(STORE, 'readonly', (s) => {
    const req = s.index('characterId').getAll(characterId);
    return req;
  }).then(list => (list || []).sort((a, b) => b.ts - a.ts));
}

// 按相关性召回（关键词匹配 + 时间加权），limit 条
export async function recallMemories(characterId, keywords, limit = 10) {
  const all = await getMemories(characterId);
  if (!keywords || keywords.length === 0) {
    return all.slice(0, limit);
  }
  const scored = all.map(m => {
    let score = 0;
    const text = (m.text || '').toLowerCase();
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) score += 2;
    }
    if (m.importance) score += m.importance * 0.5;
    // 时间衰减：一周内的记忆权重更高
    const age = Date.now() - m.ts;
    if (age < 7 * 24 * 3600 * 1000) score += 1;
    else if (age < 30 * 24 * 3600 * 1000) score += 0.5;
    return { m, score };
  });
  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.m);
}

export async function deleteMemory(characterId, id) {
  return tx(STORE, 'readwrite', (s) => {
    s.delete(id);
  });
}

export async function clearMemories(characterId) {
  return tx(STORE, 'readwrite', (s) => {
    const req = s.index('characterId').getAllKeys(characterId);
    req.onsuccess = () => {
      (req.result || []).forEach(k => s.delete(k));
    };
  });
}

// 获取当前人物的所有记忆（供 UI 时间线展示）
export async function getMemoryStats(characterId) {
  const all = await getMemories(characterId);
  return { count: all.length, list: all };
}
