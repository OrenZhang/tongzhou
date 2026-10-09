import type { CodexClient } from './codex';

/** Keeps idle engine threads alive; active turns are owned by the execution adapter. */
export class CodexSessions {
  private entries = new Map<
    string,
    {
      client: CodexClient;
      key: string;
      providerId: string;
      threadId: string;
      timer: NodeJS.Timeout;
      failed: () => void;
      reject: (request: any) => void;
    }
  >();
  constructor(
    private ttl = 10 * 60_000,
    private capacity = 4,
  ) {}
  async take(sessionId: string, key: string, threadId?: string) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.detach(sessionId);
    if (entry.key === key && entry.threadId === threadId) return entry.client;
    await entry.client.stop();
  }
  put(sessionId: string, key: string, providerId: string, threadId: string, client: CodexClient) {
    this.remove(sessionId);
    while (this.entries.size >= this.capacity) this.remove(this.entries.keys().next().value!);
    const failed = () => this.remove(sessionId);
    const reject = (r: any) => client.reject(r.id, 'No active Tongzhou turn');
    const timer = setTimeout(failed, this.ttl);
    timer.unref();
    this.entries.set(sessionId, { client, key, providerId, threadId, timer, failed, reject });
    client.on('failure', failed);
    client.on('request', reject);
  }
  private detach(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    clearTimeout(entry.timer);
    entry.client.removeListener('failure', entry.failed);
    entry.client.removeListener('request', entry.reject);
    return entry;
  }
  remove(sessionId: string) {
    return this.detach(sessionId)?.client.stop();
  }
  clear(providerId?: string) {
    const pending: (Promise<void> | undefined)[] = [];
    for (const [id, entry] of this.entries)
      if (!providerId || entry.providerId === providerId) pending.push(this.remove(id));
    return Promise.all(pending);
  }
}
