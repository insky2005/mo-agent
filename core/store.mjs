/** 带序号与环形缓冲的事件中心：支持断线后按 seq 重放。 */
export class EventStore {
  constructor(limit) {
    this.limit = limit || 800;
    this.seq = 0;
    this.buffer = [];
    this.listeners = new Set();
  }

  push(type, payload) {
    this.seq += 1;
    const event = { seq: this.seq, at: Date.now(), type, payload };
    this.buffer.push(event);
    if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        /* 单个订阅者失败不影响其它订阅者 */
      }
    }
    return event;
  }

  /** 返回 seq 之后的所有缓存事件（不含 seq 本身）。 */
  since(afterSeq) {
    const from = Number(afterSeq) || 0;
    return this.buffer.filter((event) => event.seq > from);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
