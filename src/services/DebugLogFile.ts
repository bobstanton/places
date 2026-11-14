import type { App } from 'obsidian';
import { normalizePath } from 'obsidian';
import { configurePersistentLogSink, getErrorMessage, heapUsage, logger } from "places-shared/utils";
import type { DebugLogEntry } from 'obsidian-debug-logger';

const FILE_NAME = 'debug-log.txt';
const PREVIOUS_FILE_NAME = 'debug-log.previous.txt';
const FLUSH_INTERVAL_MS = 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CLEAN_EXIT = '--- session ended ---';
const HEAP_SAMPLE_TICKS = 5;
const LONG_TASK_MS = 200;

export class DebugLogFile {
  private timer: number | null = null;
  private longTasks: PerformanceObserver | null = null;
  private lastWritten: { timestamp: number; message: string } | undefined;
  private ticks = 0;
  private pending: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private written = 0;
  private stopped = false;

  private constructor(private readonly app: App, private readonly directory: string) {}

  static async start(app: App, pluginId: string): Promise<DebugLogFile | null> {
    const directory = normalizePath(`${app.vault.configDir}/plugins/${pluginId}`);
    const file = new DebugLogFile(app, directory);

    try {
      await file.rotate();

      await file.writeHeader();
    } catch (error) {
      logger.scope('Places').debug('Debug log file unavailable', { error: getErrorMessage(error) });

      return null;
    }

    file.timer = window.setInterval(() => file.tick(), FLUSH_INTERVAL_MS);
    file.observeLongTasks();
    configurePersistentLogSink(entry => { if (entry.level === 'warn' || entry.level === 'error') file.collect(); });

    return file;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    configurePersistentLogSink(null);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.longTasks?.disconnect();
    this.longTasks = null;
    this.collect();
    this.pending.push(CLEAN_EXIT);

    await this.flush();
  }

  private observeLongTasks(): void {
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_MS) continue;
          logger.scope('Places').warn('Long task', {
            durationMs: Math.round(entry.duration),
            startTime: Math.round(entry.startTime),
            ...heapUsage(),
          });
        }
      });

      observer.observe({ entryTypes: ['longtask'] });
      this.longTasks = observer;
    } catch {
      return;
    }
  }

  private tick(): void {
    if (++this.ticks % HEAP_SAMPLE_TICKS === 0) {
      const usage = heapUsage();

      if (usage) logger.scope('Places').debug('Heap sample', usage);
    }

    this.collect();
  }

  private get path(): string {
    return `${this.directory}/${FILE_NAME}`;
  }

  private collect(): void {
    const entries = logger.getEntries();

    if (entries.length === 0) return;

    const last = this.lastWritten;
    const seen = last === undefined ? -1
      : entries.findLastIndex(entry => entry.timestamp === last.timestamp && entry.message === last.message);

    if (last !== undefined && seen === -1) {
      this.pending.push('--- entries dropped: the buffer wrapped between flushes ---');
    }

    const fresh = entries.slice(seen + 1);

    if (fresh.length === 0) return;

    const newest = fresh[fresh.length - 1];

    this.lastWritten = { timestamp: newest.timestamp, message: newest.message };
    this.pending.push(...fresh.map(format));
    void this.flush();
  }

  private flush(): Promise<void> {
    if (this.pending.length === 0) return this.writing;
    const text = `${this.pending.join('\n')}\n`;

    this.pending = [];
    this.written += text.length;
    this.writing = this.writing
      .then(async () => {
        if (this.written >= MAX_FILE_BYTES) {
          this.written = text.length;

          await this.rotate(true);
        }

        await this.app.vault.adapter.append(this.path, text);
      })
      .catch(() => undefined);

    return this.writing;
  }

  private async writeHeader(): Promise<void> {
    const previous = await this.readTail();
    const ended = previous === undefined ? 'no previous session'
      : previous.trimEnd().endsWith(CLEAN_EXIT) ? 'previous session ended normally'
        : 'PREVIOUS SESSION DID NOT END NORMALLY';

    await this.app.vault.adapter.append(this.path, `\n--- session started ${new Date().toISOString()} (${ended}) ---\n`);
  }

  private async readTail(): Promise<string | undefined> {
    if (!(await this.app.vault.adapter.exists(this.path))) return undefined;
    const contents = await this.app.vault.adapter.read(this.path);

    return contents.slice(-CLEAN_EXIT.length - 2);
  }

  private async rotate(force = false): Promise<void> {
    const stat = await this.app.vault.adapter.stat(this.path);

    if (!stat || (!force && stat.size < MAX_FILE_BYTES)) return;
    const previous = `${this.directory}/${PREVIOUS_FILE_NAME}`;

    if (await this.app.vault.adapter.exists(previous)) await this.app.vault.adapter.remove(previous);

    await this.app.vault.adapter.rename(this.path, previous);
  }
}

function format(entry: DebugLogEntry): string {
  const scope = entry.scope ? ` [${entry.scope}]` : '';
  const data = entry.data ? ` ${entry.data}` : '';

  return `${new Date(entry.timestamp).toISOString()} [${entry.level.toUpperCase()}]${scope} ${entry.message}${data}`;
}
