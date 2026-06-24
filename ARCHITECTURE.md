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
- `src/core/CommandRouter.ts`

This layer is platform-neutral. It is the beginning of a shared pipeline inspired by messaging-adapter architectures:

- `NormalizedMessage` is the common shape for future Feishu/QQ/other-platform inputs.
- `MessageBatcher` merges adjacent ordinary messages before a prompt is created.
- `ConversationQueue` serializes ordinary work inside one chat/conversation.
- `CommandRouter` parses slash commands once and lets adapters register platform-specific command handlers.

The next good extraction is a shared `IncomingMessagePipeline` plus a `ReplyAdapter`, so Feishu and QQ only provide platform-specific ingress, media download, and send primitives.

### Agent Gateway

- `src/acp/AgentManager.ts`
- `src/acp/AcpAgentClient.ts`

`AgentManager` owns provider selection, chat cwd, ACP session lifecycle, and per-provider prompt queues. A provider queue prevents two chats from concurrently prompting the same ACP process.

`AcpAgentClient` owns one ACP provider process and handles ACP protocol initialization, prompt calls, session updates, permission requests, cwd-bound file access, cancellation, and timeout handling.

### State

- `src/state/StateStore.ts`

Persisted state includes per-chat provider/cwd, project aliases, group bindings, and processed message IDs for event dedupe. ACP session IDs are currently in-memory and are not restored after service restart.

### Rendering

- `src/markdown/larkPost.ts`
- `src/feishu/larkCard.ts`
- QQ text splitting in `src/qq/qqMessages.ts`

Platform renderers convert agent Markdown into platform-specific message formats. Feishu uses `post` or interactive cards; QQ currently sends text chunks.

## Design Direction

The current code deliberately favors working platform adapters with shared core primitives. The desired next shape is:

```text
PlatformAdapter
  -> NormalizedMessage
  -> IncomingMessagePipeline
  -> CommandRouter
  -> AgentGateway
  -> ReplyAdapter
```

This keeps platform SDK details at the edges while preserving the project-specific ACP features: cwd binding, provider switching, message dedupe, media prompts, and long-running coding-agent sessions.
