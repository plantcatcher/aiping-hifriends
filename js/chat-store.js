// ===== 按角色保存聊天记录（localStorage）=====
// 每个角色独立会话：切换角色时保存，切回时恢复
const CHAT_KEY = 'hifriends_chat_history';

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY)) || {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('聊天记录保存失败:', e);
  }
}

// 保存某个角色的完整会话（messages + 渲染用的角色名快照）
export function saveChat(characterId, messages) {
  const all = readAll();
  all[characterId] = {
    // 只存必要字段，控制体积
    messages: (messages || []).map(m => ({ role: m.role, content: m.content })),
    updatedAt: Date.now(),
  };
  writeAll(all);
}

// 读取某个角色的会话，无则返回 null
export function loadChat(characterId) {
  const all = readAll();
  const rec = all[characterId];
  if (!rec || !Array.isArray(rec.messages) || rec.messages.length === 0) return null;
  return rec.messages;
}

// 删除某个角色的会话（角色被删除时清理）
export function removeChat(characterId) {
  const all = readAll();
  if (all[characterId]) {
    delete all[characterId];
    writeAll(all);
  }
}

// 全量清空（设置里"重置"时使用）
export function clearAllChats() {
  localStorage.removeItem(CHAT_KEY);
}
