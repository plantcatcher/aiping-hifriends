# 名人声音克隆素材包（中文）

生成时间：2026-08-23 00:50（elen/leo/steve/fzd 已更新为**成熟低沉版**）
方法：原声 ASR 识别 → CosyVoice2 零样本克隆（原声音色 + 成熟指令）

## 产物清单

| 角色 | 克隆中文音频 | 时长 | 大小 |
|------|------------|------|------|
| Elon Musk（马斯克） | `assets/clones/elonmusk_zh.mp3` | ~7.6s | 711KB |
| Steve Jobs（乔布斯） | `assets/clones/stevejobs_zh.mp3` | ~9.7s | 156KB |
| 樊振东 | `assets/clones/fanzhendong_zh.mp3` | ~4.8s | 77KB |
| Leo / 慕容 | `assets/clones/leo_zh.mp3` | ~6.3s | 102KB |
| helen | `assets/clones/helen_zh.mp3` | ~17s | 388KB |
| Aris | `assets/clones/aris_zh.mp3` | ~4.2s | 68KB |
| Einstein | `assets/clones/einstein_zh.wav` | ~7.2s | 678KB |

### Elon Musk（2026-08-23 更新：换成"低沉 厚重 历历在目"原声）
- **来源**：IndexTTS-2 音色包「不同年龄人群音色/中年-男声/男-低沉 厚重 历历在目.wav」（7.6s / 48kHz 单声道）
- **ASR 识别内容（characters.js voiceClone.text 同步）**：
  "当喧嚣散去，唯有自己内心的声音最为清晰，他指引着我们前往真正渴望的远方"
- **当前参考**：该 wav 原声直接拷贝 `elonmusk_zh.mp3`（728KB），音色最保真

## 识别与克隆文字稿

### 樊振东（参考音频 48s，克隆用前 29s）
- **中文原文（ASR 识别，30s 裁剪版）**：
  "从23年开始，很多比赛都恢复了，加上那个时候改变了世界排名的规则，我们需要频繁的参赛获取积分维持世界排名，所以其实感觉每天都在打交道，特别是有的时候在一些焦点赛事，他不跟你聊赛场上的东西，肯定很多都是说赛场外的，不管是有些阴谋论也好，他也不清楚任何情况就先说这些。"
- **克隆测试句（音频内容，ASR 复核一致）**：
  "大家好，我是樊振东。很高兴见到你，我们聊聊乒乓球吧。"

### Leo / 慕容（参考音频 12.6s）
- **中文原文（ASR 识别）**：
  "大家好，我是慕容。之前呢就说过要给大家出一期这个普及声线的一个视频，我们就从小到大这样区分吧，首先第一个就是这个少年音。"
- **克隆测试句（音频内容，ASR 复核一致）**：
  "大家好，我是慕容。今天我们来聊聊声线，从少年音开始吧。"

### helen（2026-08-23 更新：温柔版 → 慵懒版）
- **当前参考**：以温柔版为底，CosyVoice2 指令 `"请用慵懒、松弛、慢条斯理的语气朗读"` + `speed: 0.85` 重合成 → `helen_zh.mp3`（388KB / ~17s）
- **参考文字（characters.js voiceClone.text，ASR 复核一致）**：
  "亲爱的，累了一天辛苦了。让我们一起深呼吸，慢慢放松身心。记住，生活中的每个时刻都值得珍惜，不要给自己太大压力。闭上眼睛，听听内心的声音，感受这份宁静美好"

### Einstein（2026-08-23 更新：换成"淡然娓娓道来 醇厚"原声）
- **来源**：IndexTTS-2 音色包「不同年龄人群音色/老年/男-淡然娓娓道来 醇厚.wav」（7.2s / 48kHz 单声道）
- **ASR 识别内容（characters.js voiceClone.text 同步）**：
  "通过对多位百岁老人的访谈，我们试图寻找跨越不同文化背景的长寿共同秘诀"
- **当前参考**：该 wav 原声直接拷贝 `einstein_zh.wav`（693KB），音色最保真；访谈/娓娓道来调性贴合"思考的老科学家"
- **`cloneNoInstruct: true`**：板牙要求去掉克隆时的"请用中文朗读"指令调性，直接调用参考音频复刻（tts.js 克隆模式不再加 `CLONE_ZH_PROMPT` 前缀），听感更自然、不再像"念稿"

### Aris（参考音频 14.7s）
- **中文原文（ASR 识别）**：
  "就我发现想优产品ID，他那个草就很草稿版的原型，一次出来。就几句话就出来了，然后呢，要反复去休息一节。要用上很多天，三四天都要。"
- **克隆测试句（音频内容，ASR 复核一致）**：
  "你好，我是Aris。很高兴认识你，我们聊聊吧。"

## 技术细节
- **ASR**：`FunAudioLLM/SenseVoiceSmall`（硅基流动 /v1/audio/transcriptions，multipart 上传 16k 单声道 wav）
- **克隆**：`FunAudioLLM/CosyVoice2-0.5B`（/v1/audio/speech，`references:[{audio: base64, text: 参考文字}]` + `input: "请用中文朗读：<|endofprompt|>中文正文"`）
- **成熟版（当前）**：指令改为 `"请用成熟低沉、稳重的声音朗读：<|endofprompt|>正文"` + `speed: 0.95`（语速略放缓），四个男声（elon/steve/leo/fzd）均已重新合成，内容不变、音色更成熟。
- **限制**：CosyVoice2 克隆参考音频最长 30s（超长需 ffmpeg 裁剪，且 mp3 起始偏移会导致实际时长略超，建议裁到 29s）
- 克隆音频为 24kHz mono MP3，可正常播放

## 在 HiFriends 中使用（导入角色克隆）
1. 打开 HiFriends → 创建角色（或编辑角色）
2. 在"原声音色克隆"区域，参考音频选对应的 `assets/clones/*_zh.mp3`
3. 参考文字填对应**中文原文**（见上表）
4. 角色对话语音即会用该音色说话（TTS 走硅基流动，需配硅基 API Key；aiping 为默认 TTS，克隆需切到硅基）

## 识别与克隆文字稿

### Elon Musk
- **英文原文（ASR 识别）**：
  "I don't know, actually. I don't have a good answer for you. I work a lot, I mean, that and a lot."
- **中文克隆稿（音频内容，ASR 复核一致）**：
  "其实我也不知道。这个问题我没有一个很好的答案。我工作很多，就是，很多。"

### Steve Jobs
- **英文原文（ASR 识别）**：
  "Hewlett Packard was really the only company I'd ever seen in my life at that age, and it formed my view of what a company was and how well they treated their employees."
- **中文克隆稿（音频内容，ASR 复核一致）**：
  "惠普是我在那个年纪见过的唯一一家公司，它塑造了我对一家公司应该是什么样、应该如何善待员工的理解。"

## 技术细节
- **ASR**：`FunAudioLLM/SenseVoiceSmall`（硅基流动 /v1/audio/transcriptions，multipart 上传 16k 单声道 wav）
- **克隆**：`FunAudioLLM/CosyVoice2-0.5B`（/v1/audio/speech，`references:[{audio: base64, text: 英文原文}]` + `input: "请用中文朗读：<|endofprompt|>中文正文"`）
- 克隆音频为 24kHz mono MP3，可正常播放

## 在 HiFriends 中使用（导入角色克隆）
1. 打开 HiFriends → 创建角色（或编辑角色）
2. 在"原声音色克隆"区域，参考音频选 `assets/clones/elonmusk_zh.mp3`（或 stevejobs_zh.mp3）
3. 参考文字填对应**英文原文**（见上表，CosyVoice2 用参考音频的文本对齐音色）
4. 角色对话语音即会用该音色说中文（TTS 走硅基流动，需配硅基 API Key；aiping 为默认 TTS，克隆需切到硅基）
