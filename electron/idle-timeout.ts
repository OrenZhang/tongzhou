/** An active stream can run indefinitely; silence remains bounded. */
export class IdleTimeout {
  private timer?: NodeJS.Timeout;
  constructor(
    private ms: number,
    private expire: () => void,
  ) {
    this.touch();
  }
  touch() {
    this.dispose();
    this.timer = setTimeout(this.expire, this.ms);
    this.timer.unref?.();
  }
  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
