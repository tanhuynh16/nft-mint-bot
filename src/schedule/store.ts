import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Lifecycle of a scheduled mint.
 *
 * `armed` is distinct from `running`: armed means the daemon has claimed the job and is
 * waiting on the stage to open, running means a transaction is being built or sent. The
 * split matters on restart — an armed job is safe to re-pick up, a running one needs
 * reconciling against the chain before anything is re-sent.
 */
export const JobStatus = z.enum([
  'pending',
  'armed',
  'running',
  'done',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const jobWhenSchema = z.discriminatedUnion('kind', [
  /** Fire when the drop's own stage opens; resolved from the OpenSea API. */
  z.object({ kind: z.literal('auto') }),
  /** Fire at an explicit instant. Always stored as UTC ISO 8601. */
  z.object({ kind: z.literal('at'), iso: z.string() }),
]);
export type JobWhen = z.infer<typeof jobWhenSchema>;

export const scheduledJobSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  /** Which network/wallet config this job mints under. */
  configPath: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
  when: jobWhenSchema,
  /** What `auto` last resolved to, or the explicit time. UTC ISO. */
  resolvedAt: z.string().optional(),
  /**
   * Ceiling authorised when the job was added. If the cost at fire time exceeds this —
   * a repriced stage, a gas spike — the job fails closed rather than spending more than
   * the operator agreed to.
   */
  maxSpendWei: z.string(),
  status: JobStatus,
  attempts: z.number().int().min(0).default(0),
  txHash: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  jobs: z.array(scheduledJobSchema).default([]),
});

/** Terminal states are excluded from `list` by default and never re-fired. */
export function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/**
 * Short, typeable job id.
 *
 * Six hex characters: long enough that collisions are implausible at the scale of a
 * personal mint schedule, short enough to retype from a terminal without copy-paste.
 */
function newId(): string {
  return randomBytes(3).toString('hex');
}

/**
 * The scheduled-job list, persisted as one JSON file.
 *
 * Writes go through a temp file, fsync and rename, so a crash or a VPS reboot mid-write
 * leaves either the previous schedule or the new one — never a truncated file. That is
 * the same discipline TxJournal uses, for the same reason: this state decides whether
 * money moves, and a corrupt schedule that silently drops a job is worse than no
 * scheduler at all.
 */
export class ScheduleStore {
  private readonly filePath: string;

  constructor(dir = '.schedule') {
    const resolved = resolve(dir);
    mkdirSync(resolved, { recursive: true });
    this.filePath = join(resolved, 'jobs.json');
  }

  get path(): string {
    return this.filePath;
  }

  all(): ScheduledJob[] {
    if (!existsSync(this.filePath)) return [];

    const raw = readFileSync(this.filePath, 'utf8');
    if (raw.trim() === '') return [];

    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(
        `Schedule file at ${this.filePath} is not valid: ` +
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    return parsed.data.jobs;
  }

  /** Jobs still eligible to run, earliest first. */
  pending(): ScheduledJob[] {
    return this.all()
      .filter((j) => !isTerminal(j.status))
      .sort((a, b) => (a.resolvedAt ?? '').localeCompare(b.resolvedAt ?? ''));
  }

  get(id: string): ScheduledJob | undefined {
    return this.all().find((j) => j.id === id);
  }

  add(
    input: Omit<ScheduledJob, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<ScheduledJob, 'status'>>,
  ): ScheduledJob {
    const now = new Date().toISOString();
    const jobs = this.all();

    const job: ScheduledJob = {
      ...input,
      id: this.uniqueId(jobs),
      status: input.status ?? 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.write([...jobs, job]);
    return job;
  }

  /**
   * Applies a patch to one job.
   *
   * Re-reads the file inside the call rather than operating on a cached list, so a
   * concurrent CLI edit while the daemon is running does not silently discard the other
   * process's change.
   */
  update(id: string, patch: Partial<Omit<ScheduledJob, 'id' | 'createdAt'>>): ScheduledJob {
    const jobs = this.all();
    const index = jobs.findIndex((j) => j.id === id);
    if (index === -1) throw new Error(`No scheduled job with id "${id}".`);

    const updated: ScheduledJob = {
      ...jobs[index]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    };
    jobs[index] = updated;
    this.write(jobs);
    return updated;
  }

  remove(id: string): ScheduledJob {
    const jobs = this.all();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`No scheduled job with id "${id}".`);
    this.write(jobs.filter((j) => j.id !== id));
    return job;
  }

  private uniqueId(existing: ScheduledJob[]): string {
    const taken = new Set(existing.map((j) => j.id));
    for (let i = 0; i < 100; i += 1) {
      const id = newId();
      if (!taken.has(id)) return id;
    }
    throw new Error('Could not allocate a unique job id.');
  }

  /** Temp file → fsync → rename. Never writes the destination in place. */
  private write(jobs: ScheduledJob[]): void {
    const payload = `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`;
    const tmp = `${this.filePath}.${process.pid}.tmp`;

    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, payload);
      // Without this the rename can land before the contents reach disk, which is the
      // exact case that produces an empty schedule after a power loss.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmp, this.filePath);

    // Also fsync the directory so the rename itself is durable.
    const dirFd = openSync(dirname(this.filePath), 'r');
    try {
      fsyncSync(dirFd);
    } catch {
      // Not supported on every platform; the rename is still atomic where it matters.
    } finally {
      closeSync(dirFd);
    }

    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already renamed away */
      }
    }
  }
}
