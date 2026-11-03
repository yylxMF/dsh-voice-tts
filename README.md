# dsh-voice-tts —— 给 DSH 装一张嘴

[![npm](https://img.shields.io/npm/v/dsh-voice-tts)](https://www.npmjs.com/package/dsh-voice-tts)
[![license](https://img.shields.io/npm/l/dsh-voice-tts)](LICENSE)
[![platform](https://img.shields.io/badge/host-Windows%20SAPI%20%7C%20Web%20Speech-4d6bfe)]()

仓库：<https://github.com/yylxMF/dsh-voice-tts>

> 让 DSH 把回复**念出来**：说完自动播报，想听哪条点哪条，选中文字单独念，念到哪段划到哪段，暂停后从**那个字**接着念。

---

## 目录

- [这是什么](#这是什么)
- [30 秒上手](#30-秒上手)
- [功能](#功能)
- [声音引擎](#声音引擎)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置项](#配置项)
- [HTTP 接口](#http-接口)
- [自检与排障](#自检与排障)
- [已知限制](#已知限制)
- [开发](#开发)
- [许可](#许可)

---

## 这是什么

DSH（DeepSeek Harness）本身只会把回复**写**在屏幕上。这个插件给它加了一张嘴：

- 回复说完，自动念（可关）
- 每条回复的操作栏里多一只喇叭，点一下念这条
- 选中任意文字，冒出一个「念这段」，只念选中的
- 念到哪一段，就在页面上把那段**划下划线**
- 暂停后继续，从**念到的那个字**接着念，不是从头

全程不碰模型请求：念的是**屏幕上已经渲染出来的文字**，所以不会多花 token，也不会改变任何对话内容。

---

## 30 秒上手

```bash
dsh plugin --profile desktop add dsh-voice-tts
```

装完重载插件（或重启 DSH），然后：

1. 设置 → **语音播报** → 打开「总开关」
2. 在聊天里让助手回一句，等它说完 —— 应该会听到声音
3. 想手动：点回复末尾（分支键后面）的小喇叭 🔊
4. 想只听一段：选中文字 → 点浮出来的「🔊 念这段」

---

## 功能

### 1. 自动播报

一轮回复"说完"（模型停止输出 + 文字静止超过阈值）后，自动念这一轮**最后一个有正文的 step**。

- 只念这一步，不念整轮的所有中间过程（一轮里做几十步工具调用时，念全过程能念一小时）
- 默认最多念 600 字（`每轮最多念多少字` 可调），超了就说一句"剩下的写在上面了"
- **只念"新长出来的"**：插件只对「你在看着的时候正在生成的那一轮」出声。切工作区、切会话、刷新页面时，屏幕上已经存在的旧内容一律只登记不念；反复进同一个工作区不会重复播报。

### 2. 手动念这条

每条回复末尾的操作栏里，**分支键之后、用量/时间之前**多了一只喇叭：

- 点一下：念这一条（整条回复，不套 600 字上限）
- 正在念时再点：停止
- 悬停：弹出控制面板

按钮是"自愈"的：React 重渲染把它挤掉后，600 ms 内会自己回来。

### 3. 选字阅读

在**聊天区**或**输入框**里选中 2–3000 字，浮出一个「🔊 念这段」小药丸，点它只念选中的部分。Esc / 点别处收起。

- 聊天区：普通 DOM 选区（`window.getSelection`），也支持 Shift + 方向键选
- 输入框：`textarea` / `input` 走 `selectionStart/End`；`contenteditable` 编辑器（DSH 的输入框就是）走 DOM 选区
- 设置面板里的输入框不触发，免得选个数字就冒按钮
- 点按钮时 `mousedown` 被 `preventDefault`，焦点和选区不会丢，草稿不受影响

### 4. 暂停 / 继续

悬停面板里的按钮是**暂停**不是**停止**：

| 操作 | 行为 |
|---|---|
| 点「暂停」 | 停住当前这句，**队列保留**，按钮变成「继续」 |
| 点「继续」 | 从**念到的那个字**接着念 |

恢复点的算法分两条路：

- 浏览器语音：监听 `onboundary` 事件，拿到每词的精确字符下标
- 宿主 SAPI：整段 WAV，用 `currentTime / duration × 字数` 估算字符位置

> 如果某个引擎不吐 boundary 事件，会退回"从这一段开头"——这一段 ≤ 220 字，实际听感差别不大。

### 5. 朗读高亮

念到哪一段，就给**那一段**加下划线：

```css
.dshv-reading {
  text-decoration: underline;
  text-decoration-thickness: 3px;
  text-underline-offset: 5px;
  text-decoration-color: #4d6bfe;
  background: rgba(77, 107, 254, .08);
}
```

实现方式：把每条回复按块（`<p>` / `<li>` / `<h1>`–`<h6>` / `<blockquote>` / `<pre>` / `<td>` / `<div>`…）拆开，记录每块在拼接文本里的字符区间；播放时用"段的起始下标 + 段内偏移"反查落在哪一块。

三条保证它**只划当前这一段**：

- **只认最内层块**：外层容器（比如包着所有段落的 step div）不参与高亮，否则整条消息都会被划线
- **容器兜底**：真要选到容器（内部还有段落）就干脆不划——宁可不亮，也不铺满
- **念完就清、且全量清**：`clearHighlight()` 扫全文档摘掉 `.dshv-reading`，React 换掉节点也不会留下旧下划线

**自动跟随滚动**：念到屏幕外的段落时，自动把它滚进视野（`scrollIntoView block:center`）。你手动用滚轮/触摸滚过之后 3 秒内，插件不抢滚动条。设置里可关。

### 6. 音量与语速

悬停面板里直接拖：

- **音量** 0–100%，拖动时正在放的那段**实时生效**（宿主播放器可改音量；浏览器语音只能下一段生效）
- **语速** 0.5×–2×

### 7. 设置页

设置 → 语音播报（图标是"人头说话"）：

| 项 | 说明 | 默认 |
|---|---|---|
| 总开关 | 关掉不再自动念，手动喇叭仍可用 | 开 |
| 选字阅读 | 选中文字（聊天区或输入框）冒「念这段」 | 开 |
| 朗读时自动滚动 | 念到屏幕外的段落时自动滚进视野 | 开 |
| 声音引擎 | 自动 / 浏览器 / Windows SAPI | 自动 |
| 音色 | 跟着引擎切换的音色列表 | 自动选中文 |
| 语速 / 音调 / 音量 | 音调只对浏览器引擎有效 | 1.0 / 1.0 / 100% |
| 判定说完的静默 | 文字静止多久算说完 | 1200 ms |
| 单句最长字数 | 切句粒度，长句会切段 | 220 |
| 每轮最多念多少字 | 自动播报的上限 | 600 |
| 跳过代码块 | 念代码很难听 | 开 |
| 试听 / 暂停·继续 / 刷新音色 / 恢复默认 | 操作按钮 | — |

底部还有一块**诊断**：两个引擎各自可用性、当前实际用哪个、最近一次错误。

导航图标是"人头 + 两道声波"。DSH 的设置导航图标按 section id 写死映射，插槽不提供 icon 字段，所以插件在运行时把自己的齿轮换成这个图标（`data-dshv-nav="talk"` 标记，防重复）。

---

## 声音引擎

两条路，`自动` 模式先浏览器、失败退回宿主：

| 引擎 | 音色来源 | 优点 | 缺点 |
|---|---|---|---|
| **浏览器 Web Speech** | `window.speechSynthesis` 暴露的系统音色 | 低延迟、可句中停、能调音调 | Electron 里可能一个音色都没有；受自动播放策略限制 |
| **Windows SAPI** | 宿主 `System.Speech`（PowerShell） | 一定有声音（中文机器一般有 Huihui） | 只支持 Windows；每次合成要起一个 PowerShell 进程（~200 ms 开销） |

选择逻辑：

```
engine = 自动
  ├─ 浏览器有音色 → 用浏览器；失败 → SAPI
  └─ 浏览器没音色 → 用 SAPI；失败 → 浏览器
```

失败原因不会吞掉：写进 `status.json` 的 `errors` 字段，设置页的诊断区也能看到。

---

## 工作原理

```
┌──────────────────────── 浏览器（DSH Web GUI） ────────────────────────┐
│  lib/client.js                                                         │
│                                                                        │
│  ① 盯 DOM：每 400 ms 扫 [data-chat-flow-kind="assistant-step"]          │
│     └─ 按 data-chat-turn 分组 → 取最后一轮最后一个有字的 step            │
│  ② 判定说完：没有 [data-chat-running] + 文字静止 > settleMs              │
│  ③ 切句：cleanText（去 markdown）→ splitSpeech（≤220 字/段）            │
│  ④ 逐段合成 + 播放                                                    │
│       ├─ 浏览器 speechSynthesis（onboundary 记录字符进度）              │
│       └─ fetch POST /dsh-voice/api/tts → WAV → <audio>                 │
│  ⑤ 高亮：段起点 → 块区间 → 给 <p> 加 .dshv-reading                      │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │ HTTP（同源，带登录 cookie）
┌────────────────────────────────▼───────────────────────────────────────┐
│  宿主进程（DSH 主进程）  lib/index.js                                   │
│                                                                        │
│  /dsh-voice/api/tts     → powershell.exe lib/tts.ps1 → WAV 字节        │
│  /dsh-voice/api/voices  → powershell.exe lib/voices.ps1 → 音色列表      │
│  /dsh-voice/api/status  → 读写 $DSH_HOME/voice/status.json              │
│                                                                        │
│  启动自检：列音色 → 真合成一句 → 写 selftest.wav + status.json           │
└────────────────────────────────────────────────────────────────────────┘
```

几个刻意的设计：

- **不读模型输出，只读屏幕**：所以永远和用户看到的一致，也不会额外消耗 token；代价是翻很久的历史不补念。
- **按块拆文本**：既为了切句自然，也为了能把"念到哪"映射回 DOM 画下划线。
- **按钮自愈**：操作栏是 React 渲染的，插件插进去的按钮随时可能被重渲染挤掉，所以每 600 ms 扫一遍补回来。
- **队列先看后删**：暂停时不动队列，只记位置，恢复时 `chunk.slice(位置)` 再合成。

---

## 安装

```bash
# 从 npm（推荐）
dsh plugin --profile desktop add dsh-voice-tts

# 从 GitHub（不走 npm）
dsh plugin --profile desktop add github:yylxMF/dsh-voice-tts

# 从本地源码目录（开发用）
dsh plugin --profile desktop add link:C:/path/to/dsh-voice
```

装完重载插件（Ctrl+R / F5）或重启 DSH。设置里会多出「语音播报」。

**卸载**：

```bash
dsh plugin --profile desktop remove dsh-voice-tts
```

---

## 配置项

浏览器 `localStorage` 里存一份：`dsh-voice/config@1`

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | bool | `true` | 自动播报开关 |
| `engine` | string | `"auto"` | `auto` / `browser` / `sapi` |
| `voiceURI` | string | `""` | 浏览器音色（空 = 自动优先中文） |
| `hostVoice` | string | `""` | SAPI 音色名（空 = 系统默认） |
| `rate` | number | `1` | 语速倍率 0.5–2 |
| `pitch` | number | `1` | 音调 0.5–2（仅浏览器） |
| `volume` | number | `1` | 音量 0–1 |
| `settleMs` | number | `1200` | 判定"说完"的静默毫秒 |
| `maxChars` | number | `220` | 单句切分长度 |
| `maxTurnChars` | number | `600` | 自动播报每轮上限 |
| `skipCode` | bool | `true` | 跳过代码块 |
| `selection` | bool | `true` | 选字阅读 |
| `autoScroll` | bool | `true` | 朗读时自动滚动跟随 |
| `greetedOk` | bool | `false` | 是否已成功打过招呼（防重复问候） |

---

## HTTP 接口

三个路由都过 `connection.requestRejection` 的信任栅栏（fail-closed：认证服务缺失就拒绝），不额外开放端口。

| 路由 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `/dsh-voice/api/tts` | POST | `{ text, voice?, rate?, volume? }` | `audio/wav`（22.05 kHz / 16 bit / 单声道）；失败 `500 {ok:false,error}` |
| `/dsh-voice/api/voices` | GET | — | `{ ok, voices:[{name,culture,gender,enabled}], default, error }` |
| `/dsh-voice/api/status` | GET / POST | POST：`{ browser: {...} }` | `{ ok, status }` |

`text` 上限 4000 字，请求体上限 64 KiB。

---

## 自检与排障

装好后会在 `$DSH_HOME/voice/` 写三个文件：

| 文件 | 内容 |
|---|---|
| `status.json` | 宿主 SAPI 是否可用、音色列表、自检音频时长、浏览器侧音色数 / DOM 命中情况 / trace 面包屑 / 最近错误 |
| `selftest.wav` | 启动时真合成的一句话（能放出声 = 链路通） |
| `voice.log` | 加载、探针、合成失败的流水 |

常见问题：

| 现象 | 先看 | 处理 |
|---|---|---|
| 完全没声音 | `status.json` 的 `errors` | 点设置里的「试听一句」——用户点击能解除浏览器自动播放限制 |
| 自动播报不触发 | `status.json` 的 `domKinds` / `assistantSteps` | 如果 `assistantSteps` 是 0，说明 DSH 改过 DOM 结构，需要更新选择器 |
| 念到一半停 | `voice.log` | 多半是合成失败，错误原因在日志里 |
| 设置页没有「语音播报」 | — | 插件没加载成功，检查 `dsh plugin` 是否装到当前 profile |

---

## 已知限制

- **宿主合成只支持 Windows**：用的是 `System.Speech`。macOS / Linux 上会自动只用浏览器音色，不会报错刷屏。
- **只念渲染出来的内容**：往上翻很远的历史不会补念。
- **不边生成边念**：等这一轮说完才出声（避免念到一半的句子被改写）。
- **浏览器语音可能没有音色**：部分 Electron 构建不暴露 `speechSynthesis` 音色列表，此时自动退回 SAPI。
- **不支持句中恢复的引擎**：没有 `onboundary` 的引擎，暂停后只能从段首续（段 ≤ 220 字）。
- **宿主会执行 PowerShell**：这是功能必需（SAPI 只能这么调），合成用的临时文件在 `%TEMP%\dsh-voice`，发出去就删。
- **热重载会残留实例**：页面里可能同时存在多份插件实例（开发时常见），插件在启动时会清理上一版留下的浮层和按钮；彻底干净请刷新页面。

---

## 开发

```
dsh-voice/
├─ lib/
│  ├─ index.js     宿主半身：三条路由 + 启动自检
│  ├─ client.js    浏览器半身：自动播报 / 喇叭按钮 / 选字阅读 / 高亮 / 设置页
│  ├─ tts.ps1      SAPI 合成 WAV
│  └─ voices.ps1   列 SAPI 音色
├─ test/
│  ├─ client.test.mjs  纯文本逻辑（抠字、切句）
│  ├─ dom.test.mjs     手搓 DOM 跑整条链路（自动播报/按钮/暂停续读/高亮）
│  └─ host.test.mjs    假 ctx 调三条路由 + 校验 WAV
├─ cordis.patch.yml    往配置树里 insert 本插件
└─ package.json        dsh.bundle.patch / dsh.client 声明
```

跑测试：

```bash
pnpm test        # 等价于 node test/*.test.mjs
```

测试不依赖真实浏览器：`dom.test.mjs` 里有一个 200 行的迷你 DOM（元素、classList、TreeWalker、事件），够把"扫描 → 切句 → 合成 → 高亮"整条链路跑通。

---

## 更新记录

| 版本 | 变化 |
|---|---|
| **0.1.9** | 修正自动播报时**整条消息都被划线**：高亮改为按块定位，容器元素一律跳过；并全量清理残留高亮 |
| **0.1.8** | 选字阅读支持**输入框**（`textarea`/`input` 走 `selectionStart`，`contenteditable` 走 DOM 选区）；支持 Shift + 方向键选字 |
| **0.1.7** | 改成**只念新长出来的内容**：切工作区/切会话/刷新不重念旧回复，反复进出也不会重复播报 |
| **0.1.6** | 朗读时**自动跟随滚动**（手动滚动后 3 秒内不抢）；段落识别补上 `<div>` |
| **0.1.5** | 设置页导航图标换成"人头说话"（官方按 id 写死，运行时替换） |
| **0.1.4** | 朗读**下划线高亮**：按块拆文本 + 字符区间反查，念到哪段划哪段 |
| **0.1.3** | 暂停后从**念到的那个字**继续（浏览器 boundary 事件 / SAPI 播放进度估算） |
| **0.1.2** | 启动清理上一版残留实例的浮层与按钮（热重载后点到"僵尸按钮"的问题） |
| **0.1.1** | 「停止」改成「暂停 / 继续」，暂停保留队列 |
| **0.1.0** | 首个版本：自动播报、消息栏喇叭、选字阅读、悬停面板、设置页、双引擎 |

---

## 许可

[MIT](LICENSE) © 2026 YYLXMF
