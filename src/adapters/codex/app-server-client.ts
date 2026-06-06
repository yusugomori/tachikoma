import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";

export interface CodexJsonRpcTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): Promise<void> | void;
  waitForNotification?(
    predicate: CodexNotificationPredicate,
    timeoutMs: number
  ): Promise<CodexAppServerNotification>;
  close?(): Promise<void> | void;
}

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export type CodexNotificationPredicate = (notification: CodexAppServerNotification) => boolean;

export interface StdioCodexAppServerTransportOptions {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
}

export interface WebSocketCodexAppServerTransportOptions {
  url: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  webSocket?: WebSocketConstructor;
}

export interface CodexThreadSummary {
  id: string;
  cwd?: string;
  status?: string;
  source?: string;
}

export type CodexProbeThreadOrigin = "existing" | "started";

export interface CodexManagedThread {
  thread: CodexThreadSummary;
  threadOrigin: CodexProbeThreadOrigin;
  fallbackReason?: string;
}

export interface CodexManagedThreadOptions {
  preferLoadedThread?: boolean;
}

export interface CodexThreadMessage {
  id?: string;
  turnId?: string;
  role: "assistant" | "user" | "system" | "tool";
  text: string;
}

export interface CodexThreadTurn {
  id: string;
  status?: string;
}

export interface CodexThreadRead {
  raw: unknown;
  messages: CodexThreadMessage[];
  turns: CodexThreadTurn[];
}

export interface CodexAppServerProbeInput {
  cwd: string;
  message: string;
  threadId?: string;
  forceNewThread?: boolean;
  waitForCompletionMs?: number;
}

export interface CodexAppServerProbeResult {
  status: "accepted" | "rejected";
  cwd: string;
  threadsSeen: number;
  threadId?: string;
  threadOrigin?: CodexProbeThreadOrigin;
  turnId?: string;
  turnStatus?: string;
  reason?: string;
  fallbackReason?: string;
  completionStatus?: string;
  completionWarning?: string;
  readWarning?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingNotification {
  predicate: CodexNotificationPredicate;
  resolve: (value: CodexAppServerNotification) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type WebSocketConstructor = new (url: string) => RuntimeWebSocket;

interface RuntimeWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: RuntimeWebSocketEvent) => void,
    options?: { once?: boolean }
  ): void;
}

interface RuntimeWebSocketEvent {
  data?: unknown;
  error?: unknown;
  message?: unknown;
  reason?: unknown;
  code?: unknown;
}

export class CodexAppServerUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexAppServerUnavailableError";
  }
}

export class CodexAppServerRpcError extends Error {
  public constructor(
    message: string,
    public readonly code?: number | string
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

export class StdioCodexAppServerTransport implements CodexJsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Set<PendingNotification>();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private stderr = "";
  private closedError: Error | undefined;

  public constructor(options: StdioCodexAppServerTransportOptions = {}) {
    const command = options.command ?? "codex";
    const args = options.args ?? ["app-server", "proxy"];

    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.lines = createInterface({
      input: this.child.stdout
    });

    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    });
    this.child.stdin.on("error", (error) => {
      this.failAll(new CodexAppServerUnavailableError(error.message));
    });
    this.child.on("error", (error) => {
      this.failAll(new CodexAppServerUnavailableError(error.message));
    });
    this.child.on("exit", (code, signal) => {
      this.failAll(
        new CodexAppServerUnavailableError(
          `codex app-server proxy exited before responding (${formatExit(code, signal)}): ${this.stderr.trim()}`
        )
      );
    });
  }

  public request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerUnavailableError(`${method} timed out.${this.formatStderr()}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer
      });

      this.writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {}
      });
    });
  }

  public notify(method: string, params?: unknown): void {
    if (this.closedError) {
      return;
    }

    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params: params ?? {}
    });
  }

  public waitForNotification(
    predicate: CodexNotificationPredicate,
    timeoutMs: number
  ): Promise<CodexAppServerNotification> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }

    return new Promise((resolve, reject) => {
      const waiter: PendingNotification = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(
            new CodexAppServerUnavailableError(`notification wait timed out.${this.formatStderr()}`)
          );
        }, timeoutMs)
      };

      this.notificationWaiters.add(waiter);
    });
  }

  public close(): void {
    this.lines.close();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private writeMessage(message: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.failAll(
        new CodexAppServerUnavailableError(error instanceof Error ? error.message : String(error))
      );
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const record = asRecord(message);
    const id = typeof record?.id === "number" ? record.id : undefined;

    if (id === undefined) {
      if (typeof record?.method === "string") {
        this.handleNotification({
          method: record.method,
          params: record.params
        });
      }
      return;
    }

    const pending = this.pending.get(id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    const error = asRecord(record?.error);
    if (error) {
      pending.reject(
        new CodexAppServerRpcError(
          typeof error.message === "string" ? error.message : "Codex app-server request failed.",
          typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined
        )
      );
      return;
    }

    pending.resolve(record?.result);
  }

  private failAll(error: Error): void {
    if (!this.closedError) {
      this.closedError = error;
    }

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }

    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.notificationWaiters.delete(waiter);
    }
  }

  private formatStderr(): string {
    const stderr = this.stderr.trim();
    return stderr ? ` stderr: ${stderr}` : "";
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    for (const waiter of this.notificationWaiters) {
      if (!waiter.predicate(notification)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(notification);
      return;
    }
  }
}

export class WebSocketCodexAppServerTransport implements CodexJsonRpcTransport {
  private readonly socket: RuntimeWebSocket;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Set<PendingNotification>();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private closedError: Error | undefined;

  public constructor(options: WebSocketCodexAppServerTransportOptions) {
    const WebSocketRuntime =
      options.webSocket ??
      (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket;

    if (!WebSocketRuntime) {
      throw new CodexAppServerUnavailableError(
        "Node.js WebSocket runtime is unavailable. Tachikoma Codex runtime requires Node 22+."
      );
    }

    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    this.socket = new WebSocketRuntime(options.url);
    this.ready = this.waitForOpen(options.connectTimeoutMs ?? 10000, options.url);

    this.socket.addEventListener("message", (event) => {
      this.handleData(event.data);
    });
    this.socket.addEventListener("error", (event) => {
      this.failAll(new CodexAppServerUnavailableError(formatWebSocketError(event)));
    });
    this.socket.addEventListener("close", (event) => {
      this.failAll(
        new CodexAppServerUnavailableError(
          `Codex app-server WebSocket closed: ${formatClose(event)}`
        )
      );
    });
  }

  public async request(method: string, params?: unknown): Promise<unknown> {
    await this.ready;

    if (this.closedError) {
      return Promise.reject(this.closedError);
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerUnavailableError(`${method} timed out.`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer
      });

      this.writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {}
      });
    });
  }

  public async notify(method: string, params?: unknown): Promise<void> {
    await this.ready;

    if (this.closedError) {
      return;
    }

    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params: params ?? {}
    });
  }

  public waitForNotification(
    predicate: CodexNotificationPredicate,
    timeoutMs: number
  ): Promise<CodexAppServerNotification> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }

    return new Promise((resolve, reject) => {
      const waiter: PendingNotification = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new CodexAppServerUnavailableError("notification wait timed out."));
        }, timeoutMs)
      };

      this.notificationWaiters.add(waiter);
    });
  }

  public close(): void {
    this.failAll(
      new CodexAppServerUnavailableError("Codex app-server WebSocket transport closed.")
    );

    try {
      this.socket.close();
    } catch {
      // Best-effort close only.
    }
  }

  private waitForOpen(timeoutMs: number, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        if (error) {
          this.failAll(error);
          reject(error);
          return;
        }

        resolve();
      };
      const timer = setTimeout(() => {
        settle(new CodexAppServerUnavailableError(`Timed out connecting to ${url}.`));
      }, timeoutMs);

      this.socket.addEventListener(
        "open",
        () => {
          settle();
        },
        { once: true }
      );
      this.socket.addEventListener(
        "error",
        (event) => {
          settle(new CodexAppServerUnavailableError(formatWebSocketError(event)));
        },
        { once: true }
      );
    });
  }

  private writeMessage(message: unknown): void {
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.failAll(
        new CodexAppServerUnavailableError(error instanceof Error ? error.message : String(error))
      );
    }
  }

  private handleData(data: unknown): void {
    const text = messageDataToString(data);

    if (!text) {
      return;
    }

    for (const line of text.split(/\r?\n/)) {
      this.handleMessageText(line);
    }
  }

  private handleMessageText(text: string): void {
    if (text.trim().length === 0) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    const record = asRecord(message);
    const id = typeof record?.id === "number" ? record.id : undefined;

    if (id === undefined) {
      if (typeof record?.method === "string") {
        this.handleNotification({
          method: record.method,
          params: record.params
        });
      }
      return;
    }

    const pending = this.pending.get(id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    const error = asRecord(record?.error);
    if (error) {
      pending.reject(
        new CodexAppServerRpcError(
          typeof error.message === "string" ? error.message : "Codex app-server request failed.",
          typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined
        )
      );
      return;
    }

    pending.resolve(record?.result);
  }

  private failAll(error: Error): void {
    if (!this.closedError) {
      this.closedError = error;
    }

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }

    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.notificationWaiters.delete(waiter);
    }
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    for (const waiter of this.notificationWaiters) {
      if (!waiter.predicate(notification)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(notification);
      return;
    }
  }
}

export class CodexAppServerClient {
  public constructor(private readonly transport: CodexJsonRpcTransport) {}

  public async initialize(): Promise<unknown> {
    const response = await this.transport.request("initialize", {
      clientInfo: {
        name: "tachikoma",
        title: "Tachikoma Codex remote-control probe",
        version: "0.2.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["thread/started", "turn/started"]
      }
    });

    await this.transport.notify?.("initialized", {});
    return response;
  }

  public async listThreads(cwd: string): Promise<CodexThreadSummary[]> {
    const response = await this.transport.request("thread/list", {
      archived: false,
      cwd,
      limit: 20,
      sortDirection: "desc",
      sortKey: "updated_at"
    });

    return normalizeThreads(response);
  }

  public async listLoadedThreadIds(): Promise<string[]> {
    const response = await this.transport.request("thread/loaded/list", {
      limit: 100
    });
    const data = asRecord(response)?.data;

    return Array.isArray(data)
      ? data.filter((threadId): threadId is string => typeof threadId === "string")
      : [];
  }

  public async startThread(cwd: string): Promise<CodexThreadSummary> {
    const response = await this.transport.request("thread/start", {
      cwd,
      sessionStartSource: "startup",
      threadSource: "user"
    });
    const thread = normalizeThread(asRecord(response)?.thread ?? response);

    if (!thread) {
      throw new CodexAppServerRpcError("thread/start did not return a thread id.");
    }

    return thread;
  }

  public async startTurn(input: {
    threadId: string;
    cwd: string;
    message: string;
  }): Promise<{ id?: string; status?: string }> {
    const response = await this.transport.request("turn/start", {
      threadId: input.threadId,
      cwd: input.cwd,
      input: [
        {
          type: "text",
          text: input.message
        }
      ],
      additionalContext: {
        tachikoma: {
          kind: "application",
          value:
            "Experimental Tachikoma Codex remote-control probe. Do not mark Tachikoma inbox items delivered unless Codex accepts this turn."
        }
      }
    });
    const turn = asRecord(asRecord(response)?.turn);

    return {
      id: typeof turn?.id === "string" ? turn.id : undefined,
      status: typeof turn?.status === "string" ? turn.status : undefined
    };
  }

  public async readThread(threadId: string): Promise<unknown> {
    return this.transport.request("thread/read", {
      threadId,
      includeTurns: true
    });
  }

  public async readThreadSummary(threadId: string): Promise<CodexThreadSummary | undefined> {
    const response = await this.transport.request("thread/read", {
      threadId
    });

    return normalizeThread(asRecord(response)?.thread);
  }

  public async readThreadNormalized(threadId: string): Promise<CodexThreadRead> {
    return normalizeCodexThreadRead(await this.readThread(threadId));
  }

  public async listTurnItemsNormalized(input: {
    threadId: string;
    turnId: string;
  }): Promise<CodexThreadRead> {
    const response = await this.transport.request("thread/turns/items/list", {
      threadId: input.threadId,
      turnId: input.turnId,
      limit: 100,
      sortDirection: "asc"
    });
    const items = asRecord(response)?.data;

    return normalizeCodexThreadRead({
      turn: {
        id: input.turnId,
        items: Array.isArray(items) ? items : []
      },
      raw: response
    });
  }

  public async ensureManagedThread(
    cwd: string,
    preferredThreadId?: string,
    options: CodexManagedThreadOptions = {}
  ): Promise<CodexManagedThread> {
    if (options.preferLoadedThread) {
      const loadedThread = await this.findLoadedThread(cwd);
      if (loadedThread) {
        return {
          thread: loadedThread,
          threadOrigin: "existing"
        };
      }
    }

    if (preferredThreadId) {
      try {
        await this.readThread(preferredThreadId);

        return {
          thread: {
            id: preferredThreadId,
            cwd
          },
          threadOrigin: "existing"
        };
      } catch (error) {
        const fallbackThread = await this.startThread(cwd);

        return {
          thread: fallbackThread,
          threadOrigin: "started",
          fallbackReason: error instanceof Error ? error.message : String(error)
        };
      }
    }

    return {
      thread: await this.startThread(cwd),
      threadOrigin: "started"
    };
  }

  public async findLoadedThread(cwd: string): Promise<CodexThreadSummary | undefined> {
    let loadedThreadIds: string[];
    try {
      loadedThreadIds = await this.listLoadedThreadIds();
    } catch {
      return undefined;
    }

    if (loadedThreadIds.length === 0) {
      return undefined;
    }

    const loaded = new Set(loadedThreadIds);

    try {
      const listedThread = (await this.listThreads(cwd)).find(
        (thread) => loaded.has(thread.id) && cwdMatches(thread.cwd, cwd)
      );
      if (listedThread) {
        return listedThread;
      }
    } catch {
      // Fall through to reading loaded threads individually.
    }

    for (const threadId of loadedThreadIds) {
      try {
        const thread = await this.readThreadSummary(threadId);
        if (cwdMatches(thread?.cwd, cwd)) {
          return thread;
        }
      } catch {
        // Ignore loaded threads that cannot be read by this client.
      }
    }

    return undefined;
  }

  public async waitForTurnCompleted(input: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
  }): Promise<{ status?: string }> {
    if (!this.transport.waitForNotification) {
      return {};
    }

    const notification = await this.transport.waitForNotification((candidate) => {
      if (candidate.method !== "turn/completed") {
        return false;
      }

      const params = asRecord(candidate.params);
      const turn = asRecord(params?.turn);

      return params?.threadId === input.threadId && turn?.id === input.turnId;
    }, input.timeoutMs);
    const turn = asRecord(asRecord(notification.params)?.turn);

    return {
      status: typeof turn?.status === "string" ? turn.status : undefined
    };
  }

  public async steerTurn(input: { threadId: string; message: string }): Promise<unknown> {
    return this.transport.request("turn/steer", {
      threadId: input.threadId,
      input: [
        {
          type: "text",
          text: input.message
        }
      ]
    });
  }
}

function cwdMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === expected) {
    return true;
  }

  if (!candidate) {
    return false;
  }

  return safeRealpath(candidate) === safeRealpath(expected);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function runCodexAppServerProbe(
  input: CodexAppServerProbeInput,
  client: CodexAppServerClient
): Promise<CodexAppServerProbeResult> {
  await client.initialize();

  const threads = await client.listThreads(input.cwd);
  let thread = selectProbeThread(threads, input);
  let threadOrigin: CodexProbeThreadOrigin = "existing";
  let fallbackReason: string | undefined;

  if (!thread && !input.threadId) {
    thread = await client.startThread(input.cwd);
    threadOrigin = "started";
  }

  if (!thread) {
    return {
      status: "rejected",
      cwd: input.cwd,
      threadsSeen: threads.length,
      reason: input.threadId
        ? `thread ${input.threadId} was not found for ${input.cwd}`
        : `no Codex thread was available for ${input.cwd}`
    };
  }

  const turn = await startProbeTurnWithFallback({
    client,
    cwd: input.cwd,
    message: input.message,
    thread,
    threadOrigin,
    canFallbackToManagedThread:
      threadOrigin === "existing" && !input.threadId && !input.forceNewThread
  });

  thread = turn.thread;
  threadOrigin = turn.threadOrigin;
  fallbackReason = turn.fallbackReason;

  if (!turn.turn.id) {
    return {
      status: "rejected",
      cwd: input.cwd,
      threadsSeen: threads.length,
      threadId: thread.id,
      threadOrigin,
      reason: "turn/start did not return a turn id",
      fallbackReason
    };
  }

  let completionStatus: string | undefined;
  let completionWarning: string | undefined;
  let readWarning: string | undefined;

  if (input.waitForCompletionMs && input.waitForCompletionMs > 0) {
    try {
      const completion = await client.waitForTurnCompleted({
        threadId: thread.id,
        turnId: turn.turn.id,
        timeoutMs: input.waitForCompletionMs
      });
      completionStatus = completion.status;
    } catch (error) {
      completionWarning = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    await client.readThread(thread.id);
  } catch (error) {
    readWarning = error instanceof Error ? error.message : String(error);
  }

  return {
    status: "accepted",
    cwd: input.cwd,
    threadsSeen: threads.length,
    threadId: thread.id,
    threadOrigin,
    turnId: turn.turn.id,
    turnStatus: turn.turn.status,
    fallbackReason,
    completionStatus,
    completionWarning,
    readWarning
  };
}

export function normalizeCodexThreadRead(value: unknown): CodexThreadRead {
  return {
    raw: value,
    messages: collectCodexThreadMessages(value),
    turns: collectCodexThreadTurns(value)
  };
}

export function latestAssistantMessage(
  read: CodexThreadRead,
  turnId?: string
): CodexThreadMessage | undefined {
  const messages = read.messages.filter((message) => message.role === "assistant");
  if (turnId) {
    return messages.filter((message) => message.turnId === turnId).at(-1);
  }

  return messages.at(-1);
}

async function startProbeTurnWithFallback(input: {
  client: CodexAppServerClient;
  cwd: string;
  message: string;
  thread: CodexThreadSummary;
  threadOrigin: CodexProbeThreadOrigin;
  canFallbackToManagedThread: boolean;
}): Promise<{
  thread: CodexThreadSummary;
  threadOrigin: CodexProbeThreadOrigin;
  turn: { id?: string; status?: string };
  fallbackReason?: string;
}> {
  try {
    return {
      thread: input.thread,
      threadOrigin: input.threadOrigin,
      turn: await input.client.startTurn({
        threadId: input.thread.id,
        cwd: input.cwd,
        message: input.message
      })
    };
  } catch (error) {
    if (!input.canFallbackToManagedThread) {
      throw error;
    }

    const fallbackThread = await input.client.startThread(input.cwd);
    return {
      thread: fallbackThread,
      threadOrigin: "started",
      turn: await input.client.startTurn({
        threadId: fallbackThread.id,
        cwd: input.cwd,
        message: input.message
      }),
      fallbackReason: error instanceof Error ? error.message : String(error)
    };
  }
}

function selectProbeThread(
  threads: CodexThreadSummary[],
  input: CodexAppServerProbeInput
): CodexThreadSummary | undefined {
  if (input.forceNewThread) {
    return undefined;
  }

  if (input.threadId) {
    return threads.find((thread) => thread.id === input.threadId);
  }

  return threads.find((thread) => thread.cwd === input.cwd);
}

function normalizeThreads(value: unknown): CodexThreadSummary[] {
  const data = asRecord(value)?.data;

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map(normalizeThread)
    .filter((thread): thread is CodexThreadSummary => Boolean(thread));
}

function normalizeThread(value: unknown): CodexThreadSummary | undefined {
  const record = asRecord(value);

  if (!record || typeof record.id !== "string") {
    return undefined;
  }

  return {
    id: record.id,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    status: normalizeStatus(record.status),
    source: typeof record.source === "string" ? record.source : undefined
  };
}

function normalizeStatus(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  return typeof record?.type === "string" ? record.type : undefined;
}

function collectCodexThreadMessages(value: unknown): CodexThreadMessage[] {
  const messages: CodexThreadMessage[] = [];
  const seen = new Set<unknown>();

  visitMessageContainer(value, undefined, seen, messages);
  return dedupeMessages(messages);
}

function visitMessageContainer(
  value: unknown,
  currentTurnId: string | undefined,
  seen: Set<unknown>,
  messages: CodexThreadMessage[]
): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      visitMessageContainer(item, currentTurnId, seen, messages);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const turnId = stringField(record, "turnId") ?? stringField(record, "turn_id") ?? currentTurnId;
  const nextTurnId = isTurnLikeRecord(record) ? (stringField(record, "id") ?? turnId) : turnId;
  const role = normalizeMessageRole(record.role ?? asRecord(record.author)?.role, record);
  const text = extractMessageText(record);

  if (role && text) {
    messages.push({
      ...(stringField(record, "id") ? { id: stringField(record, "id") } : {}),
      ...(turnId ? { turnId } : {}),
      role,
      text
    });
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === "raw") {
      continue;
    }

    visitMessageContainer(child, nextTurnId, seen, messages);
  }
}

function collectCodexThreadTurns(value: unknown): CodexThreadTurn[] {
  const turns: CodexThreadTurn[] = [];
  const seen = new Set<unknown>();

  visitTurnContainer(value, seen, turns);
  return dedupeTurns(turns);
}

function visitTurnContainer(value: unknown, seen: Set<unknown>, turns: CodexThreadTurn[]): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      visitTurnContainer(item, seen, turns);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (isTurnLikeRecord(record)) {
    const id = stringField(record, "id");
    if (id) {
      turns.push({
        id,
        status: normalizeStatus(record.status)
      });
    }
  }

  for (const child of Object.values(record)) {
    visitTurnContainer(child, seen, turns);
  }
}

function isTurnLikeRecord(record: Record<string, unknown>): boolean {
  const type = stringField(record, "type") ?? stringField(record, "kind");

  return (
    type === "turn" ||
    Array.isArray(record.items) ||
    Array.isArray(record.messages) ||
    Array.isArray(record.steps)
  );
}

function normalizeMessageRole(
  value: unknown,
  record?: Record<string, unknown>
): CodexThreadMessage["role"] | undefined {
  if (value === "assistant" || value === "user" || value === "system" || value === "tool") {
    return value;
  }

  const type = record ? stringField(record, "type") : undefined;
  if (type === "agentMessage") {
    return "assistant";
  }

  if (type === "userMessage") {
    return "user";
  }

  if (type === "hookPrompt") {
    return "system";
  }

  return undefined;
}

function extractMessageText(record: Record<string, unknown>): string | undefined {
  return (
    stringField(record, "text") ??
    stringField(record, "message") ??
    contentToText(record.content) ??
    contentToText(record.output) ??
    contentToText(record.parts)
  );
}

function contentToText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .flatMap((item) => contentToText(item) ?? [])
      .join("\n")
      .trim();
    return text.length > 0 ? text : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return (
    stringField(record, "text") ??
    stringField(record, "output_text") ??
    stringField(record, "message") ??
    contentToText(record.content)
  );
}

function dedupeMessages(messages: CodexThreadMessage[]): CodexThreadMessage[] {
  const seen = new Set<string>();
  const unique: CodexThreadMessage[] = [];

  for (const message of messages) {
    const key = `${message.id ?? ""}\n${message.turnId ?? ""}\n${message.role}\n${message.text}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(message);
  }

  return unique;
}

function dedupeTurns(turns: CodexThreadTurn[]): CodexThreadTurn[] {
  const seen = new Set<string>();
  const unique: CodexThreadTurn[] = [];

  for (const turn of turns) {
    if (seen.has(turn.id)) {
      continue;
    }

    seen.add(turn.id);
    unique.push(turn);
  }

  return unique;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return "";
}

function formatWebSocketError(event: RuntimeWebSocketEvent): string {
  if (event.error instanceof Error) {
    return event.error.message;
  }

  if (typeof event.message === "string") {
    return event.message;
  }

  return "Codex app-server WebSocket error.";
}

function formatClose(event: RuntimeWebSocketEvent): string {
  const code = typeof event.code === "number" ? event.code.toString() : "unknown code";
  const reason = typeof event.reason === "string" && event.reason.length > 0 ? event.reason : "";

  return reason ? `${code} ${reason}` : code;
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) {
    return `code ${code}`;
  }

  return signal ? `signal ${signal}` : "unknown exit";
}
