# clawd-feishu

Feishu/Lark (飞书) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

[English](#english) | [中文](#中文)

---

## English

### Installation

```bash
openclaw plugins install @m1heng-clawd/feishu
```

Or install via npm:

```bash
npm install @m1heng-clawd/feishu
```

### Configuration

1. Create a self-built app on [Feishu Open Platform](https://open.feishu.cn)
2. Get your App ID and App Secret from the Credentials page
3. Enable required permissions (see below)
4. **Configure event subscriptions** (see below)
5. Configure the plugin:

```bash
openclaw config set channels.feishu.appId "cli_xxxxx"
openclaw config set channels.feishu.appSecret "your_app_secret"
openclaw config set channels.feishu.enabled true
```

#### Required Permissions

| Permission | Scope | Description |
|------------|-------|-------------|
| `contact:user.base:readonly` | User info | Get user display names for speaker attribution |
| `im:message` | Messaging | Send and receive messages |
| `im:message.p2p_msg:readonly` | DM | Read direct messages to bot |
| `im:message.group_at_msg:readonly` | Group | Receive @mention messages in groups |
| `im:message:send_as_bot` | Send | Send messages as the bot |
| `im:resource` | Media | Upload and download images/files/videos |

#### Optional Permissions

| Permission | Scope | Description |
|------------|-------|-------------|
| `im:message.group_msg` | Group | Read all group messages (sensitive) |
| `im:message:readonly` | Read | Get message history |
| `im:message:update` | Edit | Update/edit sent messages |
| `im:message:recall` | Recall | Recall sent messages |

#### Event Subscriptions

> **This is commonly missed!** If the bot can send but not receive messages, check this section.

In the Feishu console, go to **Events & Callbacks**:

1. **Event configuration**: Select **Long connection** (recommended)
2. **Add events**:

| Event | Description |
|-------|-------------|
| `im.message.receive_v1` | Receive messages (required) |
| `im.message.message_read_v1` | Message read receipts |
| `im.chat.member.bot.added_v1` | Bot added to group |
| `im.chat.member.bot.deleted_v1` | Bot removed from group |

### Configuration Options

```yaml
channels:
  feishu:
    enabled: true
    appId: "cli_xxxxx"
    appSecret: "secret"
    # Domain: "feishu" (China) or "lark" (International)
    domain: "feishu"
    # Connection mode: "websocket" (recommended) or "webhook"
    connectionMode: "websocket"
    # DM policy: "pairing" | "open" | "allowlist"
    dmPolicy: "pairing"
    # Group policy: "open" | "allowlist" | "disabled"
    groupPolicy: "allowlist"
    # Require @mention in groups
    requireMention: true
    # Max media size in MB (default: 30)
    mediaMaxMb: 30
    # Render mode: "auto" | "raw" | "card"
    renderMode: "auto"
```

#### Render Mode

| Mode | Description |
|------|-------------|
| `auto` | (Default) Card for code blocks/tables, plain text otherwise |
| `raw` | Always plain text, tables converted to ASCII |
| `card` | Always interactive card with syntax highlighting |

### Features

#### Messaging
- WebSocket and Webhook connection modes
- Direct messages and group chats
- Message replies with quoted context
- Chat history request detection (e.g., "获取聊天记录", "chat history")
- Sender name resolution for speaker attribution

#### Media Support

**Inbound (AI can process):**
- Images (pure image messages)
- Videos (mp4, etc.)
- Audio files
- Documents (PDF, Excel, etc.)
- Stickers
- Rich text (post) with embedded images

**Outbound (bot can send):**
- Images (JPEG, PNG, GIF, WebP, etc.)
- Videos (mp4) - uses correct `msg_type="media"`
- Audio (opus) - uses correct `msg_type="audio"`
- Files (PDF, DOC, XLS, PPT, etc.)

#### Rendering
- Streaming updates with 400ms throttle (Feishu rate limit safe)
- Interactive cards with markdown rendering
- Syntax highlighting for code blocks
- Wide screen mode for better readability

#### Access Control
- DM pairing flow for approval
- Group allowlist by chat ID
- Per-group configuration (tools, skills, system prompt)
- Typing indicator via emoji reactions

### FAQ

#### Bot cannot receive messages

1. Check **event subscriptions** configuration
2. Ensure **long connection** mode is selected
3. Verify `im.message.receive_v1` event is added
4. Confirm permissions are approved

#### 403 error when sending

Ensure `im:message:send_as_bot` permission is approved.

#### Video sends as file (error 230055)

This plugin correctly uses `msg_type="media"` for videos and `msg_type="audio"` for audio files. If you see this error, ensure you're using the latest version.

#### How to start new conversation

Send `/new` command in chat.

#### Why not real-time streaming

Feishu API has strict rate limits (5 QPS). We use throttled card updates (400ms interval) for stability.

---

## 中文

### 安装

```bash
openclaw plugins install @m1heng-clawd/feishu
```

或通过 npm 安装：

```bash
npm install @m1heng-clawd/feishu
```

### 配置

1. 在 [飞书开放平台](https://open.feishu.cn) 创建自建应用
2. 获取 App ID 和 App Secret
3. 开启所需权限（见下方）
4. **配置事件订阅**（见下方）
5. 配置插件：

```bash
openclaw config set channels.feishu.appId "cli_xxxxx"
openclaw config set channels.feishu.appSecret "your_app_secret"
openclaw config set channels.feishu.enabled true
```

#### 必需权限

| 权限 | 范围 | 说明 |
|------|------|------|
| `contact:user.base:readonly` | 用户信息 | 获取用户显示名称，用于区分发言者 |
| `im:message` | 消息 | 发送和接收消息 |
| `im:message.p2p_msg:readonly` | 私聊 | 读取私聊消息 |
| `im:message.group_at_msg:readonly` | 群聊 | 接收群内 @机器人 的消息 |
| `im:message:send_as_bot` | 发送 | 以机器人身份发送消息 |
| `im:resource` | 媒体 | 上传和下载图片/文件/视频 |

#### 可选权限

| 权限 | 范围 | 说明 |
|------|------|------|
| `im:message.group_msg` | 群聊 | 读取所有群消息（敏感） |
| `im:message:readonly` | 读取 | 获取历史消息 |
| `im:message:update` | 编辑 | 更新已发送消息 |
| `im:message:recall` | 撤回 | 撤回已发送消息 |

#### 事件订阅

> **常见遗漏配置！** 机器人能发消息但收不到，请检查此项。

在飞书应用后台，进入 **事件与回调**：

1. **事件配置方式**：选择 **长连接**（推荐）
2. **添加事件**：

| 事件 | 说明 |
|------|------|
| `im.message.receive_v1` | 接收消息（必需） |
| `im.message.message_read_v1` | 消息已读回执 |
| `im.chat.member.bot.added_v1` | 机器人进群 |
| `im.chat.member.bot.deleted_v1` | 机器人被移出群 |

### 配置选项

```yaml
channels:
  feishu:
    enabled: true
    appId: "cli_xxxxx"
    appSecret: "secret"
    # 域名: "feishu" (国内) 或 "lark" (国际)
    domain: "feishu"
    # 连接模式: "websocket" (推荐) 或 "webhook"
    connectionMode: "websocket"
    # 私聊策略: "pairing" | "open" | "allowlist"
    dmPolicy: "pairing"
    # 群聊策略: "open" | "allowlist" | "disabled"
    groupPolicy: "allowlist"
    # 群聊是否需要 @机器人
    requireMention: true
    # 媒体文件最大大小 (MB, 默认 30)
    mediaMaxMb: 30
    # 渲染模式: "auto" | "raw" | "card"
    renderMode: "auto"
```

#### 渲染模式

| 模式 | 说明 |
|------|------|
| `auto` | （默认）有代码块/表格时用卡片，否则纯文本 |
| `raw` | 始终纯文本，表格转 ASCII |
| `card` | 始终用卡片，支持语法高亮 |

### 功能

#### 消息
- WebSocket 和 Webhook 连接模式
- 私聊和群聊
- 消息回复和引用上下文
- 聊天记录请求检测（如"获取聊天记录"、"chat history"）
- 发送者名称解析，区分群聊中的不同说话者

#### 媒体支持

**入站（AI 可处理）：**
- 图片（纯图片消息）
- 视频（mp4 等）
- 音频文件
- 文档（PDF、Excel 等）
- 表情包
- 富文本（post）及嵌入图片

**出站（机器人可发送）：**
- 图片（JPEG、PNG、GIF、WebP 等）
- 视频（mp4）- 使用正确的 `msg_type="media"`
- 音频（opus）- 使用正确的 `msg_type="audio"`
- 文件（PDF、DOC、XLS、PPT 等）

#### 渲染
- 流式更新，400ms 节流（符合飞书限频）
- 交互式卡片，支持 Markdown 渲染
- 代码块语法高亮
- 宽屏模式，阅读体验更佳

#### 访问控制
- 私聊配对审批流程
- 群聊 ID 白名单
- 按群配置（工具、技能、系统提示词）
- 输入指示器（通过表情实现）

### 常见问题

#### 机器人收不到消息

1. 检查 **事件订阅** 配置
2. 确保选择了 **长连接** 模式
3. 确认添加了 `im.message.receive_v1` 事件
4. 确认权限已审核通过

#### 发送消息 403 错误

确保 `im:message:send_as_bot` 权限已审核通过。

#### 视频发送变成文件（错误 230055）

本插件已正确使用 `msg_type="media"` 发送视频、`msg_type="audio"` 发送音频。如遇此错误，请更新到最新版本。

#### 如何开启新对话

发送 `/new` 命令。

#### 为什么不是实时流式输出

飞书 API 有严格限频（5 QPS）。我们使用 400ms 间隔的卡片更新，确保稳定性。

---

## License

MIT
