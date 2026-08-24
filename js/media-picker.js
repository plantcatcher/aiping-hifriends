// ===== 人物形象媒体选择器 =====
// 支持：本地文件上传（存 IndexedDB）/ URL 输入 / AI 生成（硅基流动 FLUX）/ 无媒体（默认形象）
import { saveMedia, isStoredMedia } from './media-store.js';
import { generateImage } from './imagegen.js';

const ACCEPT = 'image/*,video/mp4,video/webm,video/ogg,video/quicktime';

export class MediaPicker {
  constructor(container, { onChange, getSFApiKey } = {}) {
    this.container = container;
    this.onChange = onChange;
    this.getSFApiKey = getSFApiKey || (() => '');
    this.value = '';       // 当前值：'' | URL | 'db:<id>'
    this._pending = false; // 防止重复上传/生成
    this._preview = null;  // 预览 URL
    this._render();
  }

  _render() {
    this.container.innerHTML = `
      <div class="media-picker">
        <div class="media-tabs" role="tablist">
          <button type="button" class="media-tab active" data-tab="upload">上传</button>
          <button type="button" class="media-tab" data-tab="url">图片链接</button>
          <button type="button" class="media-tab" data-tab="ai">AI 生成</button>
        </div>

        <!-- 上传 -->
        <div class="media-pane" data-pane="upload">
          <button type="button" class="btn-secondary btn-sm media-upload-btn">选择图片 / 视频文件</button>
          <input type="file" class="media-file-input" accept="${ACCEPT}" style="display:none">
        </div>

        <!-- URL -->
        <div class="media-pane hidden" data-pane="url">
          <input type="text" class="media-url-input" placeholder="粘贴图片或视频链接 https://...">
        </div>

        <!-- AI 生成 -->
        <div class="media-pane hidden" data-pane="ai">
          <div class="media-ai-row">
            <input type="text" class="media-ai-input" placeholder="描述形象，如：一位留着短发的年轻女性，温柔微笑，浅蓝毛衣，棚拍肖像" maxlength="200">
            <button type="button" class="btn-primary btn-sm media-ai-btn">生成</button>
          </div>
          <div class="media-ai-status hidden"></div>
        </div>

        <div class="media-preview hidden">
          <span class="media-preview-label">当前形象</span>
          <button type="button" class="media-remove" title="移除">✕</button>
        </div>
      </div>`;

    this.fileInput = this.container.querySelector('.media-file-input');
    this.urlInput = this.container.querySelector('.media-url-input');
    this.aiInput = this.container.querySelector('.media-ai-input');
    this.aiBtn = this.container.querySelector('.media-ai-btn');
    this.aiStatus = this.container.querySelector('.media-ai-status');
    this.preview = this.container.querySelector('.media-preview');
    this.removeBtn = this.container.querySelector('.media-remove');

    // tab 切换
    this.container.querySelectorAll('.media-tab').forEach(tab => {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    });

    // 上传
    this.container.querySelector('.media-upload-btn').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => this._onFile(this.fileInput.files[0]));
    this.fileInput.addEventListener('click', () => { this.fileInput.value = ''; });

    // URL
    this.urlInput.addEventListener('change', () => this._onUrl(this.urlInput.value.trim()));

    // AI 生成（API Key 已内置，直接可用）
    this.aiBtn.addEventListener('click', () => this._onAI());
    this.aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._onAI();
      }
    });
    this._refreshAISetup();
  }

  _switchTab(tab) {
    this.container.querySelectorAll('.media-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    this.container.querySelectorAll('.media-pane').forEach(p => {
      p.classList.toggle('hidden', p.dataset.pane !== tab);
    });
    if (tab === 'ai') this._refreshAISetup();
  }

  async _onFile(file) {
    if (!file || this._pending) return;
    const isVideo = /^video\//.test(file.type);
    const isImage = /^image\//.test(file.type);
    if (!isVideo && !isImage) {
      alert('仅支持图片或视频文件');
      return;
    }
    if (file.size > 60 * 1024 * 1024) {
      alert('文件过大（上限 60MB）');
      return;
    }
    this._pending = true;
    try {
      const id = await saveMedia(file);
      this.setValue('db:' + id);
    } catch (e) {
      console.error('保存媒体失败:', e);
      alert('保存失败，请重试');
    } finally {
      this._pending = false;
    }
  }

  _onUrl(url) {
    if (!url) return;
    this.setValue(url);
    this.urlInput.value = '';
    this._switchTab('upload');
  }

  async _onAI() {
    const prompt = this.aiInput.value.trim();
    if (!prompt) {
      this.aiInput.focus();
      return;
    }
    const apiKey = this.getSFApiKey();
    if (!apiKey) {
      this._showAIStatus('硅基流动 Key 未就绪，请稍后再试', 'error');
      return;
    }
    if (this._pending) return;
    this._pending = true;
    this.aiBtn.disabled = true;
    this._showAIStatus('正在生成形象…（约 10~30 秒）');
    try {
      const blob = await generateImage(apiKey, prompt);
      const id = await saveMedia(blob);
      this.setValue('db:' + id);
      this._showAIStatus('生成成功，已设为当前形象', 'success');
      this.aiInput.value = '';
    } catch (e) {
      console.error('AI 生成失败:', e);
      this._showAIStatus(`生成失败：${e.message}`, 'error');
    } finally {
      this._pending = false;
      this.aiBtn.disabled = false;
    }
  }

  _showAIStatus(text, type) {
    this.aiStatus.textContent = text;
    this.aiStatus.className = 'media-ai-status' + (type ? ` ${type}` : '');
    this.aiStatus.classList.remove('hidden');
  }

  // 根据当前 API Key 状态刷新 AI 生成 tab 的入口提示与按钮可用性
  _refreshAISetup() {
    // API Key 已内置（config.js），AI 生成 tab 始终可用
    if (this.aiBtn) this.aiBtn.disabled = false;
  }

  // 外部（如设置弹窗保存后）调用，刷新 Key 状态显示
  refresh() {
    this._refreshAISetup();
  }

  setValue(value) {
    this.value = value || '';
    this._renderPreview();
    if (this.onChange) this.onChange(this.value);
  }

  _renderPreview() {
    if (!this.value) {
      this.preview.classList.add('hidden');
      this.preview.innerHTML = '';
      return;
    }
    this.preview.classList.remove('hidden');
    this.preview.innerHTML = `
      <span class="media-preview-label">当前形象</span>
      <button type="button" class="media-remove" title="移除">✕</button>`;
    this.removeBtn = this.preview.querySelector('.media-remove');
    this.removeBtn.addEventListener('click', () => this.setValue(''));
  }

  // 外部提供（调用方负责解析 db: 引用）
  setPreview(url) {
    if (!this.preview) return;
    const media = document.createElement(url.endsWith('.mp4') || url.endsWith('.webm') || url.endsWith('.mov') || url.endsWith('.ogg') ? 'video' : 'img');
    if (media.tagName === 'VIDEO') {
      media.src = url;
      media.muted = true;
      media.loop = true;
      media.autoplay = true;
      media.playsInline = true;
    } else {
      media.src = url;
    }
    media.className = 'media-preview-el';
    media.onerror = () => { this.preview.classList.add('hidden'); };
    const label = this.preview.querySelector('.media-preview-label');
    const remove = this.preview.querySelector('.media-remove');
    if (label) this.preview.insertBefore(media, label.nextSibling);
    if (remove) this.preview.appendChild(remove);
  }

  async getValue() {
    return this.value;
  }

  // 在表单保存前调用：解析 db: 引用为 blob URL，供预览展示
  async resolveBlobUrl(value) {
    if (!isStoredMedia(value)) return null;
    const { getMedia } = await import('./media-store.js');
    const rec = await getMedia(value.slice(3));
    if (!rec) return null;
    return URL.createObjectURL(rec.blob);
  }
}
