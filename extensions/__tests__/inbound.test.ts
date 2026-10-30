import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FAKE_CHANNEL_ID = "chan-1";
const FAKE_USER_ID = "user-1";

const posted: string[] = [];
const reactions: string[] = [];
const edits: string[] = [];
const fakeChannel = {
  id: FAKE_CHANNEL_ID,
  isTextBased: () => true,
  send: (text: string) => {
    posted.push(text);
    return Promise.resolve({ id: `msg-${posted.length}` });
  },
  messages: {
    fetch: async (id: string) => ({
      id,
      content: posted[posted.length - 1] ?? "",
      react: async (emoji: string) => {
        reactions.push(emoji);
      },
      edit: async (text: string) => {
        edits.push(text);
      },
    }),
  },
  sendTyping: async () => true,
};

const clients: any[] = [];
let activeClient: any = null;

vi.mock("discord.js", () => ({
  ChannelType: { GuildText: 0 },
  GatewayIntentBits: {
    Guilds: 0,
    GuildMessages: 1,
    MessageContent: 2,
    DirectMessages: 3,
  },
  Partials: { Channel: 0, Message: 1 },
  Client: class FakeClient {
    handlers: Record<string, any> = {};
    user = { tag: "fake-bot#1" };
    constructor() {
      clients.push(this);
      activeClient = this;
    }
    on(name: string, fn: any) {
      this.handlers[name] = fn;
    }
    removeAllListeners(name: string) {
      delete this.handlers[name];
    }
    once(name: string, fn: any) {
      if (name === "ready") fn(this);
    }
    async login() {
      return {};
    }
    async destroy() {}
    isReady() {
      return true;
    }
    guilds = {
      fetch: async () => ({ channels: { create: async () => fakeChannel } }),
    };
    channels = { fetch: async () => fakeChannel };
  },
}));

function fakeMessage(content: string, channelId = FAKE_CHANNEL_ID) {
  return {
    author: { bot: false, id: FAKE_USER_ID },
    channelId,
    content,
    react: async () => {},
    reply: async () => {},
  };
}

const ctx = {
  cwd: process.cwd(),
  ui: {
    input: async () => undefined,
    notify: () => {},
    setStatus: () => {},
    editor: async () => undefined,
  },
  abort: () => {},
};

async function startExtension(config: Record<string, unknown> = {}) {
  posted.length = 0;
  reactions.length = 0;
  edits.length = 0;
  clients.length = 0;

  const sent: Array<{ content: string; options?: any }> = [];
  const handlers: Record<string, any> = {};
  const pi: any = {
    on: (name: string, fn: any) => {
      handlers[name] = fn;
    },
    registerTool: () => {},
    registerCommand: (_name: string, cmd: { handler: any }) => {
      handlers.__command = cmd.handler;
    },
    sendUserMessage: (content: string, options?: any) => {
      sent.push({ content, options });
    },
  };

  const cfgDir = join(tmpdir(), `pdr-it-${process.pid}-${posted.length}-${clients.length}-${sent.length}`);
  await mkdir(cfgDir, { recursive: true });
  await writeFile(
    join(cfgDir, "config.json"),
    JSON.stringify({
      token: "fake-token",
      guildId: "fake-guild",
      allowedUserIds: [FAKE_USER_ID],
      reactions: true,
      autoConnect: false,
      ...config,
    }),
  );
  process.env.PI_DISCORD_CONFIG_DIR = cfgDir;

  const extension = (await import("../index.js")).default;
  extension(pi);
  await handlers.__command("start", ctx);

  return { sent, handlers, client: activeClient, ctx };
}

describe("Discord inbound wiring", () => {
  it("queues a message as a normal turn when idle", async () => {
    const { sent, client } = await startExtension();
    await client.handlers.messageCreate(fakeMessage("do the thing"));
    expect(sent.length).toBe(1);
    expect(sent[0].content).toBe("do the thing");
    expect(sent[0].options).toBeUndefined();
  });

  it("steers into a running turn when Pi is busy", async () => {
    const { sent, handlers, client } = await startExtension();
    handlers.agent_start({}, ctx);
    await client.handlers.messageCreate(fakeMessage("also rename the file"));
    expect(sent.length).toBe(1);
    expect(sent[0].options?.deliverAs).toBe("steer");
    expect(sent[0].content).toBe("also rename the file");
  });

  it("rejects inbound messages when steering is disabled", async () => {
    const { sent, handlers, client } = await startExtension({ steering: false });
    handlers.agent_start({}, ctx);
    await client.handlers.messageCreate(fakeMessage("too early"));
    expect(sent.length).toBe(0);
  });

  it("re-attaches handlers on a second start (reload-safe)", async () => {
    const { sent, handlers, client, ctx } = await startExtension();
    // Simulate /reload: a new extension instance starts while the client is live.
    await handlers.__command("start", ctx);
    await client.handlers.messageCreate(fakeMessage("after reload"));
    expect(sent.length).toBe(1);
    expect(sent[0].content).toBe("after reload");
  });

  it("ignores messages from other channels and from bots", async () => {
    const { sent, client } = await startExtension();
    await client.handlers.messageCreate(fakeMessage("elsewhere", "chan-2"));
    await client.handlers.messageCreate({
      author: { bot: true, id: FAKE_USER_ID },
      channelId: FAKE_CHANNEL_ID,
      content: "bot noise",
      react: async () => {},
      reply: async () => {},
    });
    expect(sent.length).toBe(0);
  });
});

describe("output pipeline", () => {
  it("posts tool labels and assistant text even when the turn started locally", async () => {
    const { handlers } = await startExtension();
    await handlers.agent_start({}, ctx);
    await handlers.tool_execution_start({ toolName: "bash", args: { command: "ls" } });
    await handlers.message_end(
      { message: { id: "a1", role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );
    await handlers.agent_end({}, ctx);

    const joined = posted.join("\n");
    expect(joined).toContain("bash");
    expect(joined).toContain("done");
    expect(reactions).toContain("✅");
    expect(edits.some((e) => e.startsWith("<@user-1> ") && e.includes("done"))).toBe(true);
  });

  it("streams thinking and long text in Discord-sized chunks", async () => {
    const { handlers } = await startExtension();
    const longText = "para\n\n".repeat(500); // ~2500 chars
    await handlers.agent_start({}, ctx);
    await handlers.message_update(
      {
        message: {
          id: "a2",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning about it" },
            { type: "text", text: longText },
          ],
        },
      },
      ctx,
    );
    await handlers.message_end(
      {
        message: { id: "a2", role: "assistant", content: [{ type: "text", text: longText }] },
      },
      ctx,
    );
    await handlers.agent_end({}, ctx);

    const thinking = posted.filter((p) => p.startsWith("💭"));
    expect(thinking.length).toBeGreaterThan(0);
    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) expect(p.length).toBeLessThanOrEqual(2000);
  });

  it("suppresses thinking when thinking is disabled", async () => {
    const { handlers } = await startExtension({ thinking: false });
    await handlers.agent_start({}, ctx);
    await handlers.message_update(
      {
        message: {
          id: "a3",
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal reasoning" }],
        },
      },
      ctx,
    );
    await handlers.message_end(
      { message: { id: "a3", role: "assistant", content: [] } },
      ctx,
    );
    await handlers.agent_end({}, ctx);
    expect(posted.filter((p) => p.includes("reasoning"))).toEqual([]);
  });

  it("does not tag thinking chunks", async () => {
    const { handlers } = await startExtension();
    await handlers.agent_start({}, ctx);
    await handlers.message_update(
      {
        message: {
          id: "a4",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "a".repeat(2000) },
            { type: "text", text: "final answer" },
          ],
        },
      },
      ctx,
    );
    await handlers.message_end(
      { message: { id: "a4", role: "assistant", content: [{ type: "text", text: "final answer" }] } },
      ctx,
    );
    await handlers.agent_end({}, ctx);
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain("final answer");
  });

  it("mirrors locally typed prompts", async () => {
    const { handlers } = await startExtension();
    await handlers.input({ source: "interactive", text: "fix the tests" }, ctx);
    expect(posted[0]).toBe("🖥️ fix the tests");
  });

  it("does not mirror slash commands or extension-sent input", async () => {
    const { handlers } = await startExtension();
    await handlers.input({ source: "interactive", text: "/compact" }, ctx);
    await handlers.input({ source: "extension", text: "from discord" }, ctx);
    expect(posted.length).toBe(0);
  });
});
