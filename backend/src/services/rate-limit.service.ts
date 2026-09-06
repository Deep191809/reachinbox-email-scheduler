import { redis } from '../config/redis.js';

const HOUR_MS = 3_600_000;
const HOUR_SECONDS = 3_600;

export type SendReservation =
  | { status: 'allowed'; count: number }
  | { status: 'rate-limited'; retryAt: Date; count: number }
  | { status: 'throttled'; retryAt: Date };

/**
 * Atomically checks the sender's hourly quota and minimum send gap.
 * Nothing is reserved when either constraint says the job must wait.
 * This makes the operation safe across multiple worker processes/instances.
 */
export async function reserveSendAttempt(
  senderId: string,
  hourlyLimit: number,
  minimumDelayMs: number,
  now = Date.now(),
): Promise<SendReservation> {
  const hourStartMs = Math.floor(now / HOUR_MS) * HOUR_MS;
  const rateKey = `email-rate:${senderId}:${hourStartMs}`;
  const nextKey = `email-next-send:${senderId}`;

  const script = `
    local count = tonumber(redis.call('GET', KEYS[1]) or '0')
    local limit = tonumber(ARGV[1])
    local now = tonumber(ARGV[2])
    local gap = tonumber(ARGV[3])
    local nextSend = tonumber(redis.call('GET', KEYS[2]) or '0')

    if count >= limit then
      return {0, count, now + (3600000 - (now % 3600000))}
    end

    if now < nextSend then
      return {2, count, nextSend}
    end

    local nextCount = redis.call('INCR', KEYS[1])
    if nextCount == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[4])
    end

    if gap > 0 then
      redis.call('SET', KEYS[2], now + gap)
    end

    return {1, nextCount, now}
  `;

  const result = (await redis.eval(
    script,
    2,
    rateKey,
    nextKey,
    hourlyLimit,
    now,
    minimumDelayMs,
    HOUR_SECONDS,
  )) as [number, number, number];

  const [status, count, timestamp] = result.map(Number) as [number, number, number];

  if (status === 1) return { status: 'allowed', count };
  if (status === 0) return { status: 'rate-limited', retryAt: new Date(timestamp), count };
  return { status: 'throttled', retryAt: new Date(timestamp) };
}


export async function shouldNotifyRateLimit(senderId: string, now = Date.now()) {
  const hourStartMs = Math.floor(now / HOUR_MS) * HOUR_MS;
  const key = `email-rate-notified:${senderId}:${hourStartMs}`;
  const result = await redis.set(key, '1', 'EX', HOUR_SECONDS, 'NX');
  return result === 'OK';
}
