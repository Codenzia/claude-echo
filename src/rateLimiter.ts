export interface RateLimitDecision {
  ok: boolean;
  reason?: string;
}

export class RateLimiter {
  private hour: number[] = [];
  private day: number[] = [];

  constructor(
    private readonly perHour: number,
    private readonly perDay: number
  ) {}

  private prune(now: number): void {
    const hourCutoff = now - 60 * 60 * 1000;
    const dayCutoff = now - 24 * 60 * 60 * 1000;
    while (this.hour.length && this.hour[0] < hourCutoff) { this.hour.shift(); }
    while (this.day.length && this.day[0] < dayCutoff) { this.day.shift(); }
  }

  check(now: number = Date.now()): RateLimitDecision {
    this.prune(now);
    if (this.perHour > 0 && this.hour.length >= this.perHour) {
      return { ok: false, reason: `Rate limit reached: ${this.perHour} messages/hour. Try again later.` };
    }
    if (this.perDay > 0 && this.day.length >= this.perDay) {
      return { ok: false, reason: `Rate limit reached: ${this.perDay} messages/day. Resets in ~24 hours.` };
    }
    return { ok: true };
  }

  record(now: number = Date.now()): void {
    this.hour.push(now);
    this.day.push(now);
    this.prune(now);
  }

  stats(): { lastHour: number; lastDay: number; perHour: number; perDay: number } {
    this.prune(Date.now());
    return {
      lastHour: this.hour.length,
      lastDay: this.day.length,
      perHour: this.perHour,
      perDay: this.perDay
    };
  }
}
