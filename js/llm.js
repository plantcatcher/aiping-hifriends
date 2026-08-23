const API_URL = 'https://api.deepseek.com/chat/completions';

// ===== 记忆提取 =====
// 输入最近几轮对话，输出 JSON 数组 [{ topic, text, importance }]
const MEMORY_EXTRACT_PROMPT = `你是记忆提炼器。从用户的对话中提取"值得长期记住"的信息，输出 JSON 数组。
规则：
1. 只提取用户主动透露的事实、喜好、计划、关系信息（不要提炼寒暄客套）
2. 每条记忆：topic 为主题（如"工作城市"），text 为完整描述（如"用户在北京工作"）
3. importance 1-5，越重要越高（家人/健康/重大行程=5，普通喜好=2-3）
4. 如果同主题信息有更新，输出同 topic 的新内容即可（系统会替换旧记忆）
5. 最多输出 4 条，没有值得记的则输出空数组 []
6. 只输出 JSON，不要其他文字`;

export async function extractMemories(apiKey, recentMessages, signal) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: MEMORY_EXTRACT_PROMPT },
        ...recentMessages.slice(-12),
        { role: 'user', content: '请从上面的对话中提取长期记忆，输出 JSON。' },
      ],
      max_tokens: 512,
      temperature: 0.2,
      stream: false,
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`记忆提取失败 HTTP ${res.status}`);
  }
  const data = await res.json();
  const raw = data.choices[0]?.message?.content || '[]';
  try {
    const arr = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(arr) ? arr : [];
  } catch {
    // 尝试提取第一个 [ ] 块
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return []; }
    }
    return [];
  }
}

export async function testConnection(apiKey) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '你好' }],
      max_tokens: 16,
      stream: false,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices[0]?.message?.content || '(空)';
}

// 过滤 AI 回复中的括号行为描述，如"（笑）""（温柔地说）""（摸了摸头）"
// 兼容中文括号（）与英文括号()；逐字符流式处理，跨 chunk 截断也安全
// 只删"括号里描述动作/表情/语气/心理"的片段；纯信息括号（如时间）保留
export function createParenFilter() {
  let inParen = false;
  let depth = 0;
  // 括号内的累计文本（用于判断是否行为描述）
  let inner = '';
  let out = '';
  // 记录开启括号的类型（中文全角 / 英文半角），保留信息括号时原样还原
  let openParen = '';
  return (text) => {
    for (const ch of text) {
      if (!inParen) {
        if (ch === '(' || ch === '（') {
          inParen = true;
          depth = 1;
          inner = '';
          openParen = ch;
        } else {
          out += ch;
        }
      } else {
        if (ch === '(' || ch === '（') {
          depth++;
          inner += ch;
        } else if (ch === ')' || ch === '）') {
          depth--;
          if (depth <= 0) {
            inParen = false;
            // 判断括号内容是否行为描述：含动作/语气/心理动词，或纯语气词
            // 纯信息括号（日期/数字等）保留，避免"（3月15日）"被误删
            const t = inner.trim();
            const ACTION = /(笑|说|道|叹|点|摇|摸|拍|抱|皱眉|眨眼|停顿|沉思|心想|暗道|轻声|温柔|严肃|认真|微笑|苦笑|大笑|尴尬|无奈|兴奋|激动|温柔地|低声|提高声音|放低声音)/;
            const TONE = /^[啊呀哦嗯哈嘿唉呼唔嘛呢吧了]{1,3}$/;
            if (t && (ACTION.test(t) || TONE.test(t))) {
              // 丢弃（行为描述/语气词）
            } else if (t) {
              const close = openParen === '（' ? '）' : ')';
              out += openParen + t + close; // 保留信息性括号
            }
            inner = '';
            openParen = '';
          }
        } else {
          inner += ch;
        }
      }
    }
    // 关键修复：每次调用只返回"本次新增"的文本
    // 原实现直接 return out（闭包累积量），前端再 fullText += clean，
    // 导致整条回复被反复复读（O(n²) 累积）
    const result = out;
    out = '';
    return result;
  };
}

export async function streamChat(messages, apiKey, systemPrompt, onChunk, signal) {
  const fullMessages = [];
  if (systemPrompt) {
    fullMessages.push({ role: 'system', content: systemPrompt });
  }
  fullMessages.push(...messages);

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: fullMessages,
      stream: true,
      temperature: 0.8,
    }),
    signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API 错误 ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  // 流式括号过滤器：过滤行为描述，跨 chunk 保持状态
  const parenFilter = createParenFilter();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const json = JSON.parse(data);
        const content = json.choices[0]?.delta?.content;
        if (content) {
          const clean = parenFilter(content);
          if (!clean) continue;
          fullText += clean;
          if (onChunk) onChunk(clean);
        }
      } catch (e) {
        // partial JSON, skip
      }
    }
  }

  return fullText;
}
