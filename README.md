# ACP Feishu Agent Bridge

基于 ACP 协议把编程智能体接入飞书机器人。服务通过飞书长连接接收文本消息，为每个飞书聊天维护当前 agent 和 ACP 会话，并把 agent 的 Markdown 输出转换为飞书 `post` 富文本消息发送回聊天。

架构分层见 [ARCHITECTURE.md](./ARCHITECTURE.md)。当前实现已经抽出平台无关的消息模型、命令路由、消息合并器、会话队列和 incoming pipeline；后续可以继续把 reply adapter 边界抽清楚。

## Setup

```bash
npm install
cp .env.example .env
```

填写 `.env`：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ACP_DEFAULT_CWD=/Users/yourname/projects

AGENT_DEFAULT=kimi
KIMI_PATH=kimi
AGENT_KIMI_COMMAND=kimi
AGENT_KIMI_ARGS=acp

# Codex CLI 通过 Zed 的 ACP adapter 接入，默认 gpt-5.5 + high reasoning
AGENT_CODEX_COMMAND=npx
AGENT_CODEX_ARGS=-y @zed-industries/codex-acp -c 'model="gpt-5.5"' -c 'model_reasoning_effort="high"'

DEBUG=false
SHOW_THINKING_TOOL=force
FEISHU_ACK_MODE=reaction
FEISHU_ACK_REACTION=OK
FEISHU_PROCESSING_REACTION=THINKING
# 可选：留空表示不额外添加完成/失败 reaction
FEISHU_DONE_REACTION=
FEISHU_ERROR_REACTION=
FEISHU_SEND_TIMEOUT_MS=15000
FEISHU_IMAGE_MAX_BYTES=10485760
FEISHU_MESSAGE_MERGE_WINDOW_MS=2000
ACP_PROMPT_TIMEOUT_MS=120000
STATE_FILE=.data/state.json

# QQ official bot adapter. Disabled unless explicitly enabled.
QQ_BOT_ENABLED=false
QQ_BOT_APP_ID=
QQ_BOT_APP_SECRET=
# Legacy QQ token auth is still accepted as a fallback.
QQ_BOT_TOKEN=
QQ_BOT_SANDBOX=false
QQ_BOT_INTENTS=33554432
QQ_BOT_REPLY_MAX_CHARS=1800
QQ_BOT_RECONNECT_MS=5000
QQ_BOT_IMAGE_MAX_BYTES=10485760
QQ_BOT_MESSAGE_MERGE_WINDOW_MS=2000
```

程序会优先读取项目根目录的 `.env`，并覆盖 shell 中已有的同名环境变量，避免误连到旧的飞书应用。

如果 `npm run dev` 报 `spawn kimi ENOENT`，说明当前进程找不到 `kimi` 可执行文件。先运行：

```bash
command -v kimi
```

然后把输出写入 `.env`，例如：

```env
KIMI_PATH=/home/joknem/.kimi-code/bin/kimi
AGENT_KIMI_COMMAND=/home/joknem/.kimi-code/bin/kimi
```

`ACP_DEFAULT_CWD` 也必须是当前机器上真实存在的目录。

Kimi CLI 需要已登录：

```bash
kimi login
```

飞书应用需要开启机器人能力、长连接，并订阅 `im.message.receive_v1` 事件。

图片消息会通过飞书的消息资源接口下载后转发给 ACP agent。默认最大图片大小是 10MB，可通过 `FEISHU_IMAGE_MAX_BYTES` 调整；当前只支持飞书 `image` 消息，不支持表情包、文件附件或合并转发里的子消息资源。

飞书会把“图片”和“图片说明文字”拆成相邻消息时，服务会在同一聊天内等待一个很短的合并窗口，把连续到达的普通文本/图片合成一次 ACP prompt。默认窗口是 `FEISHU_MESSAGE_MERGE_WINDOW_MS=2000`，设为 `0` 可关闭合并。

## QQ Official Bot Adapter

QQ adapter 默认关闭；配置 QQ 官方机器人凭证后可与飞书并行启动：

```env
QQ_BOT_ENABLED=true
QQ_BOT_APP_ID=123456789
QQ_BOT_APP_SECRET=xxxxxxxxxxxxxxxx
QQ_BOT_SANDBOX=true
```

QQ 官方现在默认发放的是 `AppID` 和 `AppSecret`。程序会用它们调用 `https://bots.qq.com/app/getAppAccessToken` 换取 Access Token，并在 `/gateway`、WebSocket Identify 和发消息时使用 `QQBot <access_token>` 鉴权。`QQ_BOT_SANDBOX=true` 会使用 `https://sandbox.api.sgroup.qq.com`，否则使用正式环境 `https://api.sgroup.qq.com`。

旧版 `QQ_BOT_TOKEN` 仍保留为兼容字段：如果没有配置 `QQ_BOT_APP_SECRET`，程序会回退到旧的 `Bot {appid}.{token}` 鉴权格式。新机器人建议使用 `QQ_BOT_APP_SECRET`。

当前 QQ adapter 第一版支持：

- WebSocket Gateway 接收事件
- `C2C_MESSAGE_CREATE` 单聊文本和图片附件
- `GROUP_AT_MESSAGE_CREATE` 群聊 @ 文本和图片附件
- 文本回复，长回复会按 `QQ_BOT_REPLY_MAX_CHARS` 拆分，并使用 `msg_id + msg_seq` 被动回复
- 命令：`/help`、`/status`、`/queue`、`/doctor`、`/agent`、`/agent <name>`、`/agent switch <name>`、`/reset`

默认 intents 为 `33554432`，即 `1 << 25`，覆盖 QQ 单聊消息和群聊 @ 机器人消息。QQ 会在同一聊天内等待 `QQ_BOT_MESSAGE_MERGE_WINDOW_MS=2000`，把连续到达的普通文本/图片合成一次 ACP prompt；设为 `0` 可关闭合并。QQ 图片附件默认最大 10MB，可通过 `QQ_BOT_IMAGE_MAX_BYTES` 调整。QQ 当前还没接入文件、语音、视频、频道消息和 QQ 侧项目绑定命令。

## Acknowledgement

收到普通任务消息后，默认会给用户原消息加一个 reaction，表示已进入处理队列或正在处理：

```env
FEISHU_ACK_MODE=reaction
FEISHU_ACK_REACTION=OK
FEISHU_PROCESSING_REACTION=THINKING
```

可选值：

```env
FEISHU_ACK_MODE=off      # 不提示
FEISHU_ACK_MODE=reaction # 给原消息加 reaction
FEISHU_ACK_MODE=message  # 发送一条“已收到”消息
```

`FEISHU_PROCESSING_REACTION` 是任务进行中的 reaction，默认使用 `THINKING`，完成或失败后会自动移除。飞书 reaction 的 `emoji_type` 使用全大写值，例如 `OK`、`THINKING`、`DONE`；程序会自动 trim 并转成大写。`FEISHU_DONE_REACTION` 和 `FEISHU_ERROR_REACTION` 可选；配置后会在任务成功或失败时追加对应 reaction。

## Agent Switching

配置格式：

```env
AGENT_DEFAULT=kimi
AGENT_<NAME>_COMMAND=<executable>
AGENT_<NAME>_ARGS=<space separated args>
```

示例：

```env
AGENT_KIMI_COMMAND=/home/joknem/.kimi-code/bin/kimi
AGENT_KIMI_ARGS=acp

AGENT_CODEX_COMMAND=npx
AGENT_CODEX_ARGS=-y @zed-industries/codex-acp -c 'model="gpt-5.5"' -c 'model_reasoning_effort="high"'
```

飞书里发送：

```text
/agent
/agent kimi
/agent codex
/cwd
/cwd /home/joknem/acp-create
/project
/project add acp /home/joknem/acp-create
/project acp
/bind
/bind /home/joknem/acp-create
/bind acp
/bind new demo /home/joknem/demo
/unbind
/help
/status
/queue
/doctor
/doctor agent
/cancel
/reset
```

`/agent` 会显示当前聊天使用的 agent 和所有可用 agent。每个飞书聊天可以独立切换；切换时会为目标 agent 创建新的 ACP session。如果当前聊天有任务正在运行，切换 agent 会先请求取消当前任务。
聊天里展示的 agent command/args 会自动脱敏，明显的 token、key、secret、password 等参数会显示为 `<redacted>`。

`/cwd` 会显示当前聊天的工作目录。`/cwd <absolute-path>` 会只切换当前飞书聊天的工作目录，并清空该聊天已有的 agent session；下一条普通消息会在新目录下创建 session。不同飞书聊天互不影响。如果当前聊天有任务正在运行，切换 cwd 会先请求取消当前任务。

控制命令会立即执行，不会排在普通任务后面。普通消息会按当前聊天串行处理；如果前面有任务，会先进入队列，并通过 reaction 和短消息提示。

同一个 agent provider 的 ACP prompt 会再经过一层全局串行队列。也就是说，不同聊天可以分别排队，但最终同时打到 `kimi` 或 `codex` 的任务会按 provider 逐个执行，避免同一个 ACP 子进程并发 prompt 造成上下文或流状态错乱。

平台事件会按消息 ID 做持久去重，避免飞书/QQ 重推同一事件时重复调用 agent。去重缓存保存在 `STATE_FILE` 中，默认保留最近 5000 条或 7 天内的消息。

群聊默认需要先绑定项目目录，未绑定时普通消息不会发送给 agent。私聊不需要绑定，继续使用当前聊天的 cwd。

## Personal Project Aliases

单人使用时，建议用一个单聊或私有群，通过项目别名切换工作目录：

```text
/project add acp /home/joknem/acp-create
/project add blog /home/joknem/blog
/project
/project acp
```

命令：

```text
/project
/project list
/project add <name> [absolute-path]
/project remove <name>
/project <name>
```

如果省略路径，`/project add <name>` 会把当前聊天的 cwd 保存为该别名。项目别名是全局共享的；当前 agent 和 cwd 是按飞书聊天保存的。

## Group Project Binding

群聊可以绑定到一个项目目录，绑定后这个群就像一个固定的项目工作间：

```text
/bind /home/joknem/acp-create
/bind acp
/bind new demo /home/joknem/demo
/bind
/unbind
```

`/bind <absolute-path>` 会把群聊绑定到指定目录。`/bind <project-name>` 会优先使用 `/project add` 保存的项目别名。`/bind new <name> [absolute-path]` 会创建目录、保存同名项目别名，并把当前群聊绑定到该项目；省略路径时默认创建在 `ACP_DEFAULT_CWD/<name>`。`/bind` 会显示当前群聊绑定状态，`/unbind` 会移除绑定。

在群聊中使用 `/cwd <path>` 或 `/project <name>` 时，也会同步更新群聊绑定。绑定信息和项目别名一样保存在 `.data/state.json`。

状态默认保存在：

```text
.data/state.json
```

这个文件不会提交到 git。服务重启后会恢复每个聊天的当前 agent/cwd 和项目别名。

## Status

查看当前聊天配置：

```text
/status
```

会显示当前忙闲状态、排队数量、聊天类型、群聊绑定、当前 agent、cwd、agent 启动命令、ACK 模式、debug 配置、状态文件路径、项目别名数量和群聊绑定数量。
同时会显示当前 agent 的全局队列状态和消息去重缓存数量，便于判断任务是在聊天队列里等待，还是在 provider 全局队列里等待。

查看详细队列：

```text
/queue
```

会显示当前聊天的 active turn、正在合并的消息、会话队列 pending 项，以及每个 agent provider 的全局 active/pending 队列。

查看帮助：

```text
/help
```

运行自检：

```text
/doctor
/doctor config
/doctor agent
/doctor state
/doctor feishu
/doctor qq
/doctor chat
```

`/doctor` 会检查默认 cwd、状态文件可读写性、agent 命令是否可执行、Codex model/reasoning 参数、飞书/QQ 配置和当前聊天队列/绑定状态。飞书侧会额外做飞书凭证实时检查；QQ 侧会额外显示 QQ Gateway WebSocket 状态。
`/doctor agent` 只展示可诊断的 model/reasoning 摘要，不输出完整 agent args。

## Runtime Controls

```text
/cancel
/reset
```

`/cancel` 会立即向当前聊天正在使用的 ACP session 发送 `session/cancel`，不排队等待当前任务结束。`/reset` 会取消并丢弃当前聊天的 agent session，下一条普通消息会重新创建 session。

## Skills

如果要给个人工作流加 skills，建议先放在仓库内：

```text
skills/
  code-review.md
  release-checklist.md
  feishu-bot-debug.md
```

每个 skill 用一个 Markdown 文件，内容建议包含：

```text
# Skill Name

## When to use
什么时候使用这个 skill。

## Instructions
具体执行规则。

## Inputs
需要用户提供什么。

## Output
期望输出格式。
```

为什么放这里：

- 跟这个飞书 agent hub 绑定，容易备份和迁移
- 可以按项目提交一套常用工作流
- 以后可以自然扩展 `/skill list`、`/skill use <name>`，把 skill 文本注入给当前 agent

暂时不建议直接混进 `.data/`。`.data/` 更适合运行状态；skills 是可维护资产，应该放在可读、可版本管理的位置。

## Commands

```bash
npm run dev
npm run build
npm start
npm test
```

## Markdown Rendering

转换层会把常见 Markdown 转为飞书消息：

- 普通回复使用 `post` 原生富文本
- 包含 fenced code block、Markdown 表格或很长输出时优先使用 interactive card
- 超长 interactive card 会拆成多条编号 card 顺序发送，避免丢弃后半段内容
- interactive card 发送失败时会自动回退到 `post`

- 标题转为标题/加粗文本
- 粗体、斜体、删除线、行内代码转为 `text.style`
- 链接转为 `a`
- 有序/无序列表转为带缩进的文本行
- 表格转为等宽 `code_block`
- fenced code block 转为 `code_block`

`DEBUG=true` 且 `SHOW_THINKING_TOOL` 为 `summary` 或 `detailed` 时，会额外发送 thinking/tool-call 调试消息。
