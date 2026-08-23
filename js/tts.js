const SF_API_URL = 'https://api.siliconflow.cn/v1/audio/speech';
const SF_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';

// 克隆模式强制中文输出：CosyVoice2 零样本克隆会跟随参考音频的语言音素空间，
// 参考音频是英文时输出就是英文。加"指令<|endofprompt|>正文"前缀可强制目标语言。
const CLONE_ZH_PROMPT = '请用中文朗读：<|endofprompt|>';

const SF_VOICES = [
  { id: 'alex', name: '沉稳男声' },
  { id: 'benjamin', name: '低沉男声' },
  { id: 'charles', name: '磁性男声' },
  { id: 'david', name: '欢快男声' },
  { id: 'anna', name: '沉稳女声' },
  { id: 'bella', name: '激情女声' },
  { id: 'claire', name: '温柔女声' },
  { id: 'diana', name: '欢快女声' },
];

export { SF_VOICES };

const synth = window.speechSynthesis;

export function getVoices() {
  return synth.getVoices().filter(v => v.lang.startsWith('zh'));
}

export function onVoicesReady(callback) {
  let voices = synth.getVoices();
  if (voices.length > 0) {
    callback(voices);
    return;
  }
  synth.onvoiceschanged = () => {
    callback(synth.getVoices());
  };
}

// 测试硅基流动 TTS 连接：用指定音色合成一句并播放（未指定音色时用当前角色音色）
export async function testSFConnection(apiKey, voice) {
  const res = await fetch(SF_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: SF_MODEL,
      input: '你好',
      voice: `${SF_MODEL}:${voice || 'claire'}`,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err}`);
  }
  return true;
}

// 测试声音克隆：用参考音频以克隆模式合成一句中文并播放
export async function testCloneConnection(apiKey, refAudioBase64, refText, noInstruct = false) {
  const body = {
    model: SF_MODEL,
    // 克隆模式强制中文：指令前缀 + 中文测试句；noInstruct 时直接调用参考音频
    input: noInstruct
      ? '你好，我是你的AI朋友，很高兴认识你，现在用的是我本人的音色。'
      : CLONE_ZH_PROMPT + '你好，我是你的AI朋友，很高兴认识你，现在用的是我本人的音色。',
    response_format: 'mp3',
    references: [{
      audio: refAudioBase64,
      text: refText,
    }],
  };
  const res = await fetch(SF_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(err);
      msg = j.message || j.error?.message || msg;
    } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
  return true;
}

export class SpeechSynth {
  constructor() {
    this.buffer = '';
    this.queue = [];
    this.speaking = false;
    this.paused = false;
    this._resolveWait = null;
    this.onSentenceStart = null;
    this.currentAudio = null;
    this.generation = 0;

    this.useSiliconFlow = false;
    this.sfApiKey = '';
    this.sfVoice = 'claire';
    // instruct 模式：自然语言口音/语气指令（CosyVoice2 指令模式，与 voice 基底音色叠加）
    this.ttsInstruct = '';
    // 声音克隆：参考音频（base64 data URI）+ 对应文字
    this.cloneReference = null;
    // 克隆是否跳过中文指令前缀（true 则纯用参考音频，不加"请用中文朗读"调性）
    this.cloneNoInstruct = false;

    this.wsVoice = null;
    this.rate = 1;
    this.pitch = 1;
    // 克隆失败回调（供 UI 提示）
    this.onCloneError = null;
  }

  setUseSiliconFlow(use) { this.useSiliconFlow = use; }
  setSFApiKey(key) { this.sfApiKey = key; }
  setSFVoice(voice) { this.sfVoice = voice; }
  // 设置 instruct 口音/语气指令（如 "用台湾女生的语气说"），空字符串表示关闭
  setTTSInstruct(instruct) { this.ttsInstruct = instruct || ''; }
  // 设置克隆参考音频：{ audio: dataURI, text: 参考文字 }
  setCloneReference(ref) { this.cloneReference = ref || null; }
  // 设置克隆是否跳过指令前缀（默认 false；true 时直接调用参考音频，不加"请用中文朗读"调性）
  setCloneNoInstruct(v) { this.cloneNoInstruct = !!v; }
  setVoice(voice) { this.wsVoice = voice; }
  setRate(rate) { this.rate = rate; }
  setPitch(pitch) { this.pitch = pitch; }

  feedText(text) {
    if (!text) return;
    this.buffer += text;
    this._processBuffer();
  }

  flush() {
    if (this.buffer.trim()) {
      this._enqueue(this.buffer.trim());
      this.buffer = '';
    }
    if (!this.speaking && this.queue.length === 0 && this._resolveWait) {
      this._resolveWait();
      this._resolveWait = null;
    }
  }

  _processBuffer() {
    const regex = /([^。！？.!?…\n]+[。！？.!?…\n]*)/g;
    const matches = this.buffer.match(regex);
    if (matches && matches.length > 1) {
      for (let i = 0; i < matches.length - 1; i++) {
        this._enqueue(matches[i]);
      }
      this.buffer = matches[matches.length - 1];
    }
  }

  _enqueue(text) {
    text = text.trim();
    if (!text) return;
    this.queue.push(text);
    if (!this.speaking) this._speakNext();
  }

  async _speakNext() {
    // 暂停中：不继续播放下一条，保持队列
    if (this.paused) {
      this.speaking = false;
      return;
    }
    if (this.queue.length === 0) {
      this.speaking = false;
      if (this._resolveWait) {
        this._resolveWait();
        this._resolveWait = null;
      }
      return;
    }

    this.speaking = true;
    const text = this.queue.shift();

    if (this.onSentenceStart) this.onSentenceStart(text);

    if (this.sfApiKey) {
      await this._speakSiliconFlow(text);
    } else {
      this._speakWebSpeech(text);
    }
  }

  _speakWebSpeech(text) {
    const u = new SpeechSynthesisUtterance(text);
    // 角色指定台湾口音时，尝试本机 zh-TW 语音（无则浏览器回退默认语音）
    u.lang = (this.ttsInstruct && this.ttsInstruct.includes('台湾')) ? 'zh-TW' : 'zh-CN';
    if (this.wsVoice) u.voice = this.wsVoice;
    u.rate = this.rate;
    u.pitch = this.pitch;
    u.onend = () => this._speakNext();
    u.onerror = () => this._speakNext();
    this.synth.speak(u);
  }

  async _speakSiliconFlow(text) {
    const gen = this.generation;
    try {
      // 声音克隆模式：不带 voice 字段，只传 references（对齐官方 REST 动态音色示例）
      const useClone = !!(this.cloneReference && this.cloneReference.audio);
      // instruct 模式：自然语言口音/语气指令 + 正文，用 <|endofprompt|> 分隔（与 voice 基底叠加）
      const useInstruct = !useClone && !!this.ttsInstruct;
      const body = {
        model: SF_MODEL,
        // 克隆模式加中文指令前缀，强制输出中文（参考音频是英文时默认会输出英文）
        // instruct 模式：指令 + <|endofprompt|> + 正文
        input: useClone
          ? (this.cloneNoInstruct ? text : CLONE_ZH_PROMPT + text)
          : (useInstruct ? this.ttsInstruct + '<|endofprompt|>' + text : text),
        response_format: 'mp3',
        speed: this.rate,
      };
      if (useClone) {
        body.references = [{
          audio: this.cloneReference.audio,
          text: this.cloneReference.text || '',
        }];
      } else {
        // instruct 模式仍传基底音色（如 claire 女声），由指令控制口音/语气
        body.voice = `${SF_MODEL}:${this.sfVoice}`;
      }
      const res = await fetch(SF_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.sfApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (gen !== this.generation) return;

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`TTS HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const blob = await res.blob();
      if (gen !== this.generation) return;

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.currentAudio = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.currentAudio = null;
        if (gen === this.generation) this._speakNext();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        this.currentAudio = null;
        if (gen === this.generation) this._speakNext();
      };

      await audio.play();
    } catch (e) {
      console.error('Silicon Flow TTS error, fallback to Web Speech:', e);
      // 克隆失败时提示用户（不打断对话流）
      if (this.onCloneError && this.cloneReference) {
        try { this.onCloneError(e); } catch {}
      }
      if (gen === this.generation) this._speakWebSpeech(text);
    }
  }

  get synth() { return window.speechSynthesis; }

  waitForComplete() {
    return new Promise(resolve => {
      if (!this.speaking && this.queue.length === 0 && !this.buffer) {
        resolve();
        return;
      }
      this._resolveWait = resolve;
    });
  }

  // 严格等播完：正在播放或有队列就等结束，否则立即 resolve。
  // 与 waitForComplete 的区别：即使 buffer 非空也视为"还有内容"，一定等队列耗尽。
  whenIdle() {
    return new Promise(resolve => {
      if (!this.speaking && this.queue.length === 0) {
        resolve();
        return;
      }
      const check = () => {
        if (!this.speaking && this.queue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 150);
        }
      };
      check();
    });
  }

  stop() {
    this.generation++;
    this.paused = false;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio = null;
    }
    window.speechSynthesis.cancel();
    this.queue = [];
    this.buffer = '';
    this.speaking = false;
    if (this._resolveWait) {
      this._resolveWait();
      this._resolveWait = null;
    }
  }

  // ===== 暂停 / 继续 =====
  // 暂停：停掉正在播的音频，但保留队列与 buffer，恢复后可继续
  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.currentAudio) {
      this.currentAudio.pause();
    }
    window.speechSynthesis.pause();
  }

  // 继续：从暂停处恢复播放
  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.currentAudio) {
      this.currentAudio.play().catch(() => {});
      return;
    }
    window.speechSynthesis.resume();
    // 队列中还有内容则继续播放下一条
    if (this.queue.length > 0 && !this.speaking) {
      this._speakNext();
    }
  }
}