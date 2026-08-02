import { describe, expect, it } from 'vitest';
import { usageFromEvent, UsageTracker } from '../src/usage.js';

const HOUR = 60 * 60 * 1000;

describe('usageFromEvent', () => {
  it('extracts all four token classes from an assistant event', () => {
    expect(
      usageFromEvent({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      }),
    ).toEqual({ input: 10, output: 5, cacheCreation: 20, cacheRead: 30 });
  });

  it('treats missing usage fields as zero', () => {
    expect(usageFromEvent({ type: 'assistant', message: { usage: { output_tokens: 7 } } })).toEqual({
      input: 0,
      output: 7,
      cacheCreation: 0,
      cacheRead: 0,
    });
  });

  it('ignores result events so turn usage is not double-counted', () => {
    expect(usageFromEvent({ type: 'result', usage: { input_tokens: 10 } })).toBeNull();
  });

  it('ignores events without usage', () => {
    expect(usageFromEvent({ type: 'assistant', message: {} })).toBeNull();
    expect(usageFromEvent({ type: 'user' })).toBeNull();
    expect(usageFromEvent('not an object')).toBeNull();
    expect(usageFromEvent(null)).toBeNull();
  });
});

describe('UsageTracker', () => {
  const counts = { input: 100, output: 50, cacheCreation: 200, cacheRead: 400 };

  it('accumulates window and lifetime totals with a breakdown', () => {
    const tracker = new UsageTracker();
    tracker.record(counts);
    tracker.record(counts);
    const snap = tracker.snapshot();
    expect(snap.windowHours).toBe(5);
    expect(snap.window).toEqual({
      input: 200,
      output: 100,
      cacheCreation: 400,
      cacheRead: 800,
      total: 1500,
    });
    expect(snap.lifetime.total).toBe(1500);
  });

  it('drops samples older than five hours from the window but not lifetime', () => {
    const tracker = new UsageTracker();
    const now = Date.now();
    tracker.record(counts, now - 6 * HOUR);
    tracker.record(counts, now - HOUR);
    const snap = tracker.snapshot(now);
    expect(snap.window.total).toBe(750);
    expect(snap.lifetime.total).toBe(1500);
  });

  it('reports how much of the configured limit is used and left', () => {
    const tracker = new UsageTracker();
    tracker.record(counts); // 750 tokens
    const snap = tracker.snapshot(Date.now(), 3000);
    expect(snap.limit).toEqual({
      tokens: 3000,
      usedPercent: 25,
      remainingTokens: 2250,
      remainingPercent: 75,
    });
  });

  it('clamps remaining at zero once the limit is exceeded', () => {
    const tracker = new UsageTracker();
    tracker.record(counts); // 750 tokens
    const snap = tracker.snapshot(Date.now(), 500);
    expect(snap.limit.usedPercent).toBe(150);
    expect(snap.limit.remainingTokens).toBe(0);
    expect(snap.limit.remainingPercent).toBe(0);
  });

  it('reports nulls without a configured limit', () => {
    const tracker = new UsageTracker();
    tracker.record(counts);
    expect(tracker.snapshot().limit).toEqual({
      tokens: null,
      usedPercent: null,
      remainingTokens: null,
      remainingPercent: null,
    });
  });

  it('ignores a zero or negative limit', () => {
    const tracker = new UsageTracker();
    tracker.record(counts);
    expect(tracker.snapshot(Date.now(), 0).limit.tokens).toBeNull();
    expect(tracker.snapshot(Date.now(), -5).limit.remainingPercent).toBeNull();
  });
});
