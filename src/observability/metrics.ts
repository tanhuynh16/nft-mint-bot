/**
 * Per-phase timings for the critical path, matching the spec's benchmark plan.
 *
 * These names are the vocabulary for "which stage is actually slow" — the question
 * that decides where optimization effort goes. Guessing at the bottleneck instead of
 * measuring it is how bots end up micro-optimizing signing (microseconds) while an
 * HTTPS round-trip (hundreds of milliseconds) sits on the hot path.
 */
export type Phase =
  | 'detect' // stage activation → bot recognition
  | 'build' // obtaining or encoding calldata
  | 'simulate'
  | 'gas'
  | 'sign'
  | 'broadcast' // signed tx → first RPC acceptance
  | 'confirm'; // broadcast → receipt

export class Metrics {
  private readonly timings = new Map<Phase, number[]>();
  private readonly marks = new Map<string, number>();

  start(label: string): void {
    this.marks.set(label, performance.now());
  }

  /** Ends a timer and records the elapsed ms against a phase. */
  end(label: string, phase: Phase): number {
    const started = this.marks.get(label);
    if (started === undefined) return 0;
    this.marks.delete(label);
    const elapsed = performance.now() - started;
    this.record(phase, elapsed);
    return Math.round(elapsed);
  }

  record(phase: Phase, ms: number): void {
    const existing = this.timings.get(phase);
    if (existing) existing.push(ms);
    else this.timings.set(phase, [ms]);
  }

  async time<T>(phase: Phase, fn: () => Promise<T>): Promise<[T, number]> {
    const started = performance.now();
    const result = await fn();
    const elapsed = performance.now() - started;
    this.record(phase, elapsed);
    return [result, Math.round(elapsed)];
  }

  /** Nearest-rank percentile. */
  percentile(phase: Phase, p: number): number | undefined {
    const values = this.timings.get(phase);
    if (!values || values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round(sorted[Math.max(0, index)]!);
  }

  summary(): Record<string, { count: number; p50?: number; p95?: number; p99?: number }> {
    const out: Record<string, { count: number; p50?: number; p95?: number; p99?: number }> = {};
    for (const [phase, values] of this.timings) {
      const p50 = this.percentile(phase, 50);
      const p95 = this.percentile(phase, 95);
      const p99 = this.percentile(phase, 99);
      out[phase] = {
        count: values.length,
        ...(p50 !== undefined ? { p50 } : {}),
        ...(p95 !== undefined ? { p95 } : {}),
        ...(p99 !== undefined ? { p99 } : {}),
      };
    }
    return out;
  }

  /** Sum of the most recent sample of each phase — the end-to-end critical path. */
  criticalPathMs(): number {
    let total = 0;
    for (const values of this.timings.values()) {
      const last = values[values.length - 1];
      if (last !== undefined) total += last;
    }
    return Math.round(total);
  }
}
