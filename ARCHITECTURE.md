# ACP Agent Bridge Architecture

This project is an ACP agent gateway for chat platforms. Platform adapters receive user messages, normalize the conversation flow, and forward prompt content to ACP-compatible coding agents.

## Runtime Flow

```text
Feishu / QQ event
  -> platform adapter
  -> message dedupe
  -> command or ordinary-message pipeline
  -> message batcher
  -> per-conversation queue
  -> AgentManager
  -> per-provider prompt queue
  -> AcpAgentClient
  -> ACP agent process
  -> platform reply renderer / sender
```

## Layers

### Platform Adapters

- `src/feishu/FeishuBot.ts`
- `src/qq/QqBot.ts`

Adapters own platform-specific concerns: authentication, websocket/event handling, platform message parsing, platform reply APIs, Feishu reactions, and QQ gateway reconnects.

They should not grow generic agent-flow behavior when the behavior can be shared.

### Core Message Pipeline

- `src/core/NormalizedMessage.ts`
- `src/core/MessageBatcher.ts`
- `src/core/ConversationQueue.ts`
- `src/core/CommandRedaction.ts`
- `src/core/CommandRouter.ts`
- `src/core/CommandRenderers.ts`
- `src/core/IncomingMessagePipeline.ts`
- `src/core/Doctor.ts`
- `src/core/QueueSnapshot.ts`
- `src/core/ReplyFormatter.ts`
- `src/core/ReplyAdapter.ts`
- `src/core/TurnId.ts`

This layer is platform-neutral. It is the beginning of a shared pipeline inspired by messaging-adapter architectures:

- `NormalizedMessage` is the common shape for future Feishu/QQ/other-platform inputs.
- `MessageBatcher` merges adjacent ordinary messages before a prompt is created.
- `ConversationQueue` serializes ordinary work inside one chat/conversation.
- `CommandRedaction` redacts sensitive command args before they are shown in chat replies or routine logs.
- `CommandRouter` parses slash commands once and lets adapters register platform-specific command handlers.
- `IncomingMessagePipeline` coordinates batching, queueing, and batch error handling for ordinary platform messages.
- `Doctor` runs platform-neutral configuration, state, agent, and chat diagnostics that adapters can expose through commands.
- `CommandRenderers` formats shared command output such as `/help`, `/agent`, `/status`, and `/queue`.
- `QueueSnapshot` is the shared queue metadata shape used by conversation queues and per-provider agent queues.
- `ReplyFormatter` normalizes agent/command/error replies once, preserving Markdown for rich platforms while producing cleaner plain text for QQ-style channels.
- `ReplyAdapter` delivers formatted replies through platform send primitives, including markdown-to-text fallback for rich platforms.
- `TurnId` gives each ordinary agent prompt a short searchable identifier that is shown in `/status`, `/queue`, `/doctor chat`, logs, and prompt errors.

### Agent Gateway

- `src/acp/AgentManager.ts`
- `src/acp/AcpAgentClient.ts`

`AgentManager` owns provider selection, chat cwd, ACP session lifecycle, persisted session resume, and per-provider prompt queues. A provider queue prevents two chats from concurrently prompting the same ACP process.

`AcpAgentClient` owns one ACP provider process and handles ACP protocol initialization, prompt calls, session resume/load, session updates, permission requests, cwd-bound file access, cancellation, and timeout handling. Permission requests use the configured `ACP_PERMISSION_MODE` policy instead of a hard-coded approval choice. In `ask_in_chat` mode, permission requests are delegated through the active prompt's permission handler so the Feishu/QQ adapter can ask the current chat to approve or deny the ACP option.

### State

- `src/state/StateStore.ts`

Persisted state includes per-chat provider/cwd, per-chat/provider ACP session IDs, project aliases, group bindings, and processed message IDs for event dedupe. When a chat/provider/cwd has a saved session and the agent supports `session/resume` or `session/load`, the next prompt resumes it; cwd changes and `/reset` clear saved sessions.

The state file also stores lightweight runtime snapshots for diagnostics: active turns, pending permission requests, pending message-batch counts, and conversation queue summaries. These snapshots are intentionally not replayed after restart because queued work is represented by in-memory closures; they are used by `/status` and `/doctor` to explain what was interrupted before the process stopped.

### Rendering

- `src/markdown/larkPost.ts`
- `src/feishu/larkCard.ts`
- `src/core/ReplyFormatter.ts`
- `src/core/ReplyAdapter.ts`
- QQ text splitting in `src/qq/qqMessages.ts`

Platform renderers convert agent Markdown into platform-specific message formats. Feishu uses `post` or interactive cards through `ReplyAdapter`; QQ receives a plain-text rendering and then sends text chunks.

## Design Direction

The current code deliberately favors working platform adapters with shared core primitives. The desired next shape is:

```text
PlatformAdapter
  -> NormalizedMessage
  -> IncomingMessagePipeline
  -> CommandRouter
  -> AgentGateway
  -> ReplyFormatter
  -> ReplyAdapter
```

This keeps platform SDK details at the edges while preserving the project-specific ACP features: cwd binding, provider switching, message dedupe, media prompts, and long-running coding-agent sessions.

## Observability

Every ordinary agent prompt gets a `turnId`. Platform adapters store it on the current active turn; `AgentManager` and `AcpAgentClient` propagate it through prompt logs and `AgentPromptError` details. This gives one handle to correlate:

- `/status` active task output
- `/doctor chat` diagnostics
- `prompting acp agent`, `acp prompt started`, and `acp prompt finished` logs
- timeout and failure replies sent back to chat

Timeout failures include whether the bridge attempted to cancel the ACP session, whether that cancellation succeeded, and the recent stderr tail from the agent process. Platform adapters retain the most recent unsuppressed failure in memory so `/status` and `/doctor chat` can show the last failed turn.

## Testing

`test/acpE2e.test.ts` starts `test/fixtures/fakeAcpAgent.mjs` as a real stdio ACP process. It covers prompt success, persisted session resume, prompt timeout, automatic cancel, stderr capture, and failed-session cleanup.
