export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  attemptsInWindow: number;
}

export interface CooldownResult {
  allowed: boolean;
  retryAfterSeconds: number;
  hitCount: number;
}

interface Bucket {
  timestamps: number[];
  blockedUntil: number;
}

interface CooldownBucket {
  lastAllowedAt: number;
  hitCount: number;
}

export function getRandomDelayMs(minMs: number, maxMs: number): number {
  const low = Math.max(200, Math.min(minMs, maxMs));
  const high = Math.max(low, maxMs);
  return Math.floor(low + Math.random() * (high - low + 1));
}

class SlidingWindowRateLimiter {
  private buckets = new Map<string, Bucket>();
  private cooldowns = new Map<string, CooldownBucket>();

  checkCooldown(key: string, cooldownSeconds: number): CooldownResult {
    const now = Date.now();
    const cooldownMs = Math.max(1, cooldownSeconds) * 1000;
    const existing = this.cooldowns.get(key);

    if (existing && now - existing.lastAllowedAt < cooldownMs) {
      existing.hitCount += 1;
      const retryAfterSeconds = Math.ceil((cooldownMs - (now - existing.lastAllowedAt)) / 1000);
      return {
        allowed: false,
        retryAfterSeconds,
        hitCount: existing.hitCount,
      };
    }

    this.cooldowns.set(key, { lastAllowedAt: now, hitCount: 0 });
    return { allowed: true, retryAfterSeconds: 0, hitCount: 0 };
  }

  check(key: string, maxAttempts: number, windowMinutes: number, blockMinutes = 15): RateLimitResult {
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const existing = this.buckets.get(key) || { timestamps: [], blockedUntil: 0 };

    if (existing.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((existing.blockedUntil - now) / 1000),
        attemptsInWindow: existing.timestamps.length,
      };
    }

    existing.timestamps = existing.timestamps.filter((ts) => now - ts < windowMs);

    if (existing.timestamps.length >= maxAttempts) {
      existing.blockedUntil = now + blockMinutes * 60 * 1000;
      this.buckets.set(key, existing);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((existing.blockedUntil - now) / 1000),
        attemptsInWindow: existing.timestamps.length,
      };
    }

    existing.timestamps.push(now);
    this.buckets.set(key, existing);

    return {
      allowed: true,
      remaining: Math.max(0, maxAttempts - existing.timestamps.length),
      retryAfterSeconds: 0,
      attemptsInWindow: existing.timestamps.length,
    };
  }

  peek(key: string, maxAttempts: number, windowMinutes: number): RateLimitResult {
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const existing = this.buckets.get(key);
    if (!existing) {
      return { allowed: true, remaining: maxAttempts, retryAfterSeconds: 0, attemptsInWindow: 0 };
    }
    if (existing.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((existing.blockedUntil - now) / 1000),
        attemptsInWindow: existing.timestamps.length,
      };
    }
    const active = existing.timestamps.filter((ts) => now - ts < windowMs);
    return {
      allowed: active.length < maxAttempts,
      remaining: Math.max(0, maxAttempts - active.length),
      retryAfterSeconds: 0,
      attemptsInWindow: active.length,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
    this.cooldowns.delete(key);
  }

  getActiveBlocks(): Array<{ key: string; retryAfterSeconds: number; attempts: number }> {
    const now = Date.now();
    const list: Array<{ key: string; retryAfterSeconds: number; attempts: number }> = [];
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.blockedUntil > now) {
        list.push({
          key,
          retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000),
          attempts: bucket.timestamps.length,
        });
      }
    }
    return list;
  }

  pruneExpired(maxCooldownAgeMs = 10 * 60_000, maxBucketIdleMs = 60 * 60_000): void {
    const now = Date.now();
    for (const [k, cd] of this.cooldowns.entries()) {
      if (now - cd.lastAllowedAt > maxCooldownAgeMs) {
        this.cooldowns.delete(k);
      }
    }
    for (const [k, b] of this.buckets.entries()) {
      const lastTs = b.timestamps[b.timestamps.length - 1] || 0;
      if (b.blockedUntil <= now && now - lastTs > maxBucketIdleMs) {
        this.buckets.delete(k);
      }
    }
  }
}

export const pairingRateLimiter = new SlidingWindowRateLimiter();
export const commandRateLimiter = new SlidingWindowRateLimiter();

const rateLimiterCleanupTimer = setInterval(() => {
  pairingRateLimiter.pruneExpired();
  commandRateLimiter.pruneExpired();
}, 5 * 60_000);
if (typeof rateLimiterCleanupTimer.unref === 'function') {
  rateLimiterCleanupTimer.unref();
}
