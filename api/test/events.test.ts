import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actor,
  agentWrite,
  closeContext,
  expireSandbox,
  first,
  makeContext,
  newSandbox,
  type Actor,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let base: string;

beforeAll(async () => {
  // A 300 ms reconnect delay makes the reconnect test write while the listener is down.
  ctx = makeContext({ sseHeartbeatMs: 100, hubRetryMs: 300 });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await closeContext(ctx);
});

interface Frame {
  id?: string;
  event?: string;
  data?: { id: string; type: string; call_id: string | null; payload: Record<string, unknown>; created_at: string };
  comment?: string;
  retry?: string;
}

function parseFrame(text: string): Frame {
  const frame: Frame = {};
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim();
    else if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6)) as Frame['data'];
    else if (line.startsWith('retry: ')) frame.retry = line.slice(7);
  }
  return frame;
}

/** Open an SSE stream and read frames from it. */
async function openStream(sandboxId: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const res = await fetch(`${base}/sandboxes/${sandboxId}/events`, { headers, signal: abort.signal });
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  /** The next frame matching `match`, skipping others, or fail after `timeoutMs`. */
  async function next(match: (f: Frame) => boolean = (f) => f.event !== undefined, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (match(frame)) return frame;
        continue;
      }
      if (done) throw new Error('stream ended');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a frame');
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for a frame')), left)),
      ]);
      if (chunk.done) done = true;
      else buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Resolves true once the server ends the stream. */
  async function ended(timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!done && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
      if (chunk?.done) done = true;
    }
    return done;
  }

  return { res, next, ended, close: () => abort.abort() };
}

const logToll = (a: Actor, amount: string) =>
  agentWrite(ctx, a, 'POST', '/expenses', 'log_expense', { category: 'toll', amount });

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fleet() {
  const sb = await newSandbox(ctx, 'small_fleet');
  return { sb, tommy: await actor(ctx, sb.id, 'tommy') };
}

describe('GET /sandboxes/:id/events', () => {
  it('streams new events live, starting after the newest existing one', async () => {
    const { sb, tommy } = await fleet();
    const stream = await openStream(sb.id);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect((await stream.next((f) => f.retry !== undefined)).retry).toBe('2000');

    await logToll(tommy, '12.50');
    const frame = await stream.next();
    expect(frame.event).toBe('expense.created');
    expect(frame.id).toBe(frame.data?.id);
    expect(frame.data).toMatchObject({ type: 'expense.created', call_id: tommy.callId });
    expect(frame.data?.payload).toMatchObject({ amount_cents: 1250 });
    stream.close();
  });

  it("sends only this sandbox's events", async () => {
    const a = await fleet();
    const b = await fleet();
    const stream = await openStream(a.sb.id);
    await logToll(b.tommy, '99');
    await logToll(a.tommy, '12');
    expect((await stream.next()).data?.payload).toMatchObject({ amount_cents: 1200 });
    stream.close();
  });

  it('replays everything after Last-Event-ID, in order', async () => {
    const { sb, tommy } = await fleet();
    await logToll(tommy, '1');
    await logToll(tommy, '2');
    await logToll(tommy, '3');
    const { rows } = await ctx.pool.query<{ id: string }>(
      "select id::text as id from events where sandbox_id = $1 and type = 'expense.created' order by id",
      [sb.id],
    );
    const stream = await openStream(sb.id, { 'last-event-id': first(rows).id });
    const amounts = [];
    for (let i = 0; i < 2; i++) amounts.push((await stream.next()).data?.payload.amount_cents);
    expect(amounts).toEqual([200, 300]);
    stream.close();
  });

  it('sends heartbeats', async () => {
    const { sb } = await fleet();
    const stream = await openStream(sb.id);
    expect((await stream.next((f) => f.comment === 'ping', 1000)).comment).toBe('ping');
    stream.close();
  });

  it('never sends rolled-back events', async () => {
    const { sb, tommy } = await fleet();
    const stream = await openStream(sb.id);
    const client = await ctx.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into events (sandbox_id, type, payload) values ($1, 'test.rolled_back', '{}')", [sb.id]);
      await client.query('rollback');
    } finally {
      client.release();
    }
    await logToll(tommy, '5');
    expect((await stream.next()).event).toBe('expense.created');
    stream.close();
  });

  it('keeps delivering after the listener connection drops', async () => {
    const { sb, tommy } = await fleet();
    const stream = await openStream(sb.id);
    const listener = async () =>
      (
        await ctx.pool.query<{ pid: number }>(
          "select pid from pg_stat_activity where application_name = 'glovebox-events' and datname = current_database()",
        )
      ).rows;
    await until(async () => (await listener()).length === 1);
    await ctx.pool.query('select pg_terminate_backend($1)', [first(await listener()).pid]);

    // Written while the listener may be down; the reconnect wakes the stream to catch up.
    await logToll(tommy, '7');
    expect((await stream.next()).data?.payload).toMatchObject({ amount_cents: 700 });
    await until(async () => (await listener()).length === 1);
    stream.close();
  });

  it('unsubscribes when the client disconnects', async () => {
    const { sb } = await fleet();
    const before = ctx.hub.size;
    const stream = await openStream(sb.id);
    await until(() => ctx.hub.size === before + 1);
    stream.close();
    await until(() => ctx.hub.size === before);
  });

  it('404s an unknown sandbox, 410s an expired one, and 400s a bad id', async () => {
    const res404 = await fetch(`${base}/sandboxes/00000000-0000-4000-8000-000000000000/events`);
    expect(res404.status).toBe(404);
    const { sb } = await fleet();
    await expireSandbox(ctx, sb.id);
    expect((await fetch(`${base}/sandboxes/${sb.id}/events`)).status).toBe(410);
    expect((await fetch(`${base}/sandboxes/not-a-uuid/events`)).status).toBe(400);
  });
});

describe('shutdown', () => {
  it('ends open streams so the server can close', async () => {
    const own = makeContext();
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(own.app.server.address() as AddressInfo).port}`;
    const sb = await newSandbox(own, 'owner_operator');
    const res = await fetch(`${url}/sandboxes/${sb.id}/events`);
    const reader = res.body?.getReader();
    await until(() => own.hub.size === 1);

    await closeContext(own);
    let done = false;
    while (!done && reader) done = (await reader.read()).done;
    expect(done).toBe(true);
  });
});
