// ===== 已下载角色素材存储（IndexedDB） =====
// 与 media-store.js 类似，但按角色归档整包素材：
//   { media: Blob, mediaType: 'video'|'image', clone: Blob, downloadedAt }
// 主键为角色 id。用户点击「下载素材」后写入，之后角色形象/克隆音从此处读取，
// 实现「下载到本地、离线可用、切换秒开」。

const DB_NAME = 'hifriends_assets';
const STORE = 'assets';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAssets(charId, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record, charId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAssets(charId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(charId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAssets(charId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(charId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
