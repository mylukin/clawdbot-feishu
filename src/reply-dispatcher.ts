import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendMarkdownCardFeishu, sendCardFeishu, updateCardFeishu, createSimpleTextCard } from "./send.js";
import type { FeishuConfig } from "./types.js";
import {
  addTypingIndicator,
  removeTypingIndicator,
  type TypingIndicatorState,
} from "./typing.js";

/**
 * Detect if text contains markdown elements that benefit from card rendering.
 * Used by auto render mode.
 */
function shouldUseCard(text: string): boolean {
  // Code blocks (fenced)
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables (at least header + separator row with |)
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

// Feishu rate limits are strict (5 QPS), so we throttle updates.
// We target ~2-3 updates per second to be safe and smooth.
const STREAM_UPDATE_INTERVAL_MS = 400;
const DELIVERED_KEYS_MAX = 100;

class FeishuStream {
  private messageIds: string[] = [];
  private segments: string[] = [];
  private finalizedLength = 0;
  private lastContent = "";
  private lastUpdateTime = 0;
  private pendingUpdate: NodeJS.Timeout | null = null;
  private pendingContent: string | null = null;
  private isFinalized = false;
  private updateChain: Promise<void> = Promise.resolve();

  constructor(
    private ctx: {
      cfg: ClawdbotConfig;
      chatId: string;
      replyToMessageId?: string;
      runtime: RuntimeEnv;
    },
    private opts: {
      textChunkLimit: number;
      chunkMode: "length" | "newline";
    },
  ) {}

  async update(content: string, isFinal = false): Promise<void> {
    if (this.isFinalized) return;
    if (content === this.lastContent && !isFinal) return;

    if (isFinal) {
      this.clearPending();
      await this.enqueueUpdate(() => this.applyUpdate(content, true));
      return;
    }

    if (!this.messageIds.length) {
      await this.enqueueUpdate(() => this.applyUpdate(content, false));
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - this.lastUpdateTime;

    if (timeSinceLast >= STREAM_UPDATE_INTERVAL_MS) {
      this.clearPending();
      await this.enqueueUpdate(() => this.applyUpdate(content, false));
      return;
    }

    this.pendingContent = content;
    if (!this.pendingUpdate) {
      this.pendingUpdate = setTimeout(() => {
        this.pendingUpdate = null;
        const nextContent = this.pendingContent;
        this.pendingContent = null;
        if (!nextContent || nextContent === this.lastContent) return;
        void this.enqueueUpdate(() => this.applyUpdate(nextContent, false));
      }, STREAM_UPDATE_INTERVAL_MS - timeSinceLast);
    }
  }

  async finalize(content: string): Promise<void> {
    if (this.isFinalized) return;

    this.clearPending();

    const finalContent = content || this.pendingContent || this.lastContent || "";
    this.pendingContent = null;

    if (!finalContent) return;
    await this.enqueueUpdate(() => this.applyUpdate(finalContent, true));
  }

  getMessageId(): string | null {
    if (!this.messageIds.length) return null;
    return this.messageIds[this.messageIds.length - 1] ?? null;
  }

  private clearPending() {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }
    this.pendingContent = null;
  }

  private enqueueUpdate(task: () => Promise<void>): Promise<void> {
    this.updateChain = this.updateChain
      .then(task)
      .catch((err) => {
        this.ctx.runtime.log?.(`feishu stream update failed: ${String(err)}`);
      });
    return this.updateChain;
  }

  private async applyUpdate(content: string, isFinal: boolean): Promise<void> {
    if (this.isFinalized) return;
    if (!content && !isFinal) return;

    if (this.segments.length && !this.isContinuation(this.lastContent, content)) {
      await this.finalizeActiveMessage();
      this.resetState();
    }

    let nextSegments = this.buildSegments(content);
    if (nextSegments === null) {
      await this.finalizeActiveMessage();
      this.resetState();
      nextSegments = this.buildSegments(content);
      if (nextSegments === null) {
        this.ctx.runtime.error?.("feishu stream: unexpected null segments after reset");
        return;
      }
    }
    if (!nextSegments.length) return;

    await this.syncSegments(nextSegments, isFinal);
    this.segments = nextSegments;
    this.finalizedLength = this.computeFinalizedLength(nextSegments);
    this.lastContent = content;

    if (isFinal) {
      this.isFinalized = true;
      this.ctx.runtime.log?.(`feishu stream: finalized with ${content.length} chars`);
    }
  }

  private resetState() {
    this.messageIds = [];
    this.segments = [];
    this.finalizedLength = 0;
    this.lastContent = "";
    this.lastUpdateTime = 0;
  }

  private isContinuation(prev: string, next: string): boolean {
    if (!prev) return true;
    if (next.startsWith(prev)) return true;
    if (prev.startsWith(next)) return true;
    if (prev.length >= 16) {
      if (prev.length > next.length * 0.3) {
        const idx = next.indexOf(prev);
        if (idx >= 0 && idx <= 32) return true;
      }
    }
    return false;
  }

  private computeFinalizedLength(segments: string[]): number {
    if (segments.length <= 1) return 0;
    let total = 0;
    for (let i = 0; i < segments.length - 1; i++) {
      total += segments[i]?.length ?? 0;
    }
    return total;
  }

  private buildSegments(content: string): string[] | null {
    if (!content) return [];
    if (!this.segments.length) {
      return this.splitStreamingText(content, 0);
    }

    const baseLength = this.finalizedLength;
    const remaining = content.slice(baseLength);
    const currentSegment = this.segments[this.segments.length - 1] ?? "";

    if (currentSegment && !remaining.startsWith(currentSegment)) {
      return null;
    }

    const chunks = this.splitStreamingText(remaining, currentSegment.length);
    return [...this.segments.slice(0, -1), ...chunks];
  }

  private splitStreamingText(text: string, minFirstChunk: number): string[] {
    const limit = this.opts.textChunkLimit;
    if (!text) return [];
    if (limit <= 0 || text.length <= limit) {
      return this.normalizeChunks([text], limit);
    }

    const chunks: string[] = [];
    let remaining = text;
    let min = Math.min(Math.max(minFirstChunk, 0), limit);
    let first = true;

    while (remaining.length > limit) {
      const breakIdx = this.pickBreakIndex(remaining, limit, first ? min : 0);
      const idx = Math.max(1, Math.min(breakIdx, remaining.length));
      const chunk = remaining.slice(0, idx);
      chunks.push(chunk);
      remaining = remaining.slice(idx);
      first = false;
      min = 0;
    }

    if (remaining.length) {
      chunks.push(remaining);
    }
    return this.normalizeChunks(chunks, limit);
  }

  private normalizeChunks(chunks: string[], limit: number): string[] {
    if (!chunks.length) return chunks;
    const out: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? "";
      if (!chunk) continue;
      if (!chunk.trim()) {
        if (out.length && (limit <= 0 || out[out.length - 1].length + chunk.length <= limit)) {
          out[out.length - 1] += chunk;
          continue;
        }
        const next = chunks[i + 1];
        if (next && (limit <= 0 || next.length + chunk.length <= limit)) {
          chunks[i + 1] = chunk + next;
          continue;
        }
        continue;
      }
      out.push(chunk);
    }
    return out;
  }

  private pickBreakIndex(text: string, limit: number, minIndex: number): number {
    const boundedMin = Math.min(Math.max(minIndex, 0), limit);
    const window = text.slice(0, limit);

    if (this.opts.chunkMode === "newline") {
      const paragraphRe = /\n[\t ]*\n+/g;
      let match: RegExpExecArray | null;
      let lastBreak = -1;
      while ((match = paragraphRe.exec(window))) {
        const idx = match.index + match[0].length;
        if (idx >= boundedMin) {
          lastBreak = idx;
        }
      }
      if (lastBreak >= boundedMin) {
        return lastBreak;
      }
    }

    for (let i = window.length - 1; i >= boundedMin; i--) {
      if (/\s/.test(window[i] ?? "")) {
        return i + 1;
      }
    }

    return Math.max(boundedMin, Math.min(limit, window.length));
  }

  private async syncSegments(nextSegments: string[], isFinal: boolean): Promise<void> {
    const prevCount = this.messageIds.length;
    const nextCount = nextSegments.length;

    if (prevCount === 0) {
      await this.sendInitialSegments(nextSegments, isFinal);
      return;
    }

    if (nextCount < prevCount) {
      await this.finalizeActiveMessage();
      this.resetState();
      await this.sendInitialSegments(nextSegments, isFinal);
      return;
    }

    if (nextCount > prevCount) {
      await this.updateExistingSegment(prevCount - 1, nextSegments[prevCount - 1] ?? "", false);
      for (let i = prevCount; i < nextCount; i++) {
        const streaming = !isFinal && i === nextCount - 1;
        const id = await this.sendSegment(nextSegments[i] ?? "", streaming);
        if (id) {
          this.messageIds.push(id);
          if (streaming) {
            this.lastUpdateTime = Date.now();
          }
        }
      }
      return;
    }

    const streaming = !isFinal;
    await this.updateExistingSegment(prevCount - 1, nextSegments[nextCount - 1] ?? "", streaming);
    if (streaming) {
      this.lastUpdateTime = Date.now();
    }
  }

  private async sendInitialSegments(segments: string[], isFinal: boolean): Promise<void> {
    for (let i = 0; i < segments.length; i++) {
      const streaming = !isFinal && i === segments.length - 1;
      const id = await this.sendSegment(segments[i] ?? "", streaming);
      if (!id) {
        return;
      }
      this.messageIds.push(id);
      if (streaming) {
        this.lastUpdateTime = Date.now();
      }
    }
  }

  private async sendSegment(content: string, streaming: boolean): Promise<string | null> {
    if (!content.trim()) {
      return null;
    }
    try {
      const card = createSimpleTextCard(content, streaming);
      const result = await sendCardFeishu({
        cfg: this.ctx.cfg,
        to: this.ctx.chatId,
        card,
        replyToMessageId: this.ctx.replyToMessageId,
      });
      return result.messageId;
    } catch (err) {
      this.ctx.runtime.error?.(`feishu stream card create failed: ${String(err)}`);
      return null;
    }
  }

  private async updateExistingSegment(
    index: number,
    content: string,
    streaming: boolean,
  ): Promise<void> {
    const messageId = this.messageIds[index];
    if (!messageId) return;
    try {
      const card = createSimpleTextCard(content, streaming);
      await updateCardFeishu({
        cfg: this.ctx.cfg,
        messageId,
        card,
      });
    } catch (err) {
      this.ctx.runtime.log?.(`feishu stream update failed: ${String(err)}`);
    }
  }

  private async finalizeActiveMessage(): Promise<void> {
    if (!this.messageIds.length || !this.segments.length) return;
    const index = this.messageIds.length - 1;
    const content = this.segments[this.segments.length - 1] ?? "";
    await this.updateExistingSegment(index, content, false);
  }
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId } = params;

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  // Feishu doesn't have a native typing indicator API.
  // We use message reactions as a typing indicator substitute.
  let typingState: TypingIndicatorState | null = null;

  // Track active stream for the current block
  let currentStream: FeishuStream | null = null;
  // Prevent duplicate delivery of identical payloads
  const deliveredKeys = new Set<string>();

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // If we are streaming, we don't need typing indicator as text appears
      if (currentStream?.getMessageId()) return;

      if (!replyToMessageId) return;
      // Skip if already showing typing indicator (avoid repeated API calls)
      if (typingState) return;
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId });
      params.runtime.log?.(`feishu: added typing indicator reaction`);
    },
    stop: async () => {
      if (!typingState) return;
      await removeTypingIndicator({ cfg, state: typingState });
      typingState = null;
      params.runtime.log?.(`feishu: removed typing indicator reaction`);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      });
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit({
    cfg,
    channel: "feishu",
    defaultLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        params.runtime.log?.(`feishu deliver called: text=${payload.text?.slice(0, 100)}`);
        const text = payload.text ?? "";
        if (!text.trim()) {
          return;
        }

        // If we have an active stream, finalize it with the content
        if (currentStream) {
          await currentStream.finalize(text);
          currentStream = null;
          return;
        }

        // Prevent duplicate delivery of identical payloads
        if (deliveredKeys.has(text)) {
          params.runtime.log?.(`feishu deliver: duplicate payload, skipping`);
          return;
        }
        if (deliveredKeys.size >= DELIVERED_KEYS_MAX) {
          const oldest = deliveredKeys.values().next().value as string | undefined;
          if (oldest) deliveredKeys.delete(oldest);
        }
        deliveredKeys.add(text);

        // Check render mode: auto (default), raw, or card
        const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
        const renderMode = feishuCfg?.renderMode ?? "auto";

        // Determine if we should use card for this message
        const useCard =
          renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        if (useCard) {
          // Card mode: send as interactive card with markdown rendering
          const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
          params.runtime.log?.(`feishu deliver: sending ${chunks.length} card chunks to ${chatId}`);
          for (const chunk of chunks) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
            });
          }
        } else {
          // Raw mode: send as plain text with table conversion
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
          params.runtime.log?.(`feishu deliver: sending ${chunks.length} text chunks to ${chatId}`);
          for (const chunk of chunks) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
            });
          }
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(`feishu ${info.kind} reply failed: ${String(err)}`);
        typingCallbacks.onIdle?.();
      },
      onIdle: typingCallbacks.onIdle,
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onPartialReply: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (!text) return;

        if (!currentStream) {
          currentStream = new FeishuStream(
            {
              cfg,
              chatId,
              replyToMessageId,
              runtime: params.runtime,
            },
            {
              textChunkLimit,
              chunkMode,
            },
          );
          // Stop typing indicator if we start streaming text
          if (typingState) {
            await typingCallbacks.onIdle?.();
          }
        }

        // Pass raw text to allow Feishu to render markdown (lark_md)
        await currentStream.update(text);
      },
    },
    markDispatchIdle,
  };
}
