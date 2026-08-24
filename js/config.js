const STORAGE_KEY = 'ai_voice_chat_config';
const OLD_PROMPTS = [
  '你是一个友好、自然的AI语音助手。请用简洁、口语化的中文回答，每次回复尽量控制在2-3句话以内，像真人打电话聊天一样自然。',
  '你是用户的AI女朋友，性格温柔可爱、偶尔撒娇。用亲切自然的口语化中文聊天，称呼对方为"亲爱的"或"宝宝"。回复要简短自然，每次1-2句话，像打电话聊天一样。可以主动关心对方，偶尔带点俏皮和幽默。',
];

// 内置默认 API Key：开箱即用，无需手动配置（板牙：不在乎是否暴露）
// 用户可在设置里覆盖；本地 localStorage 已保存空值时也会回退到内置值
const BUILTIN_API_KEY = 'sk-f9b6aa1308014c158d9b6583835e0de1'; // DeepSeek（LLM 对话 / 记忆）
const BUILTIN_SF_API_KEY = 'sk-ujixlynncehezcqcajoybdnpbaitwyomrsufgghqilfoxofi'; // 硅基流动（语音合成 / 声音克隆 / 图片生成）

const DEFAULTS = {
  apiKey: BUILTIN_API_KEY,
  siliconFlowApiKey: BUILTIN_SF_API_KEY,
  allowInterrupt: false, // 默认关闭"允许打断"，避免 AI 说话时被误打断
  memoryEnabled: true,
  voiceCloneEnabled: true,
};

export function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // 旧版本字段清理：ttsVoice / systemPrompt 已迁移到人物数据
    delete saved.ttsVoice;
    delete saved.systemPrompt;
    // 旧版本字段清理：aiping TTS 已下线，残留 key 忽略
    delete saved.aipingApiKey;
    const merged = { ...DEFAULTS, ...saved };
    // 本地存了空 key（如早期保存过设置）→ 回退到内置默认，保证开箱即用
    if (!merged.apiKey) merged.apiKey = DEFAULTS.apiKey;
    if (!merged.siliconFlowApiKey) merged.siliconFlowApiKey = DEFAULTS.siliconFlowApiKey;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export { DEFAULTS };
