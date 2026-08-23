// ===== AI 生成图片（硅基流动 SiliconFlow · FLUX.1-schnell） =====
// 复用设置里的硅基流动 API Key（config.siliconFlowApiKey）
const IMG_API_URL = 'https://api.siliconflow.cn/v1/images/generations';
const IMG_MODEL = 'black-forest-labs/FLUX.1-schnell';

// 生成 1:1 人物形象图，返回 Blob
export async function generateImage(apiKey, prompt, { width = 1024, height = 1024 } = {}) {
  if (!apiKey) throw new Error('请先在设置中填写硅基流动 API Key');

  const res = await fetch(IMG_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMG_MODEL,
      prompt,
      image_size: `${width}x${height}`,
      num_inference_steps: 4,
      batch_size: 1,
    }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err.message) msg = err.message;
    } catch { /* 忽略解析失败 */ }
    if (res.status === 401 || res.status === 403) msg = 'API Key 无效或无权限';
    else if (res.status === 402) msg = '账户余额不足，请到硅基流动充值';
    else if (res.status === 429) msg = '请求过于频繁，请稍后再试';
    throw new Error(msg);
  }

  const data = await res.json();
  const b64 = data?.images?.[0]?.url
    || data?.images?.[0]?.b64_json
    || data?.data?.[0]?.b64_json
    || data?.data?.[0]?.url;
  if (!b64) throw new Error('生成结果为空，请重试');

  // b64 或 URL 统一转 Blob
  if (b64.startsWith('http')) {
    const imgRes = await fetch(b64);
    if (!imgRes.ok) throw new Error('下载生成图片失败');
    return await imgRes.blob();
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}
