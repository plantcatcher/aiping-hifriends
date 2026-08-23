const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isASRSupported() {
  return !!SR;
}

export class SpeechRecognizer {
  constructor() {
    if (!SR) throw new Error('浏览器不支持语音识别，请使用 Chrome 或 Edge');
    this.recognition = new SR();
    this.recognition.lang = 'zh-CN';
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.isListening = false;
    this.shouldRestart = false;
    this.onInterim = null;
    this.onFinal = null;
    this.onError = null;
    this.onEnd = null;
    this._pendingFinal = '';   // 未确认的 final 片段（等待停顿确认是否续说）
    this._lastFinalAt = 0;     // 上次确认 final 的时间
    this._lastRestartAt = 0;   // 上次自动重启的时间（节流防抖）
    this._setupEvents();
  }

  _setupEvents() {
    this.recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (interim && this.onInterim) this.onInterim(interim);
      if (final) {
        // 先合并进 pending，不立即触发 onFinal（等停顿确认是否还有续说）
        this._pendingFinal += final;
      }
    };

    this.recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      if (event.error === 'aborted') return;
      if (this.onError) this.onError(event.error);
    };

    this.recognition.onend = () => {
      this.isListening = false;
      // 停顿（onend 触发）确认一句话结束：把 pending 的 final 合并发出
      const hasFinal = !!this._pendingFinal.trim();
      if (hasFinal) {
        const text = this._pendingFinal.trim();
        this._pendingFinal = '';
        this._lastFinalAt = Date.now();
        if (this.onFinal) this.onFinal(text);
      }

      if (this.shouldRestart) {
        this.shouldRestart = false;
        // 节流：距上次自动重启至少 700ms，避免快速连续 onend 抖动
        const now = Date.now();
        if (now - this._lastRestartAt >= 700) {
          this._lastRestartAt = now;
          try { this.recognition.start(); this.isListening = true; } catch {}
        } else if (this.onEnd) {
          this.onEnd();
        }
      } else if (this.onEnd) {
        this.onEnd();
      }
    };
  }

  start() {
    if (this.isListening) return;
    this._pendingFinal = '';
    try {
      this.recognition.start();
      this.isListening = true;
    } catch (e) {
      // start() throws if already started; safe to ignore
    }
  }

  stop() {
    this.shouldRestart = false;
    this.isListening = false;
    // 立即把残留的 pending final 发出（手动停止时也要拿到结果）
    if (this._pendingFinal.trim()) {
      const text = this._pendingFinal.trim();
      this._pendingFinal = '';
      if (this.onFinal) this.onFinal(text);
    }
    try { this.recognition.stop(); } catch {}
  }
}
