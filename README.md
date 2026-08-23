# HiFriends 🎙️

> **和你最喜欢的角色交谈。** Talk to your favorite characters.

基于浏览器的 AI 语音对话应用。让乔布斯、爱因斯坦、马斯克……以他们本人的声音，用中文陪你聊天。

不是文字聊天框，而是**真实的语音通话**——你说话，他用本人的声音回答你，就像在打电话。

## ✨ 核心特性

- **🎭 角色扮演**：7 个内置角色，每个都有独立人设、专属形象与音色
- **🗣️ 声音克隆**：基于 CosyVoice2 零样本克隆，用角色本尊音色说中文（如乔布斯用乔布斯的声音说中文）
- **🎤 语音对话**：语音识别 + 语音合成，说完即答，打断式通话体验
- **🧠 角色记忆**：记住你之前聊过的内容，越聊越懂你
- **📸 图片生成**：对话中可直接生成图片
- **➕ 自定义角色**：自建角色，配置人设、音色与形象

## 👥 内置角色

| 角色 | 人设基调 | 音色 |
| --- | --- | --- |
| 💞 Helen | 温柔黏人 · 爱撒娇的 AI 女友 | 慵懒温柔女声（克隆） |
| 🍎 Steve Jobs | 极简主义 · 改变世界 | 原声克隆说中文 |
| 🧠 Albert Einstein | 科学智慧 · 好奇童心 | 淡然醇厚老者声（克隆） |
| 🚀 马斯克 | 未来科技 · 殖民火星 | 低沉厚重男声（克隆） |
| 🏓 樊振东 | 乒乓王者 · 热血拼搏 | 本人音色（克隆） |
| 🦁 Leo | 沉稳靠谱 · 直球沟通 | 少年统帅音（克隆） |
| ⚡ Aris | 好奇建造者 · 追寻本质 | 本人音色（克隆） |

## 🛠️ 技术栈

纯前端实现，无需后端：

- **LLM**：[硅基流动 SiliconFlow](https://siliconflow.cn) Chat Completions API
- **语音识别**：`FunAudioLLM/SenseVoiceSmall`（ASR）
- **语音合成**：`FunAudioLLM/CosyVoice2-0.5B`（支持零样本声音克隆 + 指令调性）
- **图像引擎**：Three.js（角色 3D orb 视觉）
- **存储**：localStorage（配置、角色、对话记忆）

## 🚀 快速开始

```bash
# 1. 起本地静态服务器（模块化 JS 需要）
python -m http.server 8124

# 2. 浏览器打开
start http://localhost:8124   # Windows
open http://localhost:8124    # macOS
```

> 直接双击打开 `index.html` 会因 CORS 限制无法加载模块，务必用本地服务器。

### 配置 API Key

点击界面右上角 ⚙️ 设置，填入：

| 配置项 | 用途 | 获取 |
| --- | --- | --- |
| **SiliconFlow API Key** | LLM 对话 + 语音识别 + 声音克隆 | [siliconflow.cn](https://siliconflow.cn) |

- 不填 Key 也能玩：走浏览器内置语音（女声）+ 无记忆模式
- 填入 Key 解锁完整能力：克隆音色 + 语音对话 + 角色记忆

## 📁 目录结构

```
HiFriends/
├── index.html          # 主页面
├── css/style.css       # 样式
├── js/
│   ├── app.js          # 应用主逻辑
│   ├── characters.js   # 角色定义（人设/音色/形象）
│   ├── tts.js          # 语音合成 + 声音克隆
│   ├── asr.js          # 语音识别
│   ├── llm.js          # LLM 对话
│   ├── memory.js       # 对话记忆
│   ├── imagegen.js     # 图片生成
│   ├── orb.js          # 3D 角色视觉
│   └── ...
└── assets/             # 媒体资源（角色形象视频 + 克隆参考音频，随仓库入库）
```

## 🔒 安全说明

- API Key 仅保存在你浏览器本地（localStorage），**不会上传到任何服务器**
- 本仓库不包含任何密钥；`.sfkey` 等敏感文件已被 `.gitignore` 排除
- 克隆音色所需的参考音频（`assets/clones/`）与角色形象视频（`assets/*.mp4`）**随仓库一起入库**，克隆仓库后开箱即用

## 📄 License

私有项目，保留所有权利。