import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramError } from 'telegraf';

// Fast retry timings for this file only — config.ts reads these from the
// environment at import time, so they must be set before the first import.
process.env.SEND_RETRY_ATTEMPTS = '3';
process.env.SEND_RETRY_BASE_MS = '5';

const { withTelegramRetry } = await import('../src/reply.js');

function telegramError(code: number, retryAfter?: number): TelegramError {
  return new TelegramError({
    error_code: code,
    description: `fake ${code}`,
    ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
  });
}

test('withTelegramRetry retries a 429 and succeeds once it clears', async () => {
  let calls = 0;
  const result = await withTelegramRetry(async () => {
    calls += 1;
    if (calls === 1) throw telegramError(429, 0);
    return 'sent';
  });
  assert.equal(result, 'sent');
  assert.equal(calls, 2, 'one failure, one success');
});

test('withTelegramRetry retries a 5xx with backoff', async () => {
  let calls = 0;
  const result = await withTelegramRetry(async () => {
    calls += 1;
    if (calls < 3) throw telegramError(502);
    return 'sent';
  });
  assert.equal(result, 'sent');
  assert.equal(calls, 3);
});

test('withTelegramRetry does not retry a permanent error', async () => {
  let calls = 0;
  await assert.rejects(
    withTelegramRetry(async () => {
      calls += 1;
      throw telegramError(400);
    }),
    /400/
  );
  assert.equal(calls, 1, 'no retry on a non-retryable error');
});

test('withTelegramRetry gives up after the attempt budget and surfaces the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withTelegramRetry(async () => {
      calls += 1;
      throw telegramError(502);
    }),
    /502/
  );
  assert.equal(calls, 3, 'stops at SEND_RETRY_ATTEMPTS');
});
