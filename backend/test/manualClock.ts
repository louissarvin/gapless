import type { UpstreamTimers } from '../src/relay/perpl/upstream.ts';

/** Manual clock and scheduler: due timers fire in time order only when the test advances. */
export class ManualClock {
  t = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; every: number | null; fn: () => void }>();
  readonly now = () => this.t;
  readonly timers: UpstreamTimers = {
    setTimeout: (fn, ms) => this.add(fn, ms, null),
    clearTimeout: (id) => void this.tasks.delete(id as unknown as number),
    setInterval: (fn, ms) => this.add(fn, ms, ms),
    clearInterval: (id) => void this.tasks.delete(id as unknown as number)
  };

  private add(fn: () => void, ms: number, every: number | null) {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + Math.max(0, ms), every, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; every: number | null; fn: () => void }] | null = null;
      for (const e of this.tasks) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, task] = next;
      this.t = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at += task.every;
      task.fn();
    }
    this.t = end;
  }
}

/** In-memory socket driven by the test; the upstream only uses handlers, send and close. */
export class FakeSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  send(text: string) {
    this.sent.push(text);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  emit(text: string) {
    this.onmessage?.(new MessageEvent('message', { data: text }));
  }
  serverClose(code: number) {
    this.onclose?.(new CloseEvent('close', { code, reason: 'test' }));
  }
}
