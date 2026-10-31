import pg from 'pg';

export const EVENTS_CHANNEL = 'glovebox_events';

type Wake = () => void;

/**
 * One LISTEN connection shared by every SSE stream. Notifications only wake the streams for a
 * sandbox; each stream then reads new rows from `events`, so the table stays the source of truth.
 * Connects on first subscribe. If the connection drops it reconnects and wakes every stream, so
 * anything committed while it was down is still delivered.
 *
 * Needs a direct (non-pooled) connection: LISTEN does not work through a transaction pooler.
 */
export class EventHub {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private readonly subscribers = new Map<string, Set<Wake>>();

  constructor(
    private readonly connectionString: string,
    private readonly retryMs = 1000,
  ) {}

  /** Call `wake` whenever the sandbox may have new events. Returns an unsubscribe function. */
  async subscribe(sandboxId: string, wake: Wake): Promise<() => void> {
    let set = this.subscribers.get(sandboxId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sandboxId, set);
    }
    set.add(wake);
    await this.ensureConnected();
    return () => {
      const current = this.subscribers.get(sandboxId);
      current?.delete(wake);
      if (current?.size === 0) this.subscribers.delete(sandboxId);
    };
  }

  /** Number of open subscriptions, for tests and health checks. */
  get size(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }

  private ensureConnected(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString, application_name: 'glovebox-events' });
    client.on('notification', (msg) => this.onNotification(msg.payload));
    client.on('error', () => this.onLost(client));
    client.on('end', () => this.onLost(client));
    await client.connect();
    await client.query('listen glovebox_events'); // channel: EVENTS_CHANNEL
    if (this.closed) {
      await client.end();
      return;
    }
    this.client = client;
  }

  private onNotification(payload: string | undefined): void {
    if (!payload) return;
    try {
      const { sandbox_id: sandboxId } = JSON.parse(payload) as { sandbox_id?: string };
      if (sandboxId) for (const wake of this.subscribers.get(sandboxId) ?? []) wake();
    } catch {
      // Not ours; ignore.
    }
  }

  private onLost(client: pg.Client): void {
    if (this.client !== client) return;
    this.client = null;
    this.scheduleReconnect();
  }

  /** Reconnect after a pause, then wake every stream to catch up on anything missed. */
  private scheduleReconnect(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.closed || this.subscribers.size === 0) return;
      this.ensureConnected()
        .then(() => this.wakeAll())
        .catch(() => this.scheduleReconnect());
    }, this.retryMs);
  }

  private wakeAll(): void {
    for (const set of this.subscribers.values()) for (const wake of set) wake();
  }
}
