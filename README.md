# dsh-task-ask-notify

[English](README.en.md) | [中文](README.md)

> **来源与署名**
>
> 本仓库 fork 自 [**deadbushxw/dsh-task-ask-notify**](https://github.com/deadbushxw/dsh-task-ask-notify)。
> 上游的作者是 **deadbushxw**，本项目的绝大部分代码来自他，`LICENSE` 里的版权声明也属于他。
>
> 我在上游基础上增加的是「**运行失败也提醒**」：失败时立刻弹通知、播一段和完成提示音
> **反向**的下行三音、正文附上失败原因。顺带修了一个「有弹窗但没声音」的问题
> （精简版 Windows 上 WPF `MediaPlayer` 静默失败）。增量的具体清单见
> [`dsh-task-ask-notify-LOCAL-CHANGES.md`](dsh-task-ask-notify-LOCAL-CHANGES.md)。
>
> 如果你要的是原版，请去上游仓库；这个 fork 的价值在于多出的失败提醒。

一个面向 Windows 的 **DSH 宿主侧插件**（DeepSeek Harness Host plugin）：当一轮任务
**完成**、**运行失败**，或模型**向你提问**时，同时弹出一条真实的 Windows 11 系统通知并播放一段提示音。

- **任务完成** —— 模型把这一轮交还给你，并且此后一段时间内没有任何新动静。
- **运行失败** —— 这一轮以 `turn/end` 的 `reason.kind === 'error'` 收尾，也就是界面上那句红色的
  「本轮运行失败」。**立刻提醒，不等静默期**，正文附上失败原因（`reason.error.message`）。
- **向你提问** —— 模型调用了 `ask_user_question`，此刻正阻塞等待你，所以立即提醒，
  不走去抖延迟。

通知是归属 DSH 自己 AUMID 的普通 Windows toast，会进入操作中心，也遵循你的专注助手
设置。提示音是你完全可控的 WAV：往四个目录里丢文件，或者直接把目录指向你已有的文件夹。
失败用的是**下行**提示音，和完成时的上行提示音一听就分得清。

<!-- 上面是插件图标；截图有意不提交，因为截图会暴露作者的桌面。 -->

**环境要求**

| | |
|---|---|
| 操作系统 | Windows 10 2004+ 或 Windows 11 |
| DSH | 0.2.0-rc.2 或更新（需要宿主插件的 `Config` 与 `session/event`） |
| PowerShell | 系统自带的 Windows PowerShell 5.1（`%SystemRoot%\System32\WindowsPowerShell\v1.0\`） |
| Node.js | 20+，仅用于跑测试和随包工具，运行插件本身不需要 |

命名说明：npm 包名是 **`dsh-task-ask-notify`**，而本仓库目录叫 `dsh-task-ask-notify`。目录名不影响
任何行为 —— `file:` 安装按路径识别，DSH 读取的一切信息都来自 `package.json`。

---

## 安装

安装方式就是一次 bundle 安装：DSH 会把包装进当前 profile、注册 loader 行，并热应用。
不要手工改 profile。

### 1. 把代码放到机器上

```sh
git clone https://github.com/SimpleStar666/dsh-task-ask-notify.git "%USERPROFILE%\.dsh\dsh-plugins\dsh-task-ask-notify"
```

放哪个目录都行，上面的路径只是示例。没有构建步骤，也不需要先 `npm install` —— 唯一那个
依赖由 DSH 自己的安装器解析。

### 2. 装进一个 profile

在你想收到提醒的那个 profile 里对 Agent 说：

> 用 `plugin_manager install_bundle` 安装 `%USERPROFILE%\.dsh\dsh-plugins\dsh-task-ask-notify` 这个 bundle。

或者在 GUI 里：**设置 → 插件**，把
`%USERPROFILE%\.dsh\dsh-plugins\dsh-task-ask-notify` 作为本地 bundle 目录加入并启用。

`plugin_manager` 返回 `application: "applied"` 表示改动已生效；返回 `restart-required`
就重启 DSH。用新代码替换一个已安装的同名包也需要重启，因为宿主会缓存模块实例。

### 3. 确认它能用

1. 起一个短任务并让它跑完：应当有一条通知 + 一段提示音。
2. 或者直接跑适配器自检 —— 它完全不经过 DSH，弹一条通知并播放内置提示音：

   ```sh
   node tools/win-alert-selftest.mjs
   ```

   退出码 `0` 表示适配器自报成功。注意：退出码 `0` **不等于**通知真的显示了 ——
   怎么从系统侧确认，见[排错](#排错)。

两件事都要成立才算成功：提醒确实出现，并且退出码为 `0`。如果什么都没出现，
[排错](#排错)第一节讲的就是那个会静默失败的原因。

### 卸载

```
plugin_manager remove_bundle dsh-task-ask-notify
```

profile 里不会留下任何残留。下面说的配置文件不属于安装内容，也不会被删除；想一并清掉就
自己删掉它。

---

## 提示音

### 目录约定

插件按相对名找这四个目录：

| 目录 | 播放时机 |
|---|---|
| `audio/complete/` | 一轮任务完成 |
| `audio/failed/` | 一轮以错误收尾（`reason.kind` 属于 `failed.reasons`，默认 `error`） |
| `audio/ask-single/` | 模型只问了一个问题 |
| `audio/ask-multiple/` | 模型问了两个及以上问题 |

每次从对应目录里**等概率随机**取一个文件（按文件名排序，因此同样的随机序列结果可复现）。
只认 `.wav`。增删、替换文件在**下一次提醒**就生效 —— 不需要重启，因为目录列表是按目录的
修改时间做缓存的。

相对路径会按顺序查两个位置：

1. **你的音频目录** —— `%DSH_HOME%\plugin-data\dsh-task-ask-notify\` —— 当该路径存在且里面
   至少有一个 `.wav` 时采用；
2. **包内目录** —— 随插件一起安装的那份。

你的目录优先，是因为已安装的 bundle 是从 profile 里的那份拷贝运行的：装完之后再往克隆里
放文件，它是看不见的，否则就必须重装才生效。又因为只有真正装着音效时相对路径才会命中，
一个空目录绝不会把某个场景的音效悄悄变成静音。在 `complete.dir`、`failed.dir`、
`askSingle.dir`、`askMultiple.dir`、`sound.fallback` 里写**绝对路径**则完全绕过这个顺序。

**本仓库只附带两个音频文件**，都由脚本生成、可复现：

- `audio/_default/chime.wav` —— 完成兜底，由 `tools/gen-default-chime.mjs` 生成的上行双音
  （880 Hz → 1318.5 Hz）。某个场景目录缺失或为空时用它兜底。
- `audio/failed/alert-fail.wav` —— 失败提示，由 `tools/gen-failure-alert.mjs` 生成的下行三音
  （659.25 → 554.37 → 440 Hz）。**故意和完成提示反向**：听到上行就是好了，听到下行就是坏了。

其余三个场景目录本身存在但内容为空，且它们的内容被 git 忽略；
见[仓库边界](#仓库边界)。

### 加自己的音效

两种方式，都不需要改配置：

**导入进来。** 如果你的素材包结构是 `<包>/complete/`、`<包>/ask/single/`、
`<包>/ask/multiple/`，随包的导入工具会把它们复制进你的音频目录，并对每一个拷贝做
SHA-256 校验：

```sh
node tools/import-audio.mjs --source "<你的素材包路径>"
node tools/import-audio.mjs --verify
```

默认写进 `%DSH_HOME%\plugin-data\dsh-task-ask-notify\audio\...`，因此下一次提醒就会用上新
音效，**不需要重装**。如果你是就地加载克隆里的插件，用 `--target package`。`--dry-run`
只报告不写盘。导入工具**不会**把你给的来源路径写进任何文件，所以本机路径不可能因此进入
提交。

**或者直接指过去。** 见下面的 `complete.dir`、`failed.dir`、`askSingle.dir`、
`askMultiple.dir`。支持绝对路径，因此完全可以一个文件都不复制。

### 重新生成默认提示音

```sh
node tools/gen-default-chime.mjs --check    # 完成提示音
node tools/gen-failure-alert.mjs --check    # 失败提示音
```

`--check` 会重新渲染、报告每段音的主频，并在提交的 WAV 与生成结果不一致时报错。这是有意
的：一个没人能复现的二进制素材就是不可审查的黑盒。音色参数：

| | 第一段 | 第二段 | 第三段 |
|---|---|---|---|
| 完成 `chime.wav` | 880 Hz / 0.18 s | 1318.5 Hz / 0.35 s | — |
| 失败 `alert-fail.wav` | 659.25 Hz / 0.14 s | 554.37 Hz / 0.14 s | 440 Hz / 0.30 s |

各带 20 ms 指数起音与指数衰减至 −80 dB。见[致谢](#致谢)。

---

## 配置

### DSH 里的配置页

插件带浏览器半侧，所以可以直接在界面里配置：

**插件列表 → `dsh-task-ask-notify`** —— 表单就渲染在这个 bundle 自己的页面上；同一页也能从
插件行的「配置」入口打开。它能改日常用到的那几项：总开关、完成提醒与静默期、单/多问题提醒、
**运行失败提醒与是否附上失败原因**、声音开关与音量与最小间隔、通知开关、正文是否附上问题、
子代理会话是否提醒。

**保存立即生效**：改动会提交进正在运行的插件，下一次提醒就用新值 —— 不用重启、不用重载、
也不用改文件。

**试听。** 音量数字旁边有一个按钮，点一下就让设置凭耳朵判断，而不是靠猜。一次点击会先把页面上
的改动应用下去，再用**真实提醒走的那同一条链路**播放一次声音 —— 同样的目录、同样的等概率选取、
同一个适配器、同一个音量 —— 只是不弹通知，所以你听到的就是你以后会听到的。它从随机挑中的场景
（`complete`、`failed`、`ask-single`、`ask-multiple`）里取音，也就是播放你自己导入的某一音频，而不是插件
内置的样板。它在 `sound.enabled` 关闭时**依然可用**：先把音量调好再打开声音，是合理的顺序。

这些字段在导出的 schema 里声明为 `.volatile()`，这既是 DSH 愿意为它们渲染表单的前提，也是
「改动能到达运行中的插件」的机制；页面通过 DSH 自己的 settings 服务写入，因此被拒绝或发生
冲突的写入会报出来，而不会静默丢失。不在页面上的字段（音效目录、通知文案、AUMID）走下面的
层，因为它们需要重载而不是热更新。

### 文件层

两层，逐字段后者覆盖前者：

1. 插件行 `cordis.patch.yml` 里的 `config`（由 Loader 按导出的 `Config` schema 校验，
   这正是 DSH 自己的配置界面所投影的同一个 schema）；
2. 一个属于你的、**在仓库之外**的可选 JSON 文件：

   ```
   %DSH_HOME%\plugin-data\dsh-task-ask-notify\config.json
   ```

   `%DSH_HOME%` 默认是 `%USERPROFILE%\.dsh`。用环境变量
   `DSH_TASK_ASK_NOTIFY_CONFIG` 可以整体替换这个路径。

该 JSON 文件在变化时会被重新读取，所以 DSH 运行期间也能改值。文件不是合法 JSON、或含
schema 拒绝的值时，会在日志里报告并**被忽略** —— 上一份有效配置继续生效，日志会带上出错
的字段路径。JSON 层优先于配置页与插件行，所以你在那里钉住的字段就无法从界面改了。

所有字段都可选，省略即用表中的默认值。想在不卸载的前提下关掉全部提醒，写
`{"enabled": false}` 即可。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 四个场景的总开关。 |
| `complete.enabled` | `true` | 一轮干净结束时提醒。 |
| `complete.dir` | `"audio/complete"` | 音效目录。相对路径先查你的音频目录、再查包内；绝对路径按原值使用。 |
| `complete.debounceMs` | `2000` | 干净结束后的静默期。多轮 goal 任务只想响一次就调大（例如 `15000`），代价是短任务也要等这么久。 |
| `failed.enabled` | `true` | 一轮以错误收尾时提醒。**没有静默期** —— 失败之后不会再有动静可等。 |
| `failed.dir` | `"audio/failed"` | 音效目录，解析顺序同上。 |
| `failed.reasons` | `["error"]` | 哪些 `turn/end` 的 `reason.kind` 算失败。DSH 自己只对 `error` 显示「本轮运行失败」；`aborted`/`interrupted` 是你手动停的，`blocked` 是在等审批，`max-tokens` 是回答被截断但已交付 —— 想让它们也提醒就往这个数组里加。 |
| `failed.includeReason` | `true` | 把 `reason.error.message`（取不到就用 `code`）附到正文。关掉则正文只有会话标题。 |
| `askSingle.enabled` | `true` | 模型问一个问题时提醒。 |
| `askSingle.dir` | `"audio/ask-single"` | 音效目录。 |
| `askMultiple.enabled` | `true` | 模型问两个及以上问题时提醒。 |
| `askMultiple.dir` | `"audio/ask-multiple"` | 音效目录。 |
| `sound.enabled` | `true` | 是否出声。 |
| `sound.volume` | `100` | 音量，`0`–`100` 刻度：`0` 静音，`100` 为原声不衰减。已经存过的 `(0, 1]` 值会被当作旧刻度乘以 100，因此原有设置的响度不变。 |
| `sound.minGapMs` | `400` | 间隔小于此值的两次提醒共用一次声音；两条通知照发。 |
| `sound.auditionAt` | `0` | 诊断项，不是偏好设置：配置页的**试听**按钮把它设为点击时刻，插件在它变化时播放一次声音。 |
| `sound.fallback` | `"audio/_default/chime.wav"` | 场景目录为空或缺失时的兜底；填目录也可以。解析顺序与场景目录相同。 |
| `sound.maxDurationMs` | `10000` | 播放进程的最长存活时间上限。 |
| `notify.enabled` | `true` | 是否弹系统通知。 |
| `notify.aumid` | `"com.deepseek.dsh"` | 通知归属的 AUMID。只在 DSH 快捷方式变了时才需要改；见排错。 |
| `notify.silentSystemSound` | `true` | 关掉系统通知音，因为插件自己播。 |
| `notify.bodyMaxChars` | `80` | 正文截断前的最大长度。 |
| `notify.includeQuestionInBody` | `false` | 把首个问题文本追加到正文。默认关：正文就是会话标题。 |
| `dedup.completeMs` | `3000` | 同一会话在此窗口内的重复「完成」提醒会被丢弃。 |
| `dedup.failedMs` | `5000` | 同一会话在此窗口内的重复「失败」提醒会被丢弃，挡住自动重试刷屏。 |
| `sessions.includeSubagents` | `false` | 是否为子代理会话也提醒。默认关，避免一堆后台助手刷屏。 |
| `messages.completeTitle` | `"任务完成"` | 完成提醒的标题。 |
| `messages.failedTitle` | `"本轮运行失败"` | 失败提醒的标题。 |
| `messages.askSingleTitle` | `"需要你回复"` | 单问题提醒的标题。 |
| `messages.askMultipleTitleTemplate` | `"有 {count} 个问题等你回复"` | 多问题提醒的标题，`{count}` 会被替换。 |
| `messages.fallbackBody` | `"DeepSeek Harness"` | 会话既无标题也无工作区目录时的正文。 |

示例 —— 更安静、英文文案，并使用你已有的音效目录：

```json
{
  "complete": { "debounceMs": 15000, "dir": "D:\\my-sounds\\done" },
  "failed": { "dir": "D:\\my-sounds\\failed", "reasons": ["error", "max-tokens"] },
  "askSingle": { "dir": "D:\\my-sounds\\ask" },
  "askMultiple": { "dir": "D:\\my-sounds\\ask-many" },
  "sound": { "volume": 0.5 },
  "messages": {
    "completeTitle": "Task finished",
    "failedTitle": "This turn failed",
    "askSingleTitle": "Your input is needed",
    "askMultipleTitleTemplate": "{count} questions are waiting",
    "fallbackBody": "Session"
  }
}
```

通知**正文是会话标题**，取不到时退化为会话工作区目录名，再退化到
`messages.fallbackBody`。**失败提醒额外带一句原因**（`failed.includeReason`，默认开），
形如 `修复编译错误 — API key invalid`，截断到 `notify.bodyMaxChars`。

---

## 排错

### 完全没有反应

最可能的原因是：某个 AUMID 没有任何开始菜单快捷方式注册它。这种情况下 Windows 会接受
toast、接口也报告成功，但什么都不会显示。也正因如此，插件启动时会自检并写一条警告。你
可以自己确认：

```powershell
# 这台机器上注册了哪些 AUMID？
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace("$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
$folder.Items() | ForEach-Object { "$($_.Name) -> $($folder.GetDetailsOf($_, 0))" }

# 操作中心里实际投递了什么？
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('com.deepseek.dsh') |
  ForEach-Object { $_.Content.GetXml() }
```

**算数的是第二条查询**：如果通知出现在历史里、标题正文都对，说明投递链路是通的，问题在
别处。`Notification.isSupported()` 返回 true、或 `Show()` 没抛异常，都证明不了任何事。

如果历史是空的，确认 `%APPDATA%\Microsoft\Windows\Start Menu\Programs` 下有一个快捷方式带
`System.AppUserModel.ID = com.deepseek.dsh`。DSH 自己的快捷方式（`DeepSeek Harness.lnk`）
在安装时就会带上它。如果你的 DSH 是别的方式装的，把 `notify.aumid` 改成你快捷方式上实际
的那个值。

### 适配器退出码是 0，但什么都没有出现

**不要用 `detached: true` 启动适配器。** `DETACHED_PROCESS` 没有控制台，在这种状态下
`ToastNotificationManager.CreateToastNotifier(...).Show(...)` 不抛异常就返回，而 Windows
直接把这条通知丢掉 —— 脚本自认成功，退出码是 `0`。这是 Windows 11 上实测的结论，测量方法
是每次运行前清空操作中心：所有带 `detached: true` 的启动变体都什么都没投递，所有不带它的
变体都投递成功。因此插件用的是普通子进程 + 仅 `unref()`；`unref()` 已经足够让它不占用宿主
的事件循环。`lib/os/win.js` 里记录了这次实测，`test/os-win.test.mjs` 会在有人把 detached
加回来时失败。

### 通知弹了但没有声音

- `sound.enabled` 为 `true`，`sound.volume` 大于 `0`。
- `sound.minGapMs`：距上一次提醒不足 400 ms 时会复用上一次的声音。
- 已有一个播放进程在跑；两次声音不会重叠。
- 场景目录为空且 `sound.fallback` 播不了。日志里会有 `no playable WAV`。
- 那个文件其实不是 WAV。`MediaPlayer` 读的是文件自身的头信息，插件算出的时长只是提示。

### 中文变成乱码

这是编码问题，插件在两处做了防护：适配器脚本以 **UTF-8 with BOM** 保存，所有动态文本都以
单个 base64(UTF-8) 参数传入，不做命令行字符串拼接。`.gitattributes` 保证克隆后 BOM 仍在。
如果出现乱码，说明你的 `lib/os/win-alert.ps1` 丢了 BOM —— 重新 clone，或者把文件按
「UTF-8 with BOM」另存一次。

### 提醒比预期晚

「完成」提醒是**有意去抖**的：只有该会话在 `complete.debounceMs` 内再无任何动静才发。任何
新一轮、任何非干净结束、任何新提问都会取消它。这也是有意为之 —— 官方明确劝退把
`agent/status` 当完成信号，所以本插件改为等待「静默」。想更灵敏就调小
`complete.debounceMs`。

### 插件根本没加载

日志里搜 `dsh-task-ask-notify`。`Config` 校验失败，或缺少 `@deepseek-ai/schemastery`
依赖，都会让 `apply()` 不执行。

> **不要为了「修好」它去 import `electron`。** DSH 宿主以
> `ELECTRON_RUN_AS_NODE=1` 运行，`require('electron')` 只会拿到可执行文件路径，
> 那里面没有 `Notification`、没有 `app`、没有 `BrowserWindow`。本插件之所以要调用系统自带的
> Windows PowerShell，正是因为这一点。另外 PowerShell 7（`pwsh`）无法投影 WinRT 的 toast
> 类型，所以解释器是显式指定的 `powershell.exe` 5.1。

### 后台助手的活干完了却不提醒

子代理会话默认被排除。想让每个助手也各提醒一次，把 `sessions.includeSubagents` 设为
`true`。

---

## 仓库边界

**本仓库可以直接公开，而本节就是让这件事可核查、而不是一句口号的契约。**

### 提交什么

源码、测试、工具、文档与元数据：

```
.gitattributes  .gitignore  LICENSE
README.md  README.en.md
package.json  cordis.patch.yml
icon.svg  locale/{en,zh}.json
lib/**                       插件本体
lib/client.js                浏览器半侧：配置页
lib/os/win-alert.ps1         Windows 适配器脚本
audio/_default/chime.wav     生成物、可复现（完成兜底）
audio/failed/alert-fail.wav  生成物、可复现（失败提示，下行三音）
audio/{complete,ask-single,ask-multiple}/.gitkeep   空目录占位
tools/**                     提示音生成、音效导入、自检、边界检查、profile 回滚
test/**                      测试
```

### 有意不提交什么

| 排除项 | 原因 |
|---|---|
| `DESIGN.md`、`docs/**` | 内部方案笔记，引用了撰写时那台机器的绝对目录，公开即等于泄露本机目录结构。 |
| `audio/complete/*.wav`、`audio/ask-single/*.wav`、`audio/ask-multiple/*.wav`、`audio/failed/*.wav`（`alert-fail.wav` 除外） | 导入的音效属于个人素材，其授权归属制作者。`tools/import-audio.mjs` 会把它们放进你的音频目录，`.gitignore` 负责让它们进不了提交。哈希记录 `.audio-import.json` 同理排除，因为它记录了这些文件名。 |
| 你的音频目录与 `config.json` | 两者都位于 `%DSH_HOME%\plugin-data\dsh-task-ask-notify\`，在任何克隆之外；这里再忽略一次作为第二道防线。 |
| `node_modules/`、`coverage/`、`dist/`、`build/` | 可由 `package.json` 复现，出现在 diff 里只是噪音。 |
| `package-lock.json`、`pnpm-lock.yaml`、`yarn.lock` | 安装由 DSH 的 `install_bundle`（pnpm）负责。第二份锁文件只会描述另一个解析器并造成漂移。 |
| `.env*`、`*.pem`、`*.key`、`.credentials.yaml` 等 | 凭据与本地环境。 |

本项目不含任何形式的密钥：它不保存账号、不保存 token、不保存 API key，也不发起网络请求。

### 自己验证这条边界

```sh
npm run verify-boundary   # 命中本机路径、凭据、运行期状态、超大文件就失败
npm run verify-audio      # 用记录的哈希复核已导入的音效
```

`verify-boundary` 检查的是 **git 会发布的那批文件**（`git ls-files`），而不是工作区 ——
未跟踪的本地文件（导入的音效、你自己的 `config.json`）恰恰是这条边界要挡在外面的东西。
它会报告本机绝对路径、形似凭据的文本、运行期状态与异常大的文件，命中任何一项就以非零码
退出。每次 push 之前跑一遍。

上面的目录设计就是为了让这项检查通过：全新克隆里没有本机绝对路径、没有个人素材、没有
运行期数据，而插件在克隆后即可使用，因为默认提示音是提交进仓库的。

---

## 开发

```sh
npm install     # 仅为跑测试而装的唯一运行期依赖
npm test        # 108 个测试，不联网、无副作用
```

测试套件不往仓库里写任何东西：临时文件全部落在系统临时目录。没有任何测试会弹通知或出声 ——
会出声、会弹窗的是下面这几条显式命令：

```sh
node tools/win-alert-selftest.mjs                # 一条真通知 + 一次真播放
node tools/win-alert-selftest.mjs --no-audio     # 只弹通知
node tools/gen-default-chime.mjs --check         # 重新渲染并校验完成提示音
node tools/gen-failure-alert.mjs --check         # 重新渲染并校验失败提示音
```

结构，以及为什么这样拆：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 入口。读取 `Config`、订阅 `session/event`、负责销毁。 |
| `lib/config.js` | schema、分层配置、热重载。 |
| `lib/signals.js` | 事件到场景的判定。纯函数：没有时钟、没有文件系统、没有 OS。 |
| `lib/dispatch.js` | 去抖、去重、声音仲裁。不含任何 OS 知识。 |
| `lib/policy.js` | 目录约定、等概率选取、WAV 时长。 |
| `lib/os/win.js`、`lib/os/win-alert.ps1` | 唯一知道 Windows 存在的两个文件。换投递通道只会动这两个。 |

---

## 已知限制

- **仅 Windows。** 投递通道是 Windows toast 加一个播放 WAV 的子进程，没有 macOS / Linux 适配器。
- **点击通知没有反应。** DSH 未注册 URI 协议，toast 没有可跳转的目标。通知按设计不带按钮、
  不带深链。
- **配置页只管开关和数值。** 通知文案、AUMID、音效目录、失败原因列表不在页面上，它们写在
  `%DSH_HOME%\plugin-data\dsh-task-ask-notify\config.json`（热重载）或本 bundle 的
  `cordis.patch.yml` 里；schema 是导出的，因此 DSH 自己的配置界面也能看到并校验它们。
- **「完成」是静默期判定，不是状态机。** 多轮任务若每轮间隔超过 `complete.debounceMs`，
  就会响多次。调大该值可以合并；代价是短任务也要等这么久。
- **「失败」只认 `failed.reasons`（默认 `error`）。** 你手动停止（`aborted`/`interrupted`）、
  在等审批（`blocked`）、回答被截断但已交付（`max-tokens`）都不会响 —— DSH 自己也只对 `error`
  显示红色的「本轮运行失败」。要让它们也提醒，往这个数组里加。
- **失败提醒有去重没有去抖。** `dedup.failedMs`（默认 5000）挡住自动重试刷屏；但如果重试间隔
  长于它，每次失败都会各响一次。
- **通知是发后不管的。** toast 没有投递回执；上面那条系统侧历史查询是最接近的验证手段，
  插件自己这一半则通过日志记录适配器退出码。

---

## 致谢

- 默认提示音复刻了社区插件 **`@yangzhe1991/dsh-web-enhance`**（MIT）里「跑完提醒」的音色与
  包络；该插件在浏览器里用 Web Audio 现场合成，而宿主插件没有 Web Audio，所以本仓库把同样
  两段音离线渲染成 WAV 并提交。
- 通知投递遵循官方文档所述的「非打包 Win32 桌面 toast」路径：由一个系统自带的
  PowerShell 5.1 子进程调用 `ToastNotificationManager.CreateToastNotifier(aumid)`，AUMID
  复用 DSH 已经注册好的那个。

## 许可证

[MIT](LICENSE) © 2026 deadbushxw。
