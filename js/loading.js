/**
 * HiFriends 启动预加载器
 * 进入主应用前，先加载全部角色的视频与克隆音频资源，
 * 期间显示全屏进度弹窗，加载完成后才放行进入。
 *
 * - 用 fetch 读取资源并按字节实时上报进度
 * - 全部成功 → 自动淡出进入主应用（资源已进浏览器缓存，进入后秒开）
 * - 部分失败（≤2 个）→ 提示并放行（失败角色回退默认形象/音色）
 * - 失败较多或本地 file:// 打开 → 提示原因，可点"重新加载"或"仍然进入"
 */
(function () {
  'use strict';

  // ===== 资源清单（与 characters.js 保持一致） =====
  const MEDIA_FILES = [
    'assets/girlfriend.mp4',   // Helen
    'assets/SteveJobs.mp4',
    'assets/albert.mp4',
    'assets/elonmusk.mp4',
    'assets/FanZhenDong.mp4',
    'assets/Leo.mp4',
    'assets/Aris.mp4',
  ];

  const CLONE_FILES = [
    'assets/clones/helen_zh.mp3',
    'assets/clones/stevejobs_zh.mp3',
    'assets/clones/einstein_zh.wav',
    'assets/clones/elonmusk_zh.mp3',
    'assets/clones/fanzhendong_zh.mp3',
    'assets/clones/leo_zh.mp3',
    'assets/clones/aris_zh.mp3',
  ];

  const ALL_FILES = [...MEDIA_FILES, ...CLONE_FILES];

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const overlay = $('loadingOverlay');
  const barFill = $('loadingBarFill');
  const pctEl = $('loadingPct');
  const detailEl = $('loadingDetail');
  const refreshBtn = $('loadingRefreshBtn');

  // ===== 状态 =====
  let cancelled = false;   // 用户点了"重新加载" → 中断当前批次
  let finished = false;    // 是否已放行进入
  let totalBytes = 0;      // 已知总字节数（从 content-length 累计）
  let loadedBytes = 0;     // 已加载字节
  let fileCount = 0;       // 已完成文件数
  let failures = [];       // 失败的文件

  // 节流 UI 刷新
  let uiDirty = false;
  function markDirty() {
    if (uiDirty) return;
    uiDirty = true;
    requestAnimationFrame(render);
  }
  function render() {
    uiDirty = false;
    if (!barFill) return;
    let pct = 0;
    if (totalBytes > 0) {
      pct = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
    } else if (fileCount > 0) {
      // 拿不到 content-length 时按文件数估算
      pct = Math.min(100, Math.round((fileCount / ALL_FILES.length) * 100));
    }
    barFill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
  }

  function setDetail(text) {
    if (detailEl) detailEl.textContent = text;
  }

  // ===== 单个资源：fetch + 进度 =====
  function fetchWithProgress(url) {
    return fetch(url, { cache: 'force-cache' }).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const len = Number(res.headers.get('content-length')) || 0;
      if (len > 0) totalBytes += len;

      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) {
        // 不支持流式读取（个别老浏览器）：直接读完
        return res.blob().then((blob) => {
          loadedBytes += blob.size;
          fileCount++;
          markDirty();
        });
      }

      let received = 0;
      return new Promise((resolve, reject) => {
        function pump() {
          reader.read().then(({ done, value }) => {
            if (cancelled) {
              reader.cancel().catch(() => {});
              reject(new Error('cancelled'));
              return;
            }
            if (done) {
              fileCount++;
              markDirty();
              resolve();
              return;
            }
            received += value.length;
            loadedBytes += value.length;
            markDirty();
            pump();
          }).catch((e) => {
            // 流中断（如用户刷新）：把已读字节算进去再报错
            loadedBytes += received;
            fileCount++;
            markDirty();
            reject(e);
          });
        }
        pump();
      });
    });
  }

  // ===== 主流程 =====
  async function loadBatch() {
    cancelled = false;
    totalBytes = 0;
    loadedBytes = 0;
    fileCount = 0;
    failures = [];
    barFill.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
    setDetail('正在准备资源…');
    refreshBtn.disabled = true;

    const tasks = ALL_FILES.map((url) =>
      fetchWithProgress(url)
        .catch((e) => {
          failures.push({ url, msg: (e && e.message) || String(e) });
        })
    );

    await Promise.all(tasks);
    refreshBtn.disabled = false;

    if (cancelled) return; // 用户已点了重新加载，新批次已开始

    const okCount = ALL_FILES.length - failures.length;
    render();

    // —— 判定是否放行 ——
    if (failures.length === 0) {
      setDetail('资源加载完成，准备进入…');
      setTimeout(enterApp, 350);
      return;
    }

    // 有失败：区分场景给出提示
    const allFailed = failures.length === ALL_FILES.length;
    if (allFailed) {
      // 可能是本地 file:// 直开（fetch 跨源被拦）或网络不通
      setDetail('无法预加载资源（本地直开或网络异常）。视频会在使用时按需加载。');
      addEnterButton('仍然进入');
      return;
    }

    if (failures.length <= 2) {
      // 少量失败：放行，失败角色自动回退
      setDetail(`已加载 ${okCount}/${ALL_FILES.length} 个资源，少数角色将使用默认形象/音色。`);
      setTimeout(enterApp, 800);
      return;
    }

    setDetail(`加载异常（成功 ${okCount}/${ALL_FILES.length}），请检查网络后重试。`);
    addEnterButton('仍然进入');
  }

  // 追加"仍然进入"按钮（失败较多时兜底，不强制卡住用户）
  function addEnterButton(text) {
    if (document.getElementById('loadingEnterBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'loadingEnterBtn';
    btn.className = 'loading-refresh loading-enter';
    btn.textContent = text;
    btn.addEventListener('click', enterApp);
    refreshBtn.parentNode.insertBefore(btn, refreshBtn.nextSibling);
  }

  function enterApp() {
    if (finished) return;
    finished = true;
    overlay.classList.add('loading-done');
    // 等淡出动画结束后移除节点，避免残留遮挡
    setTimeout(() => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 600);
  }

  // 重新加载按钮
  refreshBtn.addEventListener('click', () => {
    if (!refreshBtn.disabled) {
      cancelled = true;
      const enterBtn = document.getElementById('loadingEnterBtn');
      if (enterBtn) enterBtn.remove();
      setDetail('正在重新加载…');
      loadBatch();
    }
  });

  // 启动
  loadBatch();
})();
