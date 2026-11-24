# dsh-doubao-signin

豆包（Doubao）网页模型反代 + 每日签到，打包成一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。

装好之后模型侧多出五个工具：

| 工具 | 干什么 |
|---|---|
| `doubao_login` | **浏览器扫码登录**（抖音 App 扫码），把会话 cookie 存本机 —— **不需要装豆包桌面客户端** |
| `doubao_chat` | 向豆包网页端发一次对话，流式收完，返回文本 |
| `doubao_checkin` | 领取「天天领额度」每日签到（平日 200，周一 400） |
| `doubao_status` | 只读体检：客户端在哪、调试端口通不通、签到卡片什么状态 |
| `doubao_quota` | 只读额度看板：套餐积分 + 活动赠送额度（签到领的那份），带重置倒计时 |

## 第一次用：扫码登录

**不需要安装豆包桌面客户端。** 直接对模型说：

```
用 doubao_login 扫码登录豆包
```

它会拉起一个**独立的浏览器窗口**（Edge 或 Chrome，用的是插件自己的用户目录 `~/.dsh/doubao-signin/browser-profile`，不影响你日常浏览器），打开豆包登录页 —— 用**抖音 App**扫码（用豆包 App 扫会静默失败），扫完自动抓取会话 cookie 存到 `~/.dsh/doubao-signin/credentials.json`（权限 0600），浏览器自动关闭。

浏览器目录是持久的：第二次登录通常免扫码，直接扫一次就续上了。

想先看登录态而不拉浏览器：`doubao_login` 带 `dryRun: true`。

**两条凭据路径**（自动择优）：

| 来源 | 何时用 | 前提 |
|---|---|---|
| 扫码保存的凭据 | 优先 | 跑过一次 `doubao_login` |
| 已登录的豆包桌面客户端 | 扫码凭据不存在时兜底 | 客户端装过、登录过 |

核心思路一句话：**不逆向豆包，借豆包**。聊天走**双通道**：

1. **直连优先（v0.3.0 起，默认开）**：健康账号不需要签名——实测 `/chat/completion` 只认 cookie + 设备指纹。插件从客户端的 `Local State` 读出它自己注册的 `device_id`（新造的 id 必被风控拒绝），带着客户端身份直连，**不碰 CDP、不需要调试端口**。客户端只要登录过一次即可，不必保持运行。
2. **CDP 签名桥（降级路径）**：直连被风控拒绝（`710022004`）时降级到签名桥——通过 CDP 在已登录客户端页面里现算 `a_bogus`，签名由客户端自己完成。也可以用 `directFirst: false` 强制永远走这条。

两个通道都意味着：

- 不需要存你的密码、不需要重放登录接口；
- 不需要复刻 `byted_acrawler.frontierSign`（那是混淆 JS，每版都在变，复刻必然腐烂）；
- 不自带 Playwright、不额外起浏览器——少一份风控面，少 300MB 内存。

签到同理：不直接打签到接口（签到接口的风控比聊天严得多，一次坏调用可能把 `msToken` 打进冷却、连带把聊天打挂），而是用 CDP **点真实 UI 上那颗签到按钮**，请求由客户端自己发出，签名由客户端自己算。

## 安装

前提：本机装有豆包桌面客户端并且登录过；DSH ≥ 0.2.2-rc.0。

DSH 没有"从仓库地址填一个框就装"的入口，装 git 源插件就是切到 profile 目录跑 pnpm：

**Web / 桌面版**（Windows）——Win+R 输入 `powershell` 回车，粘贴：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" add git+https://github.com/shuanglongdujian/dsh-doubao-signin.git#v0.3.0
```

macOS / Linux：

```bash
cd ~/.dsh/profiles/desktop
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs add \
  git+https://github.com/shuanglongdujian/dsh-doubao-signin.git#v0.1.0
```

**CLI profile**（如果你用 `dsh web` / `dsh tui` 这类启动方式）：

```bash
dsh plugin --profile <你的profile> add git+https://github.com/shuanglongdujian/dsh-doubao-signin.git#v0.1.0
```

`desktop` 这个 profile 由 Electron 独占管理，`dsh plugin --profile desktop` 会拒绝，所以桌面版走上面切目录的路子。

`#v0.1.0` 是发布标签。git 源插件必须锁一个 ref（标签、分支名或完整 commit 都行），DSH 市场索引里用的是完整 40 位 commit，形状见仓库根的 `market-index.json`。升级时把 ref 换成新标签即可；想彻底锁死可换成完整 commit 号。

装完**重启 DSH**。插件是自插入 bundle：`dsh.bundle.patch` 指向包内 `cordis.patch.yml`，一行 `insert` 就把 `plugin-doubao` 挂上，配置默认 `cdpPort: 9222`、`relaunchClient: false`。

装好可以用这条自查（profile 由 Electron 管理的 desktop 换成你自己的 profile 名）：

```bash
dsh --profile <你的profile> --dump-config | grep -A4 "dsh-doubao-signin"
```

看到 `- id: doubao-signin` 就成功了。

## 使用

### 聊天

```
用 doubao_chat 问豆包：用一句话解释 KV cache
```

可用模型见 [模型表](#支持模型)。

### 签到（先 dry-run！）

```
用 doubao_checkin 看一下今天的签到状态（dryRun: true）
```

确认返回 `state: "can_sign"` 之后再真签：

```
用 doubao_checkin 签到
```

### 出问题先体检

```
跑一下 doubao_status
```

### 查额度

```
用 doubao_quota 看看我还有多少额度
```

返回套餐积分（豆包 2026-11 改版后的主额度）与活动赠送额度（每日签到领的那份），各带重置倒计时。只读、不消耗推理额度——借客户端 cookie 直连汇总端点，实测该端点不验 `a_bogus`。读取失败会明确说"读不出"，不会静默显示 0。

## 设置页界面（v0.5.2 起）

**不用问模型，设置里直接看。** 重启 DSH 后，设置左侧导航出现「**豆包**」一项，点进去有三个标签页：

| 标签 | 内容 |
|---|---|
| **额度** | 剩余额度合计（套餐积分 + 活动赠送额度 = 每日签到领的那份），各窗口带重置倒计时，30 秒自动刷新；下方标注凭据来源（扫码保存 / 豆包桌面客户端） |
| **登录** | 「扫码登录」按钮——点它直接拉起浏览器让你扫（不用回对话里说"用 doubao_login"）；扫码中显示进度，可取消 |
| **签到** | 「执行每日签到」按钮——点一下就签（走客户端真实 UI，签名由客户端算），结果就地显示（状态 + 消息） |

安全边界：豆包 cookie 只活在 Host 进程里，**永远不进页面**；卡片与 Host 之间是同源 loopback 路由（GET 读额度 / POST 显式签到与扫码），Host 头和 Origin 都要是本机回环（防 DNS rebinding）。



## 健壮性（v0.2.0 起）

聊天路径内置了四层防护，全部来自同类插件的实测逆向结论：

| 防护 | 对抗什么 | 行为 |
|---|---|---|
| **审核拦截识别** | 豆包内容审核不返回错误码，回一段以「该内容涉嫌违反」开头的正常文本流 + stop——不识别它的话你会看到一个"突然不会说话"的模型 | 流式第一个 delta 就判定，换成明确的结构化错误（"内容审核拦截，不是模型故障"），不会重试进同一个过滤器 |
| **宿主注入剥离** | DSH 会在 messages 里塞 `<system-reminder>`（AGENTS.md、运行模式前言，数万字符）——这些词正是触发消费者端点审核的主因 | 出网前剥掉标签；用户粘贴的长文档不受影响 |
| **32K prompt 预算** | 长会话压平后（百万字符级）被网关以 `common invalid param` 静默拒绝，HTTP 仍 200 | 超预算保尾截断（最后一条指令永不丢），截断了会在 notes 里说明 |
| **限速 + 熔断** | 豆包风控对连发敏感；`710022004` 不是限流，是 shark 风控的滑块验证，重试只会加深 | 整轮持锁 + 轮间最小间隔（`minIntervalMs`，默认 1.5s）；命中风控码熔断 10 分钟（`riskCooldownMs`），冷却期内不发请求，绝不自动重试 |

## 直连 vs 签名桥（v0.3.0 起）

| | 直连（默认首选） | CDP 签名桥 |
|---|---|---|
| 触发条件 | 账号健康 + 客户端登录过一次（Local State 有 device_id） | 直连被风控拒绝、`directFirst: false`、或设备身份读不到 |
| 是否需要客户端运行 | 否（只读它的数据文件） | 是（且需要调试端口） |
| 签名 | 不带 `a_bogus`（健康账号不验） | 页面现算 |
| 失败语义 | `710022004` → 熔断 + 降级指引 | 风控 → 熔断；桥断 → 可重试 |
| 配置 | `directFirst: true`（默认） | `allowBridgeFallback: false` 可禁止降级 |

设备身份读取顺序：`Local State`（`aha.device.device_id`，明文 JSON、永不锁）→ leveldb（`client_device_info` + `__tea_cache_tokens_582478` 的 web_id，前缀压缩后可能落空，只作兜底）。cookie 运行时借 CDP 从客户端页面读——客户端运行中 Cookies SQLite 被独占锁，这是唯一不被锁的来源。

## 额度卡片（v0.4.0 起，直接看，不用问）

装完重启 DSH，设置页的豆包卡片下方会渲染一块**只读额度看板**：剩余合计、套餐积分、活动赠送额度（签到领的那份），各带重置倒计时，30 秒自动刷新——**打开页面就能看到还剩多少，不用问模型**。

实现与安全边界：

- 浏览器侧是 `client/doubao-card.js`（CJS，`dsh.client` 声明挂 `settings.section` slot）；数据来自 Host 半身的 loopback 路由 `/plugins/dsh-doubao-signin/quota`（GET-only、同源、`no-store`、响应按允许清单构造）；
- **豆包 cookie 永远不进页面**——卡片只跟本机 Host 说话，凭据只活在 Host 进程里；
- 卡片只读不写：签到走 `doubao_checkin` 工具（必须由客户端真实 UI 发出，浏览器侧不碰）；
- `webServer` 服务缺席时路由不注册，四个工具照常工作。


## 第一次用必须知道的一件事：调试端口

豆包的 `--remote-debugging-port` **只能在启动命令行时带上**，运行中的 Electron 进程没有这个口，谁也没法事后给它开。所以：

1. **手动方式（推荐）**：关掉豆包，用命令行启动一次：

   ```powershell
   & "C:\...\Doubao.exe" --remote-debugging-port=9222
   ```

   之后正常使用，插件随时可用。

2. **让插件重启你**：把配置项 `relaunchClient` 设为 `true`。第一次调用工具时插件会 `taskkill` 掉豆包再带端口重启它。**这会杀掉你正在用的窗口**，默认关闭，请三思再开。

端口开着的前提下，一切操作对豆包是零侵入的：不装扩展、不改文件、不注入代码，只在它的页面里调一次 `window.byted_acrawler.frontierSign` 并读一次 cookie。

## 配置项

在插件设置里改（对应 `cordis.patch.yml` 的 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `cdpPort` | `9222` | 客户端调试端口 |
| `relaunchClient` | `false` | 允许插件重启客户端以打开端口（会杀正在用的窗口） |
| `exePath` | `''` | 手动指定 Doubao.exe 路径；留空自动发现（注册表 + 常见安装目录） |
| `defaultModel` | `doubao-pro-chat` | `doubao_chat` 的默认模型 |
| `timeoutMs` | `180000` | 单次聊天超时 |

## 支持模型

`doubao_chat` 的 `model` 参数可选：

| id | 说明 |
|---|---|
| `doubao-pro-chat` | 豆包主力（网页默认） |
| `doubao-lite` | 轻量款 |
| `doubao-work-auto` | 工作台自动路由（走 `agent_mode=1`，需要模型在工作台里可用） |
| `doubao-2.1-pro` | 豆包 2.1 pro |
| `deepseek-v4.1-flash` | 豆包里的 DeepSeek 车道 |
| `kimi-k3` | 豆包里的 Kimi 车道 |
| `glm-5.3` | 豆包里的 GLM 车道 |

> 这些 id 对应网页端的 bot/路由参数，随豆包改版可能漂移。漂移了先跑 `doubao_status`，再来 [issue](https://github.com/shuanglongdujian/dsh-doubao-signin/issues) 里贴一下返回。

## 诚实边界（已知做不到/打折的事）

这个插件是反代，不是 OpenAI 服务，不伪装成它是。明确说清楚：

- **没有原生 function calling**。`doubao_chat` 的 `tools` 参数是文本仿真：把工具表拼进 prompt，约定模型用 `<tool_call>` 输出，回来后解析成 OpenAI 形状的 `tool_calls`。能用，但可靠性低于原生通道。
- **没有真会话状态**。多轮消息会被压平成一条 prompt 发送。上下文请自己管理，别指望豆包网页端替你去记。
- **`temperature` / `max_tokens` 不存在**。网页端没有这两个旋钮，本插件直接不收这两个参数——宁缺毋假。
- **拿不到 `usage`**。网页端不回传 token 计量，返回里没有 usage 字段。
- **SSE 帧解析有兜底**。认不出的帧会计入 `unknownFrames` 并在 `notes` 里提醒，不会静默吞掉——协议改版你能第一时间知道。
- **签到只在 PC 客户端有效**。网页版没有签到入口（活动限定 PC），所以这条路径离开客户端就跑不通，这是设计如此。
- 签到的额度规则：每天 200，周一翻倍到 400，连续签到上限 8800，30 天未签到清零。
- **风控自负**。签名走客户端真实会话，理论上是正常流量形态，但豆包随时可以改协议、改活动、改风控。本项目不承诺这些行为永远可用。

## 开发与测试

```sh
node --test              # 154 个离线用例（协议/签名缓存/健壮性/额度解析/直连与身份/路由闸门/工具装载/打包防呆）
node test/live-mount.mjs # 真 cordis Context 下挂载验证
```

测试不联网、不需要豆包客户端：网络层全部走注入，协议逻辑纯函数。装载测试直接从 DSH 安装目录借真实的 `assertSupportedJsonSchema` 校验器跑 schema，保证「过了测试 = 能过 loader」。`prepack` 钩子在打包前强制跑 manifest 测试（无 BOM、JSON 可解析、files 白名单文件真实存在）——防 "装完才发现坏" 的那类事故。

包内 `index.js` / `src/*.js` **不 import 任何 `@deepseek-ai/*`**——第三方插件跑在 profile 的 node_modules 里，那里没有核心包，一切交互走 `ctx.tools` / `ctx.logger` 服务面。

结构：

```
index.js            Host 半身：注册四个工具
src/protocol.js     纯逻辑：请求体构造 / SSE 解析 / 工具仿真（可离线测）
src/hardening.js    健壮性：审核识别 / 清洗 / prompt 预算 / 限速锁 / 熔断（可离线测）
src/quota.js        额度解析：quota/summary 窗口归一化（可离线测）
src/direct.js      直连通道：无签名聊天 + cookie 就绪判定 + 桌面身份 query（可离线测）
src/identity.js    设备身份：Local State / leveldb 读 device_id、fp、web_id（可离线测）
src/signer.js       ClientSigner：CDP 借客户端算 a_bogus + 发聊天/额度请求（签名缓存 120s）
src/checkin.js      签到状态机：找客户端 / 开端口 / 探卡片 / 点按钮
```

## 常见问题

**Q: doubao_status 说端口没开，可我明明开着豆包？**
A: 正常运行没带 `--remote-debugging-port` 就是没开，见上文「调试端口」。

**Q: 报「客户端没有可用页面」？**
A: 客户端开着但一个窗口都没显示（比如缩进托盘还没渲染过页面）。把豆包窗口点开一次再试。

**Q: 签到返回 `state: "campaign_changed"`？**
A: `data-reward-code="daily_signin"` 这张卡片在活动页上找不到了——豆包改了活动布局。贴 `doubao_status` 输出开个 issue。

**Q: 聊天回一段空文本 + `notes` 说协议可能改版？**
A: SSE 事件结构变了。同样是 `doubao_status` + issue。

**Q: 能不能不进 DSH 单独用？**
A: 不能。它就是按 DSH 插件的装载契约（自插入 bundle）写的，Host 半边依赖 cordis 的 `tools` 服务。

## License

MIT

## 免责声明

本项目是个人学习与互操作研究，与字节跳动无任何关联。「豆包 / Doubao」及其接口归字节跳动所有。使用本插件遵守豆包用户协议的责任在你；把它用在批量注册、薅额度、绕过付费这类事上，风控先找的是你的账号。
