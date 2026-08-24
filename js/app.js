import { loadConfig, saveConfig } from './config.js';
import { SpeechRecognizer, isASRSupported } from './asr.js';
import { streamChat, testConnection, extractMemories } from './llm.js';
import { SpeechSynth, getVoices, onVoicesReady, SF_VOICES, testSFConnection } from './tts.js';
import { saveMemory, getMemories, recallMemories, deleteMemory, clearMemories } from './memory.js';
import {
  getCharacters,
  getActiveCharacterId,
  setActiveCharacterId,
  getActiveCharacter,
  addCharacter,
  updateCharacter,
  deleteCharacter,
  isPreset,
  isDownloaded,
  markDownloaded,
  getRemoteAssetURLs,
} from './characters.js';
import { downloadCharacterAssets } from './character-download.js';
import { getAssets } from './asset-store.js';
import { MediaPicker } from './media-picker.js';
import { getMedia, isStoredMedia, saveMedia } from './media-store.js';
import { generateImage } from './imagegen.js';
import { saveChat, loadChat, removeChat } from './chat-store.js';
import { Orb } from './orb.js';

// ===== 焦点陷阱（弹窗内循环焦点） =====
let _lastFocused = null;
function trapFocus(container) {
  _lastFocused = document.activeElement;
  const focusable = container.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length > 0) focusable[0].focus();
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', handler);
  container._focusTrapHandler = handler;
}
function releaseFocus(container) {
  if (container._focusTrapHandler) {
    container.removeEventListener('keydown', container._focusTrapHandler);
    container._focusTrapHandler = null;
  }
  if (_lastFocused) _lastFocused.focus();
}

// ===== 状态机 =====
const State = { IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking', PAUSED: 'paused' };
let state = State.IDLE;
let inCall = false;
let callPaused = false;

// ===== 配置 =====
let config = loadConfig();

// ===== 当前人物 =====
let activeChar = getActiveCharacter();

// ===== 会话 =====
let messages = [];
let aiResponseBuffer = '';
let abortController = null;
let replyGeneration = 0; // 回复代次：新消息递增，旧请求的 finally 检测到代次变化则不再恢复旧会话状态

// ===== 实例 =====
let recognizer = null;
let tts = null;
let volumeMonitor = null;
let orb = null; // 语音状态光球（React Bits Orb 移植，纯 WebGL）

// ===== UI 元素 =====
const $ = (id) => document.getElementById(id);
const el = {
  statusOrb: $('statusOrb'),
  orbMicIcon: $('orbMicIcon'),
  status: $('status'),
  subtitleUser: $('subtitleUser'),
  subtitleAI: $('subtitleAI'),
  transcriptPanel: $('transcriptPanel'),
  transcriptList: $('transcriptList'),
  settingsBtn: $('settingsBtn'),
  settingsModal: $('settingsModal'),
  closeSettingsBtn: $('closeSettingsBtn'),
  interruptToggle: $('interruptToggle'),
  testBtn: $('testBtn'),
  testSFBtn: $('testSFBtn'),
  testCloneBtn: $('testCloneBtn'),
  testResult: $('testResult'),
  saveSettingsBtn: $('saveSettingsBtn'),
  clearTranscriptBtn: $('clearTranscriptBtn'),
  exportTranscriptBtn: $('exportTranscriptBtn'),

  // 记忆相关
  memoryBtn: $('memoryBtn'),
  memoryPanel: $('memoryPanel'),
  memoryCount: $('memoryCount'),
  memoryList: $('memoryList'),
  clearMemoryBtn: $('clearMemoryBtn'),
  memoryToggle: $('memoryToggle'),
  voiceCloneToggle: $('voiceCloneToggle'),

  // 人物相关
  callName: $('callName'),
  callNameInput: $('callNameInput'),
  charPrev: $('charPrev'),
  charNext: $('charNext'),
  characterModal: $('characterModal'),
  characterModalTitle: $('characterModalTitle'),
  closeCharacterBtn: $('closeCharacterBtn'),
  charNameInput: $('charNameInput'),
  charPromptInput: $('charPromptInput'),
  charVoiceSelect: $('charVoiceSelect'),
  charRateSlider: $('charRateSlider') || null,
  charRateValue: $('charRateValue') || null,
  charPitchSlider: $('charPitchSlider') || null,
  charPitchValue: $('charPitchValue') || null,
  charMediaPicker: $('charMediaPicker'),
  saveCharacterBtn: $('saveCharacterBtn'),
  deleteCharacterBtn: $('deleteCharacterBtn'),
  imagePanel: $('imagePanel'),
  sideVideo: $('sideVideo'),

  // 所有角色页面
  allCharactersBtn: $('allCharactersBtn'),
  charactersPage: $('charactersPage'),
  closeCharactersBtn: $('closeCharactersBtn'),
  pageAddCharBtn: $('pageAddCharBtn'),
  charGridPresets: $('charGridPresets'),
  charGridCustom: $('charGridCustom'),
  charDownloadBadge: $('charDownloadBadge'),
  charSearchInput: $('charSearchInput'),

  // 文字输入
  textInputBar: $('textInputBar'),
  textInput: $('textInput'),
  sendBtn: $('sendBtn'),
};

// ===== 状态切换 =====
function setState(newState) {
  state = newState;
  // 光球 className：通话中保留 active（激活态辉光背景，最底层），再叠状态类（图标配色/动效驱动）
  el.statusOrb.className = `status-orb${inCall ? ' active' : ''} ${newState}`;
  if (orb) orb.setState(newState);
  const labels = {
    [State.IDLE]: '点击麦克风开始通话',
    [State.LISTENING]: '正在聆听...',
    [State.THINKING]: '正在思考...',
    [State.SPEAKING]: '正在回答...',
    [State.PAUSED]: '已暂停，点击继续',
  };
  el.status.textContent = labels[newState] || '';
}

// ===== 通话控制 =====
async function startCall() {
  inCall = true;
  el.transcriptPanel.classList.add('expanded');
  // 语音通话接管会话：复用/重置 TTS，文字会话标记关闭（TTS 归通话管）
  textChat.active = false;
  textChat.busy = false;
  el.sendBtn.disabled = false;
  if (tts) tts.stop();
  tts = new SpeechSynth();
  applyTTSSettings();
  messages = [];
  aiResponseBuffer = '';

  // 新会话开场：角色先开口说 Greeting（如有）
  ensureGreetingSeeded();
  let hasGreeting = false;
  if (messages.length > 0 && tts) {
    const seedMsg = messages[messages.length - 1];
    if (seedMsg.role === 'assistant' && seedMsg.content) {
      hasGreeting = true;
      tts.feedText(seedMsg.content);
      tts.flush();
    }
  }

  // 初始化音量监听（用于打断检测）
  if (config.allowInterrupt) {
    volumeMonitor = new VolumeMonitor();
    volumeMonitor.onInterrupt = handleInterrupt;
    try {
      await volumeMonitor.start();
    } catch (e) {
      console.warn('音量监听启动失败:', e);
      volumeMonitor = null;
    }
  }

  // 初始化语音识别
  try {
    recognizer = new SpeechRecognizer();
  } catch (e) {
    el.status.textContent = e.message;
    endCall();
    return;
  }
  setupRecognizer();

  // 开场有问候语：先等 TTS 播完再开始聆听，避免麦克风把扬声器里的问候语
  // 识别成"用户说的话"发给 LLM（Helen 的"宝宝你可算来啦"被当成用户输入就是这个问题）
  if (hasGreeting) {
    setState(State.SPEAKING);
    try { await tts.whenIdle(); } catch (e) { console.warn('TTS whenIdle error:', e); }
  }
  startListening();
}

function endCall() {
  inCall = false;
  callPaused = false;

  if (recognizer) { recognizer.stop(); recognizer = null; }
  if (tts) { tts.stop(); tts = null; }
  if (volumeMonitor) { volumeMonitor.stop(); volumeMonitor = null; }
  if (abortController) { abortController.abort(); abortController = null; }

  setState(State.IDLE);
  el.subtitleUser.textContent = '';
  el.subtitleAI.textContent = '';
  el.status.textContent = '通话结束，可继续输入文字聊天';
}

// ===== 中间控件：点击说话 / 再次点击暂停（未通话时点击 = 开始通话） =====
const MIC_ICON_PAUSED = `
  <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>`;
// 暂停态：麦克风斜杠（表示"已静音/暂停"）
const MIC_ICON_MUTED = `
  <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
    <line x1="3" y1="3" x2="21" y2="21"/>
  </svg>`;
function syncOrbIcon() {
  // 只更新图标容器内容，绝不动 .orb-canvas（WebGL 光球动效）
  if (el.orbMicIcon) {
    el.orbMicIcon.innerHTML = (inCall && callPaused) ? MIC_ICON_MUTED : MIC_ICON_PAUSED;
  }
}

function togglePause() {
  // 未在通话：点击 = 开始通话（开麦说话）
  if (!inCall) {
    startCall();
    return;
  }
  if (callPaused) {
    resumeCall();
  } else {
    pauseCall();
  }
}

function pauseCall() {
  if (callPaused || !inCall) return;
  callPaused = true;
  // 停掉语音识别（避免暂停时还收音）
  if (recognizer) recognizer.stop();
  // 停掉音量打断监听
  if (volumeMonitor) volumeMonitor.pause();
  // 暂停 TTS 播放（保留队列，恢复后可继续）
  if (tts) tts.pause();
  // 暂停时若 LLM 还在流式输出，先不打断，恢复后再播放；这里只停语音
  syncOrbIcon();
  setState(State.PAUSED);
}

function resumeCall() {
  if (!callPaused || !inCall) return;
  callPaused = false;
  // 恢复 TTS 播放（队列有内容则继续播）
  if (tts) tts.resume();
  if (volumeMonitor) volumeMonitor.resume();
  syncOrbIcon();
  // 如果有待播内容或正在播放，保持发声态；否则恢复聆听
  if (state === State.PAUSED) {
    if (tts && (tts.speaking || tts.queue.length > 0 || tts.buffer)) {
      setState(State.SPEAKING);
    } else {
      startListening();
    }
  }
}

function startListening() {
  if (!inCall || !recognizer) return;
  if (callPaused) return; // 暂停中不启动识别
  el.subtitleUser.textContent = '';
  el.subtitleAI.textContent = '';
  aiResponseBuffer = '';
  if (volumeMonitor) volumeMonitor.pause();
  recognizer.start();
  setState(State.LISTENING);
}
function setupRecognizer() {
  recognizer.onInterim = (text) => {
    el.subtitleUser.textContent = text;
  };

  // 防抖：用户连续说话时，把 1.2 秒内识别的多段合并为一句，只发一次 LLM
  // （asr 层已按停顿合并，这里兜底拦截"静音被识别成多段"的极端情况）
  let debounceTimer = null;
  let pendingText = '';
  const flushRecognized = () => {
    const text = pendingText.trim();
    pendingText = '';
    debounceTimer = null;
    if (!text || state !== State.LISTENING) return;
    recognizer.stop();
    handleUserMessage(text);
  };
  recognizer.onFinal = (text) => {
    if (!text || state !== State.LISTENING) return;
    recognizer.stop();
    pendingText = (pendingText ? pendingText + '。' : '') + text;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushRecognized, 1200);
  };

  recognizer.onError = (error) => {
    if (error === 'not-allowed' || error === 'service-not-allowed') {
      el.status.textContent = '麦克风权限被拒绝，请允许后重试';
      endCall();
    }
  };

  recognizer.onEnd = () => {
    // asr 内部已按停顿节流自动重启；这里兜底：仍在聆听中且 asr 没在跑才重启
    if (inCall && state === State.LISTENING && !recognizer.isListening) {
      recognizer.start();
    }
  };
}

// ===== 长期记忆 =====
// 全局对话规则：像真人说话，禁止括号行为描述
const GLOBAL_CHAT_RULES = `【对话规则——必须严格遵守】
1. 你是在和用户通电话/聊天，说话要像正常人一样自然，直接说内容本身。
2. 绝对不要使用任何括号来描写动作、表情、语气或心理活动。不要出现"（笑）""（温柔地说）""（停顿）""（摸了摸头）""（叹气）""（心里想）"之类的内容。
3. 需要表达情绪时，直接用文字说出来（比如"哈哈""唉""我太开心了"），而不是描写动作。
4. 回复口语化、简短，像真人聊天。
5. 绝对不要重复自己说过的话。同一句话、同一个观点、同一个句式只准说一次，禁止复读、循环、回环式重复，禁止在结尾重复开头的内容。如果觉得内容不够，就补充新信息，而不是重复旧内容。`;

// 构造带记忆的 system prompt
async function buildSystemPrompt() {
  let base = activeChar.systemPrompt || '你是一个友好的 AI 语音助手。';
  // 简短描述（c.ai 的 Short Description）：作为一句话简介放在人设前
  if (activeChar.tagline) {
    base = `人物简介：${activeChar.tagline}\n\n${base}`;
  }
  const withRules = `${base}

${GLOBAL_CHAT_RULES}`;
  if (config.memoryEnabled === false) return withRules;
  const mems = await recallMemories(activeChar.id, [], 12);
  if (!mems || mems.length === 0) return withRules;
  const lines = mems.map(m => `- [${new Date(m.ts).toLocaleDateString('zh-CN')}] ${m.text}`);
  return `${withRules}

【你对用户的长期记忆，请在对话中自然运用，不要生硬复述】
${lines.join('\n')}`;
}

// 首次对话注入角色开场白（c.ai 的 Greeting）：用户还没说过话时，TA 先开口
// 同一会话只注入一次（注入后 messages 里已有 assistant 消息，不会再触发）
function ensureGreetingSeeded() {
  if (!activeChar.greeting) return;
  if (messages.some(m => m.role === 'user')) return;
  if (messages.some(m => m.role === 'assistant')) return;
  messages.push({ role: 'assistant', content: activeChar.greeting });
  addTranscriptItem('ai', activeChar.greeting);
  persistCurrentChat();
}

// 对话结束后异步提取记忆（不阻塞通话）
async function extractAndStoreMemories() {
  if (config.memoryEnabled === false) return;
  if (!config.apiKey || messages.length === 0) return;
  try {
    const recent = messages.slice(-10);
    const items = await extractMemories(config.apiKey, recent);
    for (const it of items) {
      if (!it || !it.topic || !it.text) continue;
      await saveMemory(activeChar.id, {
        topic: String(it.topic).slice(0, 50),
        text: String(it.text).slice(0, 200),
        importance: Number(it.importance) || 3,
      });
    }
    if (items.length > 0) refreshMemoryPanel();
  } catch (e) {
    // 提取失败静默忽略，不影响对话
    console.warn('记忆提取失败:', e);
  }
}

// ===== 处理用户消息 =====
async function handleUserMessage(text) {
  // 新会话开场：先让角色说 Greeting
  ensureGreetingSeeded();
  messages.push({ role: 'user', content: text });
  persistCurrentChat(); // 消息变更即保存，防丢
  addTranscriptItem('user', text);
  el.subtitleUser.textContent = text;
  el.subtitleAI.textContent = '';

  setState(State.THINKING);
  el.subtitleAI.innerHTML = '<span class="skeleton-dots"><span></span><span></span><span></span></span>';

  abortController = new AbortController();
  aiResponseBuffer = '';
  let hasStartedSpeaking = false;

  try {
    const systemPrompt = await buildSystemPrompt();
    // 等克隆参考音频就绪，避免首句用错音色
    await cloneRefReady.catch(() => {});
    const fullResponse = await streamChat(
      messages,
      config.apiKey,
      systemPrompt,
      (chunk) => {
        aiResponseBuffer += chunk;
        el.subtitleAI.textContent = aiResponseBuffer;

        if (!hasStartedSpeaking) {
          hasStartedSpeaking = true;
          // 暂停中：不强制切 SPEAKING，保持暂停态
          if (!callPaused) {
            setState(State.SPEAKING);
            if (volumeMonitor) volumeMonitor.resume();
          }
        }
        if (tts) tts.feedText(chunk);
      },
      abortController.signal
    );

    if (tts) tts.flush();

    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
      persistCurrentChat(); // 消息变更即保存
      addTranscriptItem('ai', fullResponse);
    }

    if (tts && !callPaused) await tts.waitForComplete();

    // 暂停中：不自动恢复聆听，等用户点继续
    if (inCall && !callPaused) startListening();

    // 异步提取记忆（通话继续，不等待）
    extractAndStoreMemories();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('LLM 错误:', e);
    let msg = e.message;
    if (e instanceof TypeError && msg.includes('Failed to fetch')) {
      msg = '网络/CORS 错误: DeepSeek API 可能无法从浏览器直接访问';
    }
    el.status.textContent = '出错: ' + msg;
    if (inCall) setTimeout(() => startListening(), 2000);
  } finally {
    abortController = null;
  }
}

// ===== 打断处理 =====
function handleInterrupt() {
  if (state !== State.SPEAKING || callPaused) return;

  if (tts) tts.stop();
  if (abortController) abortController.abort();

  if (aiResponseBuffer) {
    messages.push({ role: 'assistant', content: aiResponseBuffer });
    persistCurrentChat(); // 打断也保存已生成部分
    addTranscriptItem('ai', aiResponseBuffer + ' [被打断]');
    aiResponseBuffer = '';
  }

  if (inCall) startListening();
}

// ===== 文字输入 =====
let textChat = { active: false, busy: false };

// 通话中发文字：停掉语音识别，等 AI 回完再恢复
function sendTextMessage() {
  const text = el.textInput.value.trim();
  if (!text) return;

  // AI 思考/回复中发文字 → 立即打断当前回复：
  // 1. 停掉正在播放的语音（清队列 + 停当前音频）
  if (tts) tts.stop();
  // 2. 中断 LLM 流式生成；已生成的部分同步保存为 [已打断]，避免与新消息交错
  if (abortController) {
    abortController.abort();
    abortController = null;
    if (aiResponseBuffer) {
      messages.push({ role: 'assistant', content: aiResponseBuffer });
      persistCurrentChat();
      addTranscriptItem('ai', aiResponseBuffer + ' [已打断]');
      aiResponseBuffer = '';
    }
  }
  // 3. 重置文字会话状态，允许立刻发起新消息（不再被 busy 拦截）
  textChat.busy = false;
  el.sendBtn.disabled = false;

  el.textInput.value = '';
  textChat.busy = true;
  el.sendBtn.disabled = true;

  // 不在语音通话中：开启文字聊天模式（懒初始化 TTS，保留会话）
  if (!inCall) {
    textChat.active = true;
    if (!tts) {
      tts = new SpeechSynth();
      applyTTSSettings();
    }
  } else if (recognizer && state === State.LISTENING) {
    // 通话中：暂停识别，避免识别到 TTS 回声
    recognizer.stop();
  }

  handleTextMessage(text);
}

async function handleTextMessage(text) {
  // 本请求代次：新消息使旧请求的 finally 失效（不再恢复旧会话状态）
  const myGen = ++replyGeneration;
  // 新会话开场：先让角色说 Greeting
  ensureGreetingSeeded();
  el.transcriptPanel.classList.add('expanded');
  messages.push({ role: 'user', content: text });
  addTranscriptItem('user', text);
  el.subtitleUser.textContent = text;
  el.subtitleAI.textContent = '';

  setState(State.THINKING);

  abortController = new AbortController();
  aiResponseBuffer = '';
  let hasStartedSpeaking = false;

  try {
    const systemPrompt = await buildSystemPrompt();
    // 等克隆参考音频就绪，避免首句用错音色
    await cloneRefReady.catch(() => {});
    const fullResponse = await streamChat(
      messages,
      config.apiKey,
      systemPrompt,
      (chunk) => {
        aiResponseBuffer += chunk;
        el.subtitleAI.textContent = aiResponseBuffer;
        if (!hasStartedSpeaking) {
          hasStartedSpeaking = true;
          setState(State.SPEAKING);
          // 通话中：TTS 开始播放时恢复音量监听（带回声校准）
          if (inCall && volumeMonitor) volumeMonitor.resume();
        }
        if (tts) tts.feedText(chunk);
      },
      abortController.signal
    );

    if (tts) tts.flush();

    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
      persistCurrentChat(); // 消息变更即保存
      addTranscriptItem('ai', fullResponse);
    }

    if (tts) await tts.waitForComplete();

    // 异步提取记忆
    extractAndStoreMemories();
  } catch (e) {
    if (e.name === 'AbortError') {
      // 被新消息打断：仅当仍是本轮请求才保存已生成部分（sendTextMessage 已同步保存过的为空，不重复）
      if (myGen === replyGeneration && aiResponseBuffer) {
        messages.push({ role: 'assistant', content: aiResponseBuffer });
        persistCurrentChat(); // 打断也保存已生成部分
        addTranscriptItem('ai', aiResponseBuffer + ' [已打断]');
        aiResponseBuffer = '';
      }
    } else {
      console.error('LLM 错误:', e);
      let msg = e.message;
      if (e instanceof TypeError && msg.includes('Failed to fetch')) {
        msg = '网络/CORS 错误: DeepSeek API 可能无法从浏览器直接访问';
      }
      el.status.textContent = '出错: ' + msg;
    }
  } finally {
    // 仅当仍是本轮请求（未被新消息取代）时才清理并恢复会话状态
    if (myGen === replyGeneration) {
      abortController = null;
      textChat.busy = false;
      el.sendBtn.disabled = false;

      // 通话中：恢复语音识别；纯文字模式：回到就绪态
      if (inCall) {
        startListening();
      } else {
        setState(State.IDLE);
        el.status.textContent = textChat.active ? '继续输入文字聊天，或点麦克风语音通话' : '';
      }
    }
  }
}

// 结束文字聊天会话（切人物 / 清空记录时调用）
function endTextChat() {
  if (textChat.active && tts) {
    tts.stop();
    tts = null;
  }
  textChat.active = false;
  textChat.busy = false;
  el.sendBtn.disabled = false;
}

// 渲染一条消息到记录面板
// 参数 charName：角色名快照（历史消息用当时名字，当前消息用 activeChar.name）
function addTranscriptItem(role, text, charName) {
  const item = document.createElement('div');
  item.className = `transcript-item ${role}`;
  const label = role === 'user' ? '你' : (charName || activeChar.name);
  item.innerHTML = `<div class="role">${escapeHtml(label)}</div>${escapeHtml(text)}`;
  el.transcriptList.appendChild(item);
  requestAnimationFrame(() => {
    el.transcriptPanel.scrollTo({
      top: el.transcriptPanel.scrollHeight,
      behavior: 'smooth',
    });
  });
}

// 把 messages 数组完整渲染到记录面板（恢复历史时用）
// 历史消息可能带括号行为描述，渲染时清洗一次
function cleanActionParens(text) {
  if (!text) return text;
  // 去掉"（行为描述）"：短括号内容或含动作/语气词的
  const ACTION = /(笑|说|道|叹|点|摇|摸|拍|抱|皱眉|眨眼|停顿|沉思|心想|暗道|轻声|温柔|严肃|认真|微笑|苦笑|大笑|尴尬|无奈|兴奋|激动|温柔地|低声|提高声音|放低声音)/;
  return text
    .replace(/（[^（）]{1,6}）|\([^()]{1,6}\)/g, '') // 短括号内容
    .replace(/（[^（）]*?(笑|说|道|叹|摸|抱|拍|点|摇|皱眉|眨眼|停顿|沉思|心想|轻声|温柔|严肃|微笑|苦笑|尴尬|无奈|激动)[^（）]*?）|\([^()]*?(笑|说|道|叹|摸|抱|拍|点|摇|皱眉|眨眼|停顿|沉思|心想|轻声|温柔|严肃|微笑|苦笑|尴尬|无奈|激动)[^()]*?\)/g, '');
}
function renderTranscript(messages, charName) {
  el.transcriptList.innerHTML = '';
  for (const m of messages || []) {
    if (!m || !m.content) continue;
    addTranscriptItem(m.role, cleanActionParens(m.content), charName);
  }
}

// 把当前角色的会话持久化到 localStorage（切角色 / 页面关闭时调用）
function persistCurrentChat() {
  if (!activeChar || !messages.length) return;
  saveChat(activeChar.id, messages);
}

// 保存当前会话并清空界面（切角色前调用）
function stashCurrentChat() {
  persistCurrentChat();
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (tts) tts.stop();
  aiResponseBuffer = '';
  el.subtitleUser.textContent = '';
  el.subtitleAI.textContent = '';
  el.transcriptList.innerHTML = '';
  messages = [];
}

// 导出当前对话为 Markdown 文件
function exportTranscript() {
  if (!messages || messages.length === 0) return;
  const charName = activeChar.name;
  const date = new Date();
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  let md = `# 与 ${charName} 的对话\n\n> 导出时间：${date.toLocaleString('zh-CN')}\n\n---\n\n`;
  for (const m of messages) {
    if (!m || !m.content) continue;
    const speaker = m.role === 'user' ? '🧑 我' : `💬 ${charName}`;
    const text = cleanActionParens(m.content);
    md += `**${speaker}**\n\n${text}\n\n`;
  }
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `对话_${charName}_${dateStr}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 清空当前会话（记录 + 消息 + 持久化，清空按钮 / 重置时调用）
function clearConversation() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (tts) tts.stop();
  aiResponseBuffer = '';
  el.subtitleUser.textContent = '';
  el.subtitleAI.textContent = '';
  el.transcriptList.innerHTML = '';
  messages = [];
  saveChat(activeChar.id, []); // 持久化也清掉
}

// ===== 音量监听器（带回声校准） =====
class VolumeMonitor {
  constructor(requiredHits = 5) {
    this.threshold = 35;
    this.requiredHits = requiredHits;
    this.hitCount = 0;
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;
    this.intervalId = null;
    this.paused = true;
    this.calibrating = false;
    this.calibrationSamples = [];
    this.calibrationTimer = null;
    this.onInterrupt = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);

    this.intervalId = setInterval(() => this._check(), 100);
  }

  _getVolume() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data.reduce((a, b) => a + b, 0) / data.length;
  }

  _check() {
    if (this.paused || !this.onInterrupt) return;
    const avg = this._getVolume();

    // 校准阶段：只采样，不触发打断
    if (this.calibrating) {
      this.calibrationSamples.push(avg);
      return;
    }

    if (avg > this.threshold) {
      this.hitCount++;
      if (this.hitCount >= this.requiredHits) {
        this.hitCount = 0;
        this.onInterrupt();
      }
    } else {
      this.hitCount = 0;
    }
  }

  pause() {
    this.paused = true;
    this.hitCount = 0;
    this.calibrating = false;
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
  }

  resume() {
    this.paused = false;
    this.hitCount = 0;

    // 校准阶段：测量 TTS 回声基准值（500ms）
    this.calibrating = true;
    this.calibrationSamples = [];

    this.calibrationTimer = setTimeout(() => {
      this.calibrating = false;
      this.calibrationTimer = null;

      if (this.calibrationSamples.length > 0) {
        const peak = Math.max(...this.calibrationSamples);
        const baseline = this.calibrationSamples.reduce((a, b) => a + b, 0) / this.calibrationSamples.length;
        // 阈值 = max(回声峰值 * 1.5 + 8, 平均值 + 18, 28)
        // 确保只有比 TTS 回声大得多的声音才能触发打断
        this.threshold = Math.max(peak * 1.5 + 8, baseline + 18, 28);
      }
    }, 500);
  }

  stop() {
    clearInterval(this.intervalId);
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audioContext) this.audioContext.close();
    this.intervalId = null;
    this.stream = null;
    this.audioContext = null;
  }
}

// ===== UI 辅助 =====
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// 克隆参考音频缓存：url -> dataURI
const cloneRefCache = new Map();
// 当前克隆参考是否就绪（Promise<boolean>）
let cloneRefReady = Promise.resolve(false);

async function loadCloneRef(url) {
  if (cloneRefCache.has(url)) return cloneRefCache.get(url);
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const dataURI = await blobToDataURI(blob);
    cloneRefCache.set(url, dataURI);
    return dataURI;
  } catch (e) {
    console.warn('加载克隆参考音频失败:', e);
    return null;
  }
}

// Blob → dataURI（用于把已下载到本地的克隆参考音频喂给 TTS）
function blobToDataURI(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function applyTTSSettings() {
  if (!tts) return;
  const rate = activeChar.rate ?? config.rate ?? 1;
  const pitch = activeChar.pitch ?? config.pitch ?? 1;
  tts.setRate(rate);
  tts.setPitch(pitch);
  // 语音提供商：硅基流动（有 Key 即可用；角色配了克隆音频走原声音色，否则用预设音色）
  tts.setSFApiKey(config.siliconFlowApiKey || '');
  tts.setSFVoice(activeChar.ttsVoice || 'claire');
  tts.setTTSInstruct(activeChar.ttsInstruct || '');
  tts.setUseSiliconFlow(!!config.siliconFlowApiKey);
  // 声音克隆：有参考音频且开关开启时加载（Promise 形式，可等待加载完成）
  const vc = activeChar.voiceClone;
  tts.onCloneError = (e) => {
    console.warn('声音克隆失败，已回退预置音色:', e.message || e);
  };
  if (vc && vc.ref && vc.text && config.voiceCloneEnabled !== false && config.siliconFlowApiKey) {
    cloneRefReady = (async () => {
      let dataURI = null;
      // 已下载到本地的角色：优先用本地克隆音频（离线/秒开）
      if (isDownloaded(activeChar.id)) {
        const assets = await getAssets(activeChar.id);
        if (assets && assets.clone) dataURI = await blobToDataURI(assets.clone);
      }
      if (!dataURI) dataURI = await loadCloneRef(vc.ref);
      if (dataURI && tts) {
        tts.setCloneReference({ audio: dataURI, text: vc.text });
        tts.setCloneNoInstruct(!!activeChar.cloneNoInstruct);
        return true;
      }
      return false;
    })();
  } else {
    cloneRefReady = Promise.resolve(false);
    if (tts) tts.setCloneReference(null);
  }
  // 浏览器语音（备用）：优先角色级 voiceURI，兼容旧全局 config.voiceURI
  const voiceURI = activeChar.voiceURI ?? config.voiceURI ?? '';
  if (voiceURI) {
    const voice = getVoices().find(v => v.voiceURI === voiceURI);
    if (voice) tts.setVoice(voice);
  }
}

// ===== 人物管理 =====
function switchTo(offset) {
  const list = getCharacters();
  if (list.length < 2) return;
  const idx = list.findIndex(c => c.id === activeChar.id);
  const next = list[(idx + offset + list.length) % list.length];

  // === 立即打断当前对话与语音，不等 AI 回复 / TTS 播完 ===
  // 1) 保存 AI 已生成的部分回复（流式被中断前已输出的内容）
  if (aiResponseBuffer) {
    messages.push({ role: 'assistant', content: aiResponseBuffer });
    aiResponseBuffer = '';
  }
  // 2) 语音通话中：结束通话（内部停语音识别/音量打断监听/停 TTS/打断 LLM，状态回 IDLE）
  if (inCall) endCall();
  // 3) 文字聊天中：复位 busy 并停 TTS
  if (textChat.active || textChat.busy) {
    textChat.active = false;
    textChat.busy = false;
    el.sendBtn.disabled = false;
    if (tts) tts.stop();
  }

  // 保存当前角色会话并清界面
  stashCurrentChat();
  setActiveCharacterId(next.id);
  activeChar = next;
  endTextChat();
  updateCurrentCharacterUI();
  // 立即应用新角色的 TTS 配置（音色/口音指令/克隆参考），避免残留上一角色的声音
  applyTTSSettings();
  // 恢复新角色历史
  const saved = loadChat(activeChar.id);
  messages = saved || [];
  renderTranscript(messages, activeChar.name);
  refreshMemoryPanel();
  el.status.textContent = `已切换到 ${activeChar.name}，点击麦克风开始通话`;
}

// ===== 人物形象渲染 =====
// 返回 { src, isVideo }，db: 引用解析为 blob URL
async function resolveCharMedia(media) {
  if (!media) return null;
  if (isStoredMedia(media)) {
    const rec = await getMedia(media.slice(3));
    if (!rec) return null;
    return {
      src: URL.createObjectURL(rec.blob),
      isVideo: rec.type.startsWith('video/'),
    };
  }
  return {
    src: media,
    isVideo: /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(media),
  };
}

let currentMediaUrl = null;

async function updateCurrentCharacterUI() {
  el.callName.textContent = activeChar.name;
  el.callNameInput.value = activeChar.name;
  if (el.subtitleAI) el.subtitleAI.dataset.name = activeChar.name;
  document.documentElement.style.setProperty('--char-accent', activeChar.accent || '#4dabf7');

  // 清理旧媒体节点与 blob URL
  el.imagePanel.querySelectorAll('img.side-video').forEach(im => im.remove());
  if (currentMediaUrl) {
    URL.revokeObjectURL(currentMediaUrl);
    currentMediaUrl = null;
  }
  el.sideVideo.style.display = 'none';
  el.sideVideo.pause();
  el.sideVideo.removeAttribute('src');
  el.sideVideo.load();

  // 已下载到本地的角色：优先用本地素材（离线可用、秒开）
  let media = null;
  if (isDownloaded(activeChar.id)) {
    const assets = await getAssets(activeChar.id);
    if (assets && assets.media) {
      const url = URL.createObjectURL(assets.media);
      media = { src: url, isVideo: assets.mediaType === 'video' };
      currentMediaUrl = url;
    }
  }
  if (!media) media = await resolveCharMedia(activeChar.media);
  if (!media) {
    // 默认形象：高度自适应（cover 撑满面板高度，避免 contain 上下黑边）
    el.imagePanel.classList.add('default-media');
    el.sideVideo.src = 'assets/girlfriend.mp4';
    el.sideVideo.classList.add('fit-fill');
    el.sideVideo.style.display = '';
    el.sideVideo.play().catch((e) => console.warn('Video autoplay failed:', e));
  } else {
    el.imagePanel.classList.remove('default-media');
    el.sideVideo.classList.remove('fit-fill');
    if (media.isVideo) {
      el.sideVideo.src = media.src;
      el.sideVideo.style.display = '';
      el.sideVideo.play().catch((e) => console.warn('Video autoplay failed:', e));
      if (isStoredMedia(activeChar.media)) currentMediaUrl = media.src;
    } else {
      const img = document.createElement('img');
      img.src = media.src;
      img.className = 'side-video';
      img.alt = activeChar.name;
      el.imagePanel.insertBefore(img, el.imagePanel.firstChild);
      if (isStoredMedia(activeChar.media)) currentMediaUrl = media.src;
    }
  }

  // 更新主页面下载状态徽标
  updateDownloadBadge();
}

function switchCharacter(id) {
  const list = getCharacters();
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) switchTo(idx - list.findIndex(c => c.id === activeChar.id));
}

// ===== 角色库（所有角色 + 按需下载素材） =====
const downloadingIds = new Set();

// 主页面角色标识区的下载状态徽标
function updateDownloadBadge() {
  const badge = el.charDownloadBadge;
  if (!badge) return;
  const { mediaUrl, cloneUrl } = getRemoteAssetURLs(activeChar);
  const downloadable = !!(mediaUrl || cloneUrl);
  if (!downloadable) {
    badge.textContent = '本地角色';
    badge.className = 'char-download-badge local';
    badge.disabled = true;
  } else if (isDownloaded(activeChar.id)) {
    badge.textContent = '已下载 ✓';
    badge.className = 'char-download-badge done';
    badge.disabled = false;
  } else {
    badge.textContent = '未下载';
    badge.className = 'char-download-badge todo';
    badge.disabled = false;
  }
}

// Helen（girlfriend 预设）默认提前下载素材，后台静默执行
async function autoDownloadHelen() {
  const HELEN_ID = 'girlfriend';
  if (isDownloaded(HELEN_ID)) return;
  const char = getCharacters().find(c => c.id === HELEN_ID);
  if (!char) return;
  const { mediaUrl, cloneUrl } = getRemoteAssetURLs(char);
  if (!mediaUrl && !cloneUrl) return;
  downloadingIds.add(HELEN_ID);
  try {
    await downloadCharacterAssets(char);
    markDownloaded(HELEN_ID);
    // 若当前正在查看 Helen，刷新主页面媒体
    if (activeChar.id === HELEN_ID) {
      updateCurrentCharacterUI();
    }
  } catch (e) {
    console.warn('Helen 自动下载失败:', e);
  } finally {
    downloadingIds.delete(HELEN_ID);
  }
}

function openCharactersPage() {
  renderCharactersPage();
  el.charactersPage.classList.add('show');
  trapFocus(el.charactersPage);
}

function closeCharactersPage() {
  el.charactersPage.classList.remove('show');
  releaseFocus(el.charactersPage);
  // 关闭页面时同步关闭编辑面板
  closeCharacterModal();
}

// 构建角色卡片媒体预览（视频/图片缩略图）
async function buildCardMedia(char, container) {
  let mediaEl = null;
  let cardBlobUrl = null;

  // 已下载到本地的角色：用本地素材做预览
  if (isDownloaded(char.id)) {
    const assets = await getAssets(char.id);
    if (assets && assets.media) {
      cardBlobUrl = URL.createObjectURL(assets.media);
      if (assets.mediaType === 'video') {
        mediaEl = document.createElement('video');
        mediaEl.src = cardBlobUrl;
        mediaEl.muted = true;
        mediaEl.loop = true;
        mediaEl.autoplay = true;
        mediaEl.playsInline = true;
        mediaEl.preload = 'metadata';
      } else {
        mediaEl = document.createElement('img');
        mediaEl.src = cardBlobUrl;
      }
    }
  }

  // 没有本地素材：尝试远程路径或 db: 引用
  if (!mediaEl) {
    const media = await resolveCharMedia(char.media);
    if (media) {
      if (media.isVideo) {
        mediaEl = document.createElement('video');
        mediaEl.src = media.src;
        mediaEl.muted = true;
        mediaEl.loop = true;
        mediaEl.autoplay = true;
        mediaEl.playsInline = true;
        mediaEl.preload = 'metadata';
      } else {
        mediaEl = document.createElement('img');
        mediaEl.src = media.src;
      }
    }
  }

  // 默认形象：使用 girlfriend.mp4
  if (!mediaEl && isPreset(char.id)) {
    mediaEl = document.createElement('video');
    mediaEl.src = 'assets/girlfriend.mp4';
    mediaEl.muted = true;
    mediaEl.loop = true;
    mediaEl.autoplay = true;
    mediaEl.playsInline = true;
    mediaEl.preload = 'metadata';
  }

  if (mediaEl) {
    if (cardBlobUrl) mediaEl.dataset.blobUrl = cardBlobUrl;
    container.appendChild(mediaEl);
  } else {
    const empty = document.createElement('div');
    empty.className = 'char-card-media-empty';
    container.appendChild(empty);
  }
}

// 清理角色卡片网格中的 blob URL（重新渲染前调用）
function clearCharGrid(grid) {
  grid.querySelectorAll('[data-blob-url]').forEach((el) => {
    URL.revokeObjectURL(el.dataset.blobUrl);
  });
  grid.innerHTML = '';
}

function buildCharacterCard(char) {
  const { mediaUrl, cloneUrl } = getRemoteAssetURLs(char);
  const downloadable = !!(mediaUrl || cloneUrl);
  const isActive = char.id === activeChar.id;

  const card = document.createElement('div');
  card.className = 'char-full-card' + (isActive ? ' is-active' : '');

  // 媒体预览区
  const mediaDiv = document.createElement('div');
  mediaDiv.className = 'char-card-media';
  buildCardMedia(char, mediaDiv);
  card.appendChild(mediaDiv);

  // 卡片内容
  const body = document.createElement('div');
  body.className = 'char-card-body';

  // 第一行：名称 + 标签
  const row1 = document.createElement('div');
  row1.className = 'char-card-row1';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'char-card-name-wrap';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'char-card-name';
  nameSpan.textContent = char.name;
  nameWrap.appendChild(nameSpan);
  const tag = document.createElement('span');
  tag.className = 'char-card-tag' + (isActive ? ' active-now' : '');
  tag.textContent = isActive ? '当前' : (isPreset(char.id) ? '默认' : '自建');
  row1.appendChild(nameWrap);
  row1.appendChild(tag);
  body.appendChild(row1);

  // 第二行：人设描述预览（截断显示）
  if (char.systemPrompt) {
    const promptDiv = document.createElement('div');
    promptDiv.className = 'char-card-prompt';
    promptDiv.textContent = char.systemPrompt.replace(/\n/g, ' ');
    body.appendChild(promptDiv);
  }

  // 第三行：元信息（音色 + 下载状态）
  const meta = document.createElement('div');
  meta.className = 'char-card-meta';
  const voiceInfo = document.createElement('span');
  voiceInfo.className = 'char-card-voice';
  const voiceName = char.ttsVoice
    ? (SF_VOICES.find(v => v.id === char.ttsVoice)?.name || char.ttsVoice)
    : '默认女声';
  voiceInfo.textContent = voiceName;
  meta.appendChild(voiceInfo);
  if (char.voiceClone && char.voiceClone.ref) {
    const cloneTag = document.createElement('span');
    cloneTag.className = 'char-card-voice';
    cloneTag.textContent = '克隆';
    meta.appendChild(cloneTag);
  }
  const dlBadge = document.createElement('span');
  dlBadge.className = 'char-card-dl-badge';
  if (!downloadable) {
    dlBadge.classList.add('local');
    dlBadge.textContent = '本地';
  } else if (isDownloaded(char.id)) {
    dlBadge.classList.add('done');
    dlBadge.textContent = '已下载';
  } else {
    dlBadge.classList.add('todo');
    dlBadge.textContent = '未下载';
  }
  meta.appendChild(dlBadge);
  body.appendChild(meta);

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'char-card-actions';

  // 切换到此角色
  if (!isActive) {
    const switchBtn = document.createElement('button');
    switchBtn.className = 'char-card-btn primary';
    switchBtn.textContent = '切换';
    switchBtn.addEventListener('click', () => {
      switchCharacter(char.id);
      closeCharactersPage();
    });
    actions.appendChild(switchBtn);
  } else {
    const currentBtn = document.createElement('button');
    currentBtn.className = 'char-card-btn';
    currentBtn.textContent = '当前';
    currentBtn.disabled = true;
    actions.appendChild(currentBtn);
  }

  // 编辑
  const editBtn = document.createElement('button');
  editBtn.className = 'char-card-btn';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => openCharacterModal(char.id));
  actions.appendChild(editBtn);

  // 下载/重新下载
  if (downloadable) {
    const dlBtn = document.createElement('button');
    dlBtn.className = 'char-card-btn';
    if (isDownloaded(char.id)) {
      dlBtn.classList.add('done-btn');
      dlBtn.textContent = '重新下载';
      dlBtn.title = '点击重新下载';
    } else {
      dlBtn.textContent = '下载';
    }
    dlBtn.addEventListener('click', () => downloadCharacter(char.id, dlBtn));
    actions.appendChild(dlBtn);
  }

  body.appendChild(actions);
  card.appendChild(body);

  return card;
}

function renderCharactersPage(searchQuery) {
  const list = getCharacters();
  const query = (searchQuery || '').trim().toLowerCase();
  const filtered = query
    ? list.filter((c) => {
        const name = (c.name || '').toLowerCase();
        const prompt = (c.systemPrompt || '').toLowerCase();
        return name.includes(query) || prompt.includes(query);
      })
    : list;
  const presets = filtered.filter((c) => isPreset(c.id));
  const custom = filtered.filter((c) => !isPreset(c.id));

  clearCharGrid(el.charGridPresets);
  clearCharGrid(el.charGridCustom);

  if (presets.length === 0 && custom.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'char-grid-empty';
    empty.textContent = `没有找到匹配"${searchQuery}"的角色`;
    el.charGridPresets.appendChild(empty);
    return;
  }

  presets.forEach((c) => el.charGridPresets.appendChild(buildCharacterCard(c)));

  if (custom.length === 0) {
    if (!query) {
      const empty = document.createElement('div');
      empty.className = 'char-grid-empty';
      empty.textContent = '还没有创建角色，点击右上角「新建角色」';
      el.charGridCustom.appendChild(empty);
    }
  } else {
    custom.forEach((c) => el.charGridCustom.appendChild(buildCharacterCard(c)));
  }
}

async function downloadCharacter(id, btn) {
  if (downloadingIds.has(id)) return;
  const char = getCharacters().find((c) => c.id === id);
  if (!char) return;

  downloadingIds.add(id);
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '下载中…';
  try {
    await downloadCharacterAssets(char, {
      onProgress: (done, total) => {
        btn.textContent = `下载中 ${Math.round((done / total) * 100)}%`;
      },
    });
    markDownloaded(id);
    btn.textContent = '已下载 ✓';
    btn.classList.add('done-btn');
    btn.title = '点击重新下载';
    // 若正在查看该角色，立即刷新主页面媒体与徽标
    if (activeChar.id === id) {
      updateCurrentCharacterUI();
    } else {
      updateDownloadBadge();
    }
    // 刷新角色页面的卡片
    if (el.charactersPage.classList.contains('show')) {
      renderCharactersPage();
    }
  } catch (e) {
    console.warn('下载角色素材失败:', e);
    btn.textContent = '下载失败，重试';
    btn.disabled = false;
  } finally {
    downloadingIds.delete(id);
    if (!isDownloaded(id)) btn.disabled = false;
  }
}

// ===== 角色切换动画（滑动 / 按钮共用） =====
const SWIPE_DURATION = 280; // 移动端滑入动画时长 ms
let charAnimating = false;  // 转场进行中：禁止再次手势/点击，避免叠动画

// 设置形象面板 transform（移动端滑动专用；duration 传 null 表示无过渡，用于定位初始位置）
function setPanelTransform(transform, duration) {
  el.imagePanel.style.transition = duration != null
    ? `transform ${duration}ms cubic-bezier(.22,.61,.36,1)`
    : 'none';
  el.imagePanel.style.transform = transform;
}

// 桌面端点击切换：溶解模糊过渡（淡出+模糊 → 切换 → 淡入+去模糊）
function animateSwitchTo(dir) {
  if (charAnimating) return;
  charAnimating = true;

  const panel = el.imagePanel;
  const FADE_OUT = 180;
  const FADE_IN = 340;

  // Phase 1：旧画面溶解淡出（opacity ↓ + blur ↑ + 微缩放）
  panel.style.transition = `opacity ${FADE_OUT}ms ease, filter ${FADE_OUT}ms ease, transform ${FADE_OUT}ms ease`;
  panel.style.opacity = '0';
  panel.style.filter = 'blur(14px)';
  panel.style.transform = 'scale(1.04)';

  setTimeout(() => {
    // Phase 2：切换角色（内部更新媒体、名称、音色等）
    switchTo(dir);

    // Phase 3：新画面初始态（不可见、模糊、微缩小），无过渡
    panel.style.transition = 'none';
    panel.style.opacity = '0';
    panel.style.filter = 'blur(14px)';
    panel.style.transform = 'scale(0.97)';

    // Phase 4：双 rAF 后新画面溶解淡入（opacity ↑ + blur ↓ + 缩放恢复）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.style.transition = `opacity ${FADE_IN}ms ease, filter ${FADE_IN}ms ease, transform ${FADE_IN}ms cubic-bezier(.22,.61,.36,1)`;
      panel.style.opacity = '1';
      panel.style.filter = 'blur(0px)';
      panel.style.transform = 'scale(1)';

      setTimeout(() => {
        charAnimating = false;
        panel.style.transition = '';
        panel.style.filter = '';
        panel.style.transform = '';
      }, FADE_IN + 40);
    }));
  }, FADE_OUT + 20);
}

// ===== 移动端：角色页面左右滑动切换（滑出旧卡 → 滑入新卡） =====
// 只在窄屏（≤768px，与 CSS 断点一致）且支持触摸时启用。
// 手势挂载在 document：手机端 .image-panel 全屏铺底、被 .app 覆盖，直接监听面板拿不到触摸。
// 排除交互控件 / 弹窗 / 可滚动面板 / 输入区，避免与文字输入、对话记录滚动等冲突。
(function initSwipeNav() {
  const mq = window.matchMedia('(max-width: 768px)');
  if (!mq.matches || !('ontouchstart' in window)) return;

  const SWIPE_DIST = 70;   // 触发切换的最小水平位移 (px)
  const MIN_SLOPE = 1.2;   // 水平位移必须明显大于垂直位移才视为横向滑动
  const FOLLOW = 0.45;     // 拖动跟随系数（阻尼，半跟手）

  let sx = 0, sy = 0, dx = 0, dy = 0;
  let dragging = false;
  let swiping = false;

  function isBlocked(target) {
    // 这些区域内的触摸不响应滑动切换：弹窗、输入、按钮、开关、可滚动面板、名字胶囊
    return !!(target && target.closest) &&
      !!target.closest(
        'button, input, textarea, select, a, .modal, .top-bar, .control-cluster, ' +
        '.transcript-panel, .memory-panel, .text-input-bar, .char-nav, .call-name, .call-name-input'
      );
  }

  document.addEventListener('touchstart', (e) => {
    if (charAnimating) { dragging = false; return; } // 转场中：不响应新手势
    if (isBlocked(e.target)) { dragging = false; return; }
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    dx = 0; dy = 0;
    dragging = true; swiping = false;
    // 拖动中关闭过渡，跟手
    setPanelTransform('', null);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    dx = t.clientX - sx;
    dy = t.clientY - sy;
    // 未判定为横向时：水平移动太小或垂直主导 → 不干预（保留面板/页面自身滚动）
    if (!swiping) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * MIN_SLOPE) return;
      swiping = true;
    }
    e.preventDefault(); // 握住手指阻止页面回弹/滚动
    setPanelTransform(`translateX(${(dx * FOLLOW).toFixed(1)}px)`, null);
  }, { passive: false });

  function endSwipe() {
    if (!dragging) return;
    const willSwitch = swiping && Math.abs(dx) >= SWIPE_DIST;
    const dir = dx < 0 ? 1 : -1; // 左滑→下一个，右滑→上一个
    if (willSwitch) {
      // 旧卡滑出 → 切换角色 → 新卡从反方向滑入
      charAnimating = true;
      setPanelTransform(`translateX(${dir * -100}%)`, SWIPE_DURATION);
      setTimeout(() => {
        switchTo(dir);
        setPanelTransform(`translateX(${dir * 100}%)`, null); // 新卡定位到屏幕外
        requestAnimationFrame(() => requestAnimationFrame(() => {
          setPanelTransform('', SWIPE_DURATION); // 滑入
          setTimeout(() => { charAnimating = false; }, SWIPE_DURATION + 40);
        }));
      }, SWIPE_DURATION + 30);
    } else {
      // 未达阈值：弹性回位
      setPanelTransform('', 240);
      setTimeout(() => { setPanelTransform('', null); }, 260);
    }
    dragging = false; swiping = false; dx = dy = 0;
  }
  document.addEventListener('touchend', endSwipe);
  document.addEventListener('touchcancel', endSwipe);
})();

// ===== 角色名快捷编辑（图片上方胶囊） =====
function startRename() {
  if (inCall || textChat.busy) {
    el.status.textContent = '正在通话/回复中，稍后再改名字';
    return;
  }
  el.callName.classList.add('hidden');
  el.callNameInput.classList.remove('hidden');
  el.callNameInput.focus();
  el.callNameInput.select();
}

function commitRename() {
  const name = el.callNameInput.value.trim();
  // blur 只在 input 显示时触发；隐藏状态下直接返回
  if (el.callNameInput.classList.contains('hidden')) return;
  el.callNameInput.classList.add('hidden');
  el.callName.classList.remove('hidden');
  if (!name) {
    el.callNameInput.value = activeChar.name; // 空名回退
    return;
  }
  if (name !== activeChar.name) {
    updateCharacter(activeChar.id, { name });
    activeChar.name = name;
    el.callName.textContent = name;
    if (el.subtitleAI) el.subtitleAI.dataset.name = name;
    // 通话中实时改名时同步字幕前缀
    if (el.status) el.status.textContent = `已改名为 ${name}`;
  }
}

function cancelRename() {
  if (el.callNameInput.classList.contains('hidden')) return;
  el.callNameInput.classList.add('hidden');
  el.callName.classList.remove('hidden');
  el.callNameInput.value = activeChar.name;
}

function populateCharVoices(selected) {
  el.charVoiceSelect.innerHTML = '';
  SF_VOICES.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    if (v.id === selected) opt.selected = true;
    el.charVoiceSelect.appendChild(opt);
  });
}

let editingCharId = null;
let mediaPicker = null;

function openCharacterModal(editId) {
  // 确保角色页面已打开（从主页面点击编辑/新建时自动打开）
  if (!el.charactersPage.classList.contains('show')) {
    renderCharactersPage();
    el.charactersPage.classList.add('show');
  }
  editingCharId = editId;
  const char = editId ? getCharacters().find(c => c.id === editId) : null;
  el.characterModalTitle.textContent = char ? '编辑人物' : '创建角色';
  el.deleteCharacterBtn.classList.toggle('hidden', !char);
  el.charNameInput.value = char ? char.name : '';
  el.charPromptInput.value = char ? (char.systemPrompt || '') : '';
  populateCharVoices(char ? (char.ttsVoice || 'claire') : 'claire');
  // 内置角色音色：允许调整（写入角色级覆盖，不污染预设定义）
  const locked = false;
  el.charVoiceSelect.disabled = locked;
  el.charVoiceSelect.title = '';
  const lockHint = document.getElementById('voiceLockHint');
  if (lockHint) lockHint.textContent = '';
  // 当前实际关联的音色文件提示：有克隆参考则显示文件名，否则提示预设音色
  const fileHint = document.getElementById('charVoiceFileHint');
  if (fileHint) {
    if (char && char.voiceClone && char.voiceClone.ref) {
      const name = String(char.voiceClone.ref).split('/').pop();
      fileHint.textContent = `当前音色文件：${name}`;
      fileHint.classList.remove('hidden');
    } else {
      fileHint.textContent = '';
      fileHint.classList.add('hidden');
    }
  }

  // 形象媒体选择器（首次创建；编辑时回填当前值）
  if (!mediaPicker) {
    mediaPicker = new MediaPicker(el.charMediaPicker, {
      getSFApiKey: () => config.siliconFlowApiKey || '',
    });
  }
  mediaPicker.setValue(char ? (char.media || '') : '');
  if (char && char.media) {
    resolveCharMedia(char.media).then(m => {
      if (m && m.src) mediaPicker.setPreview(m.src);
    });
  }

  el.characterModal.classList.add('show');
  el.charNameInput.focus();
}

function closeCharacterModal() {
  el.characterModal.classList.remove('show');
  editingCharId = null;
}

async function saveCharacter() {
  const name = el.charNameInput.value.trim();
  if (!name) {
    el.charNameInput.focus();
    return;
  }
  const data = {
    name,
    systemPrompt: el.charPromptInput.value.trim(),
    ttsVoice: el.charVoiceSelect.value,
    media: mediaPicker ? mediaPicker.value : '',
  };

  // 编辑模式：直接保存
  if (editingCharId) {
    updateCharacter(editingCharId, data);
    activeChar = getActiveCharacter();
    updateCurrentCharacterUI();
    closeCharacterModal();
    renderCharactersPage();
    return;
  }

  // 创建模式：无参考图时，用名称+描述生成纯黑背景形象图
  const creating = el.saveCharacterBtn;
  if (!data.media && config.siliconFlowApiKey) {
    creating.disabled = true;
    creating.textContent = '生成形象中…';
    try {
      const prompt = buildAvatarPrompt(name, data.systemPrompt);
      const blob = await generateImage(config.siliconFlowApiKey, prompt);
      const id = await saveMedia(blob);
      data.media = 'db:' + id;
    } catch (e) {
      console.warn('AI 生成形象失败，使用默认形象:', e);
    } finally {
      creating.disabled = false;
      creating.textContent = '创建';
    }
  }

  const c = addCharacter(data);
  // 切到新人物：保存旧角色会话，清界面
  stashCurrentChat();
  setActiveCharacterId(c.id);
  activeChar = getActiveCharacter();
  endTextChat();
  updateCurrentCharacterUI();
  messages = [];
  refreshMemoryPanel();
  closeCharacterModal();
  renderCharactersPage();
}

// 生成纯黑背景的人物形象图 prompt
function buildAvatarPrompt(name, description) {
  const desc = (description || '').trim().slice(0, 300) || '一个自然的人物';
  return `人物角色形象照，竖版大头照风格，画面中只有一位角色（${name}）：${desc}。
要求：角色位于画面中央，面部清晰，光线柔和；背景必须是纯黑色（#000000），无任何景物、文字、水印、边框；写实风格，高清，四分之三侧面或正面。`;
}

// ===== 记忆面板 =====
async function refreshMemoryPanel() {
  if (!el.memoryPanel) return;
  const list = await getMemories(activeChar.id);
  el.memoryCount.textContent = list.length > 0 ? `${list.length} 条` : '';
  el.memoryList.innerHTML = '';
  if (list.length === 0) {
    el.memoryList.innerHTML = '<div class="memory-empty">还没有记忆，聊几句就会自动记住</div>';
    return;
  }
  list.forEach(m => {
    const item = document.createElement('div');
    item.className = 'memory-item';
    const d = new Date(m.ts);
    const dateStr = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    item.innerHTML = `
      <div class="memory-item-head">
        <span class="memory-item-time">${dateStr}</span>
        <button class="memory-del" title="删除">✕</button>
      </div>
      <div class="memory-item-text">${escapeHtml(m.text || '')}</div>`;
    item.querySelector('.memory-del').addEventListener('click', async () => {
      await deleteMemory(activeChar.id, m.id);
      refreshMemoryPanel();
    });
    el.memoryList.appendChild(item);
  });
}

function toggleMemoryPanel() {
  const show = el.memoryPanel.classList.toggle('open');
  if (show) refreshMemoryPanel();
}

// ===== 设置面板 =====
function openSettings() {
  el.settingsModal.classList.add('show');
  el.interruptToggle.checked = config.allowInterrupt !== false;
  el.memoryToggle.checked = config.memoryEnabled !== false;
  el.voiceCloneToggle.checked = config.voiceCloneEnabled !== false;
  trapFocus(el.settingsModal);
}

function closeSettings() {
  el.settingsModal.classList.remove('show');
  releaseFocus(el.settingsModal);
}

function saveSettings() {
  // API Key 由 config.js 内置，设置里不再填写；读取开关状态即可
  config.allowInterrupt = el.interruptToggle.checked;
  config.memoryEnabled = el.memoryToggle.checked;
  config.voiceCloneEnabled = el.voiceCloneToggle.checked;
  saveConfig(config);
  applyTTSSettings();
  closeSettings();
  // 若创建角色弹窗仍开着，刷新其 AI 生成 tab 的 Key 入口状态
  if (mediaPicker) mediaPicker.refresh();

  if (inCall && config.allowInterrupt && !volumeMonitor) {
    // 通话中开启了打断功能
    volumeMonitor = new VolumeMonitor();
    volumeMonitor.onInterrupt = handleInterrupt;
    volumeMonitor.start().catch((e) => { console.warn('VolumeMonitor 启动失败:', e); volumeMonitor = null; });
  } else if (inCall && !config.allowInterrupt && volumeMonitor) {
    volumeMonitor.stop();
    volumeMonitor = null;
  }
}

// ===== 初始化 =====
function init() {
  // 语音状态光球：纯 WebGL 着色器球，无鼠标 hover（由语音状态驱动）
  orb = new Orb(el.statusOrb, { backgroundColor: '#000000' });
  orb.setState(State.IDLE);
  syncOrbIcon(); // 初始为正常麦克风图标
  if (!isASRSupported()) {
    el.status.textContent = '浏览器不支持语音识别，请使用 Chrome 或 Edge';
    el.statusOrb.disabled = true;
    el.statusOrb.style.opacity = '0.4';
    return;
  }

  if (!config.apiKey) {
    el.status.textContent = '请点击右上角设置，填写 API Key';
  }

  onVoicesReady(() => {
    if (tts) applyTTSSettings();
  });

  updateCurrentCharacterUI();

  // Helen（girlfriend）默认自动下载素材，其它角色按需下载
  autoDownloadHelen();

  // 首次进入：恢复当前角色的历史会话
  const saved = loadChat(activeChar.id);
  messages = saved || [];
  renderTranscript(messages, activeChar.name);
  if (saved && saved.length > 0) el.transcriptPanel.classList.add('expanded');

  // 中间控件：点击说话 / 再次点击暂停（未通话 = 开始通话）
  el.statusOrb.addEventListener('click', togglePause);
  el.statusOrb.style.cursor = 'pointer';
  el.statusOrb.title = '点击说话 / 暂停';

  // 设置
  el.settingsBtn.addEventListener('click', openSettings);
  el.closeSettingsBtn.addEventListener('click', closeSettings);
  el.saveSettingsBtn.addEventListener('click', saveSettings);
  el.settingsModal.addEventListener('click', (e) => {
    if (e.target === el.settingsModal) closeSettings();
  });

  // 人物管理：左右切换（带滑入动画；移动端滑动手势共用同一动画逻辑）
  el.charPrev.addEventListener('click', () => animateSwitchTo(-1));
  el.charNext.addEventListener('click', () => animateSwitchTo(1));
  // 角色名快捷编辑
  el.callName.addEventListener('click', startRename);
  el.callNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  });
  el.callNameInput.addEventListener('blur', commitRename);
  el.closeCharacterBtn.addEventListener('click', closeCharacterModal);
  el.saveCharacterBtn.addEventListener('click', saveCharacter);
  el.deleteCharacterBtn.addEventListener('click', () => {
    if (!editingCharId) return;
    const name = el.charNameInput.value.trim() || '该人物';
    const wasActive = editingCharId === activeChar.id;
    const isPre = isPreset(editingCharId);
    const tip = isPre ? `确定隐藏内置角色"${name}"吗？可在角色列表中通过重置找回` : `确定删除"${name}"吗？`;
    if (confirm(tip)) {
      const removedId = editingCharId;
      deleteCharacter(removedId);
      // 删除的角色：清理其持久化会话
      removeChat(removedId);
      activeChar = getActiveCharacter();
      updateCurrentCharacterUI();
      // 删除的是当前激活人物：已自动回退到第一个，需清掉旧角色残留的会话记录
      if (wasActive) {
        endTextChat();
        const saved = loadChat(activeChar.id);
        messages = saved || [];
        renderTranscript(messages, activeChar.name);
        refreshMemoryPanel();
        el.status.textContent = `已切换到 ${activeChar.name}`;
      }
      closeCharacterModal();
      renderCharactersPage();
    }
  });
  el.characterModal.addEventListener('click', (e) => {
    if (e.target === el.characterModal) closeCharacterModal();
  });

  // 所有角色页面（全屏）
  el.allCharactersBtn.addEventListener('click', openCharactersPage);
  el.closeCharactersBtn.addEventListener('click', closeCharactersPage);
  el.pageAddCharBtn.addEventListener('click', () => openCharacterModal(null));
  if (el.charDownloadBadge) {
    el.charDownloadBadge.addEventListener('click', openCharactersPage);
  }

  // 滑块（人物编辑：语速/音调）
  if (el.charRateSlider) {
    el.charRateSlider.addEventListener('input', () => {
      el.charRateValue.textContent = parseFloat(el.charRateSlider.value).toFixed(1);
    });
    el.charPitchSlider.addEventListener('input', () => {
      el.charPitchValue.textContent = parseFloat(el.charPitchSlider.value).toFixed(1);
    });
  }
  // 测试 DeepSeek（LLM 对话，key 已内置）
  el.testBtn.addEventListener('click', async () => {
    el.testResult.textContent = '测试中...';
    el.testResult.className = 'test-result-box';
    try {
      const reply = await testConnection(config.apiKey);
      el.testResult.textContent = `成功: ${reply}`;
      el.testResult.className = 'test-result-box success';
    } catch (e) {
      el.testResult.textContent = `失败: ${e.message}`;
      el.testResult.className = 'test-result-box error';
    }
  });

  // 测试语音合成（硅基流动；key 已内置）
  el.testSFBtn.addEventListener('click', async () => {
    el.testResult.textContent = '测试中...';
    el.testResult.className = 'test-result-box';
    try {
      await testSFConnection(config.siliconFlowApiKey, activeChar.ttsVoice || 'claire');
      el.testResult.textContent = '语音合成连接成功';
      el.testResult.className = 'test-result-box success';
    } catch (e) {
      el.testResult.textContent = `失败: ${e.message}`;
      el.testResult.className = 'test-result-box error';
    }
  });

  // 测试声音克隆：当前角色有克隆参考时，直接用克隆模式合成一句中文并播放
  el.testCloneBtn.addEventListener('click', async () => {
    const vc = activeChar.voiceClone;
    if (!vc || !vc.ref || !vc.text) {
      el.testResult.textContent = `当前角色（${activeChar.name}）无克隆参考音频`;
      el.testResult.className = 'test-result-box error';
      return;
    }
    el.testResult.textContent = '克隆合成中...';
    el.testResult.className = 'test-result-box';
    try {
      const dataURI = await loadCloneRef(vc.ref);
      if (!dataURI) throw new Error('参考音频加载失败');
      const { testCloneConnection } = await import('./tts.js');
      await testCloneConnection(config.siliconFlowApiKey, dataURI, vc.text, !!activeChar.cloneNoInstruct);
      el.testResult.textContent = `克隆成功，正在用${activeChar.name}的音色播放`;
      el.testResult.className = 'test-result-box success';
    } catch (e) {
      el.testResult.textContent = `失败: ${e.message}`;
      el.testResult.className = 'test-result-box error';
    }
  });

  // 清空记录
  el.clearTranscriptBtn.addEventListener('click', () => {
    endTextChat();
    clearConversation();
    setState(State.IDLE);
  });

  // 导出对话
  el.exportTranscriptBtn.addEventListener('click', exportTranscript);

  // 文字输入
  el.sendBtn.addEventListener('click', sendTextMessage);
  el.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      sendTextMessage();
    }
  });

  // 记忆面板
  el.memoryBtn.addEventListener('click', toggleMemoryPanel);
  el.clearMemoryBtn.addEventListener('click', async () => {
    if (confirm('确定清空这个人物所有记忆吗？')) {
      await clearMemories(activeChar.id);
      refreshMemoryPanel();
    }
  });
  // 角色搜索
  if (el.charSearchInput) {
    el.charSearchInput.addEventListener('input', () => {
      renderCharactersPage(el.charSearchInput.value);
    });
  }

  refreshMemoryPanel();

  // ===== 键盘快捷键 =====
  document.addEventListener('keydown', (e) => {
    const isTyping = el.textInput === document.activeElement || el.charNameInput === document.activeElement || el.charPromptInput === document.activeElement || el.charSearchInput === document.activeElement || el.callNameInput === document.activeElement;
    if (isTyping) return;

    // Escape：关闭弹窗/页面
    if (e.key === 'Escape') {
      if (el.settingsModal.classList.contains('show')) { closeSettings(); return; }
      if (el.charactersPage.classList.contains('show')) { closeCharactersPage(); return; }
      if (el.characterModal.classList.contains('show')) { closeCharacterModal(); return; }
    }

    // Ctrl+,：打开设置
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      openSettings();
      return;
    }

    // Ctrl+ArrowLeft / Ctrl+ArrowRight：切换角色
    if (e.ctrlKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      animateSwitchTo(-1);
      return;
    }
    if (e.ctrlKey && e.key === 'ArrowRight') {
      e.preventDefault();
      animateSwitchTo(1);
      return;
    }

    // Space：点击说话 / 暂停
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      el.statusOrb.click();
      return;
    }

    // Ctrl+K：打开所有角色页面
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openCharactersPage();
      return;
    }
  });
}

init();

// 页面卸载时释放 WebGL 资源
window.addEventListener('beforeunload', () => {
  if (orb) orb.destroy();
  if (volumeMonitor) volumeMonitor.stop();
  if (tts) tts.stop();
});
