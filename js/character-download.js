// ===== 角色素材按需下载 =====
// 把「开头统一预加载全部视频」改成「点哪个角色下载哪个」：
// 用户从角色库点「下载素材」时，才 fetch 该角色的 mp4/克隆音频并存入 IndexedDB。
// 之后该角色形象/音色从本地读取，离线可用、切换秒开。

import { getRemoteAssetURLs } from './characters.js';
import { saveAssets } from './asset-store.js';

// fetch 单个资源为 Blob（带流式读取，但此处不强制上报字节进度，
// 进度以「已完成文件数 / 总文件数」体现，简单可靠）。
async function fetchAsBlob(url) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.blob();
}

/**
 * 下载某角色的远程素材并归档到本地 IndexedDB。
 * @param {object} char 角色对象
 * @param {{onProgress?: (done:number, total:number)=>void}} [opts]
 * @returns {Promise<{media:Blob,mediaType:string,clone?:Blob,downloadedAt:number}>}
 */
export async function downloadCharacterAssets(char, { onProgress } = {}) {
  const { mediaUrl, cloneUrl } = getRemoteAssetURLs(char);
  const urls = [mediaUrl, cloneUrl].filter(Boolean);
  if (urls.length === 0) {
    throw new Error('该角色没有可下载的远程素材');
  }

  const record = { downloadedAt: Date.now() };
  let done = 0;

  for (const u of urls) {
    const blob = await fetchAsBlob(u);
    done += 1;
    if (onProgress) onProgress(done, urls.length);

    if (u === mediaUrl) {
      record.media = blob;
      record.mediaType = blob.type.startsWith('video') ? 'video' : 'image';
    } else if (u === cloneUrl) {
      record.clone = blob;
    }
  }

  await saveAssets(char.id, record);
  return record;
}
