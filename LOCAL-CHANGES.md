# 本目录相对上游的本地改动（失败提醒功能）

上游：https://github.com/deadbushxw/dsh-task-ask-notify （main 分支 tarball，2026-10-08 解压）

**为什么有这份文件**：本目录不是纯净的上游代码，为了给插件加「本轮运行失败时也提醒」，
改了其中几个文件。如果哪天有人把本目录用一份新的上游 tarball 整体覆盖，这些改动会**静默消失**
（表现为：失败不再有提示音和通知，只剩「完成」和「提问」两种提醒）。照下面的清单重打即可恢复。

**为什么放在插件目录外面**：放在里面会被 `pnpm` 复制进 profile，也会进上游的发布边界检查；
放在外面则任何重装、任何边界检查都碰不到它。

---

## 一、改动了什么（一句话版）

插件原来只在**任务完成**和**模型向你提问**时提醒；现在**运行失败**也会立刻提醒，
并配了一个**和完成提示音反向**的下行提示音。

具体行为：

| | 改动前 | 改动后 |
|---|---|---|
| 失败（`turn/end` 的 `reason.kind === 'error'`） | 静默（只取消待发的完成提醒） | **立刻**弹通知 + 响下行三音，正文附上失败原因 |
| 手动停止 / 等审批 / 截断 | 静默 | 仍静默（与 DSH 自己的红字判定一致，可在 `failed.reasons` 里改） |
| 重试刷屏 | — | 5000ms 内只响一次（`dedup.failedMs`） |
| 提示音 | 只有上行 880→1318.5 Hz | 新增下行 659.25→554.37→440 Hz，一听就分得清 |

## 二、被改过的文件

| 文件 | 改了什么 |
|---|---|
| `lib/signals.js` | `SCENARIOS` 增加 `failed`；`turn/end` 顺带取出 `reason.error.message/code` 作为失败原因（新函数 `readFailureMessage`）；新增 `DEFAULT_FAILURE_REASONS` |
| `lib/dispatch.js` | 非干净结束时不再只 `#cancel`，改为调用新增的 `#onTurnFailure`（立刻发通知、走去重、不走静默期）；`#fire`/试听的场景映射加上 `failed`；正文拼接支持 `detail`（失败原因）；状态里加 `lastFailureAt` |
| `lib/config.js` | schema 新增 `failed`（`enabled`/`dir`/`reasons`/`includeReason`，前两个带 `.volatile()`）、`dedup.failedMs`、`messages.failedTitle` |
| `lib/client.js` | 配置页新增「运行失败」分组（两个开关）+ 中英文案 + 摘要行的「失败」项 |
| `lib/os/win-alert.ps1` | 音频段不再用 WPF `MediaPlayer`，改为 WinRT `MediaPlayer` + `SoundPlayer` 兜底（见第七节，2026-10-23） |
| `.gitignore` | 白名单加 `!/audio/failed/alert-fail.wav`，并更新了那段注释 |
| `README.md` / `README.en.md` | 目录表、配置表、生成器说明、仓库边界、已知限制全部同步；顺手修掉一处自相矛盾的旧文案（原文写「GUI 里没有设置页」，但 README 上半部分就在介绍配置页）；测试数 79→108 |
| `test/config.test.mjs` | `PAGE_FIELDS` 加两条新字段；补默认值断言与「必须非 volatile」清单 |
| `test/dispatch.test.mjs` | 测试脚手架给 `failed` 建音效目录；试听覆盖范围断言加 `failed`；新增 6 条失败场景用例 |
| `test/signals.test.mjs` | 新增失败原因提取用例 |

## 三、新增的文件

| 文件 | 作用 |
|---|---|
| `tools/gen-failure-alert.mjs` | 失败提示音的生成器，复用 `gen-default-chime.mjs` 的采样/编码/峰值检测；`--check` 可复现校验 |
| `audio/failed/alert-fail.wav` | 由上面脚本生成的下行三音（28710 字节，22050 Hz 单声道 16-bit PCM，0.65s） |
| `test/failure-sound.test.mjs` | 断言提交的 WAV 与生成器逐字节一致、三个音高正确、且**不等于**完成提示音 |

## 四、怎么重打（上游被覆盖之后）

1. 重新解压上游 tarball 到本目录（会把改动覆盖掉，属预期）。
2. 按第二节逐个文件重做修改、按第三节重建三个新增文件。
3. 失败音直接跑 `node tools/gen-failure-alert.mjs` 生成，再 `--check` 校验，不用手写。
4. 跑测试：`node --test test/*.test.mjs`，**应当 108 个全绿**（当前状态就是 108）。
   跑之前需要在本目录装依赖：`node <DSH运行时>\pnpm\bin\pnpm.cjs install`（只装
   `@deepseek-ai/schemastery`，是测试用的唯一依赖）。
5. 同步进 profile：把 `lib` `tools` `locale` `audio` 四个目录和
   `README.md` `README.en.md` `cordis.patch.yml` `icon.svg` `LICENSE` `package.json`
   复制到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-task-ask-notify\`
   （`file:` 安装不会自动同步，必须手动复制，**不要复制 `test` 和 `node_modules`**）。
6. 重启 DSH。

## 五、怎么回滚（想退回上游原样）

把第一到第三节的文件全部还原成上游版本，再按第四节第 5 步同步进 profile，重启 DSH。
失败提醒随之消失，其余两种提醒不受影响。

## 六、验证是否生效

- 端到端：断网后发一条消息，请求失败应听到下行三音并弹出「本轮运行失败」通知。
- 单测：`node --test test/*.test.mjs` 108 全绿。
- **本机备注（2026-10-23）**：`policy.test.mjs` 的「目录缓存能发现文件被删除」一例在本机稳定失败，
  原因是本机 `rmSync` 后目录仍会短暂列出已删文件（delete-pending，杀软/索引持有句柄），
  与本次播放改动无关；其余 107 例全绿。
- 已于 2026-10-09 实测通过（宿主加载新版代码后人工确认有声音）。

## 七、2026-10-23 补充：提示音「有弹窗、没声音」的修复

**症状**：任务完成有通知弹窗，但完全没声音。第一怀疑是音频文件被删 —— **不是**。
`audio/_default/chime.wav`、`audio/failed/alert-fail.wav` 都在，头部正常，峰值约 25%，源码与
profile 副本逐字节一致。

**真因**：`lib/os/win-alert.ps1` 原来用 WPF `System.Windows.Media.MediaPlayer` 播放，它依赖
Windows Media Player 组件。本机 `C:\Windows\System32\wmp.dll` 与
`C:\Program Files\Windows Media Player` 都已不存在（精简系统 / 去臃肿工具 / 2026-10-14、10-16
那批更新之后）。于是这个播放器**打开文件不报错、拿不到时长、也不出声**，而适配器照样 `exit 0`，
症状就只剩「有弹窗没声音」。

**判定方法（不用靠耳朵）**：读默认输出端点的峰值电平（CoreAudio `IAudioMeterInformation`），
边播边采样。修复前：

| 播放方式 | peakMax | 其它 |
|---|---|---|
| WPF `MediaPlayer`（原实现） | **0.0000** | `HasAudio=False`、`Position=00:00:00`、`DownloadProgress=0` |
| Windows 系统提示音 | 0.5821 | 同一时刻，证明声卡与输出正常 |
| `System.Media.SoundPlayer` | 0.3318 | 说明媒体栈坏了，winmm 没坏 |
| WinRT `Windows.Media.Playback.MediaPlayer` | 0.3642 | `PlaybackState=Playing`、位置走到 0.6s |

顺带排除：系统主音量 1.000、未静音、输出端点状态为 ACTIVE「扬声器」。

**改法**：只动 `lib/os/win-alert.ps1` 的音频段，改成两级引擎：

1. WinRT `Windows.Media.Playback.MediaPlayer` —— 直接走 Media Foundation，**不依赖 WMP**，
   支持 `Volume`（0–1）。主路径。
2. `System.Media.SoundPlayer` —— winmm waveOut，完全不沾媒体栈，但没有音量控制。兜底。
3. 不再调用 WPF `MediaPlayer`。

其它部分（弹窗、退出码 0/2/3/4/12、`maxDurationMs` 上限、BOM/CRLF）保持不变；文件仍是
UTF-8 with BOM。

**验证**：同一探针复测，volume=1.0 → 0.295、0.3 → 0.104、0.05 → 0.015（随音量线性），
适配器 `exit 0`，弹窗+声音端到端正常。

**注意**：

- 这个 `.ps1` 是**每次提醒时新起进程读取的**，改完不需要重启 DSH，下一条提醒就生效；
  但仍需按第四节第 5 步同步进 profile（否则宿主加载的还是旧副本）。
- 配置里的 `sound.volume` 是 0–100 百分比。当前 profile 里是 `30`，等于把峰值 25% 的提示音
  再压到 7.5%，能听见但偏轻；想更明显就调到 100。

> 本文件不含任何本机绝对路径、不含任何凭据，可以直接随仓库公开。
