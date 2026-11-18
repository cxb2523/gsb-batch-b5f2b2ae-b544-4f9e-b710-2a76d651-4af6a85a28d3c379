import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDb } from '../src/db.js';
import type { ScanResult } from '../src/modules/media/scanner.js';
import { createMediaDirectoryWatcher } from '../src/modules/media/watcher.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'media-watcher-'));
}

function successfulScan(db: ReturnType<typeof createDb>) {
  return vi.fn(async (paths: string[]): Promise<ScanResult> => {
    const importedIds = paths.map((filePath) => Number(db.prepare(
      `INSERT INTO media (series, file_path, playable_path, codec_status) VALUES ('Show', ?, ?, 'direct')`,
    ).run(filePath, filePath).lastInsertRowid));
    return { importedIds, failedFiles: [] };
  });
}

describe('createMediaDirectoryWatcher', () => {
  it('imports a source video only after size and mtime stay stable for 15 seconds', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'Show - 01.mp4');
    fs.writeFileSync(file, 'video');
    const db = createDb(':memory:');
    const scan = successfulScan(db);
    const imported: number[] = [];
    let now = 0;
    const watcher = createMediaDirectoryWatcher({
      db,
      mediaDir: dir,
      stableMs: 15_000,
      now: () => now,
      scan,
      onImported: (ids) => { imported.push(...ids); },
    });

    await watcher.reconcileNow();
    now = 14_999;
    await watcher.reconcileNow();
    expect(scan).not.toHaveBeenCalled();

    now = 15_000;
    await watcher.reconcileNow();
    expect(scan).toHaveBeenCalledWith([file]);
    expect(imported).toHaveLength(1);
  });

  it('resets the stability window when the file changes', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'Show - 02.mkv');
    fs.writeFileSync(file, 'a');
    const db = createDb(':memory:');
    const scan = successfulScan(db);
    let now = 0;
    const watcher = createMediaDirectoryWatcher({ db, mediaDir: dir, stableMs: 15_000, now: () => now, scan });

    await watcher.reconcileNow();
    now = 10_000;
    fs.appendFileSync(file, 'b');
    await watcher.reconcileNow();
    now = 24_999;
    await watcher.reconcileNow();
    expect(scan).not.toHaveBeenCalled();

    now = 25_000;
    await watcher.reconcileNow();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('ignores hidden files and generated play files', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '.partial.mp4'), 'x');
    fs.writeFileSync(path.join(dir, 'Show - 03.play.mp4'), 'x');
    const db = createDb(':memory:');
    const scan = successfulScan(db);
    let now = 0;
    const watcher = createMediaDirectoryWatcher({ db, mediaDir: dir, stableMs: 15_000, now: () => now, scan });

    await watcher.reconcileNow();
    now = 15_000;
    await watcher.reconcileNow();

    expect(scan).not.toHaveBeenCalled();
  });

  it('tracks a video inside a season subdirectory', async () => {
    const dir = tmpDir();
    const seasonDir = path.join(dir, 'Show Season 1');
    fs.mkdirSync(seasonDir);
    const file = path.join(seasonDir, 'Show - 01.mkv');
    fs.writeFileSync(file, 'video');
    const db = createDb(':memory:');
    const scan = successfulScan(db);
    let now = 0;
    const watcher = createMediaDirectoryWatcher({
      db,
      mediaDir: dir,
      stableMs: 15_000,
      now: () => now,
      scan,
    });

    await watcher.reconcileNow();
    now = 15_000;
    await watcher.reconcileNow();

    expect(scan).toHaveBeenCalledWith([file]);
  });

  it('keeps a failed file eligible for a later retry', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'Show - 04.mkv');
    fs.writeFileSync(file, 'video');
    const db = createDb(':memory:');
    let calls = 0;
    const scan = vi.fn(async (): Promise<ScanResult> => {
      calls += 1;
      if (calls === 1) return { importedIds: [], failedFiles: [file] };
      const id = Number(db.prepare(
        `INSERT INTO media (series, file_path, playable_path, codec_status) VALUES ('Show', ?, ?, 'direct')`,
      ).run(file, file).lastInsertRowid);
      return { importedIds: [id], failedFiles: [] };
    });
    let now = 0;
    const watcher = createMediaDirectoryWatcher({ db, mediaDir: dir, stableMs: 15_000, now: () => now, scan });

    await watcher.reconcileNow();
    now = 15_000;
    await watcher.reconcileNow();
    now = 30_000;
    await watcher.reconcileNow();

    expect(scan).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });
  });

  it('removes the row and its derived files when the source video disappears', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'Show - 05.mkv');
    fs.writeFileSync(file, 'video');
    const playable = path.join(dir, 'Show - 05.play.mp4');
    const extracted = path.join(dir, 'Show - 05.extracted.ass');
    fs.writeFileSync(playable, 'mp4');
    fs.writeFileSync(extracted, 'sub');
    const db = createDb(':memory:');
    const scan = successfulScan(db);
    let now = 0;
    const watcher = createMediaDirectoryWatcher({ db, mediaDir: dir, stableMs: 15_000, now: () => now, scan });

    await watcher.reconcileNow();
    now = 15_000;
    await watcher.reconcileNow();
    const row: any = db.prepare('SELECT id FROM media WHERE file_path=?').get(file);
    expect(row).toBeDefined();
    db.prepare(`INSERT INTO subtitle_file (media_id, file_path, format) VALUES (?, ?, 'ass')`).run(row.id, extracted);

    fs.rmSync(file);
    await watcher.reconcileNow();

    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM subtitle_file').get()).toEqual({ c: 0 });
    expect(fs.existsSync(playable)).toBe(false);
    expect(fs.existsSync(extracted)).toBe(false);
  });

  it('does not run overlapping scans when reconciliations arrive together', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'Show - 06.mp4');
    fs.writeFileSync(file, 'video');
    const db = createDb(':memory:');
    let running = 0;
    let maxRunning = 0;
    const scan = vi.fn(async (paths: string[]): Promise<ScanResult> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const importedIds = paths.map((filePath) => Number(db.prepare(
        `INSERT OR IGNORE INTO media (series, file_path, playable_path, codec_status) VALUES ('Show', ?, ?, 'direct')`,
      ).run(filePath, filePath).lastInsertRowid));
      running--;
      return { importedIds, failedFiles: [] };
    });
    let now = 0;
    const watcher = createMediaDirectoryWatcher({ db, mediaDir: dir, stableMs: 15_000, now: () => now, scan });

    await watcher.reconcileNow();
    now = 15_000;
    await Promise.all([
      watcher.reconcileNow(),
      watcher.reconcileNow(),
      watcher.reconcileNow(),
    ]);

    expect(maxRunning).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });
  });

  it('does not prune the library just because the media directory was absent at startup', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'media-watcher-')), 'unmounted');
    const db = createDb(':memory:');
    const stale = path.join(dir, 'Show - 07.mp4');
    db.prepare(`INSERT INTO media (series, file_path, codec_status) VALUES ('Show', ?, 'direct')`).run(stale);
    const scan = successfulScan(db);
    let now = 0;
    const watcher = createMediaDirectoryWatcher({ db, mediaDir: dir, stableMs: 0, now: () => now, scan });

    // 外付けドライブ未マウント: start() は空ディレクトリを作るが、掃除はしない
    await watcher.start();
    expect(fs.existsSync(dir)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });

    // マウントされてソースが見えたら、通常どおり掃除と取り込みを再開する
    fs.writeFileSync(path.join(dir, 'Show - 08.mp4'), 'video');
    now = 1;
    await watcher.reconcileNow();
    now = 2;
    await watcher.reconcileNow();
    watcher.stop();

    const files = (db.prepare('SELECT file_path FROM media ORDER BY file_path').all() as any[])
      .map((row) => path.basename(row.file_path));
    // マウント後は「ソースが 1 本も無い」状態ではないので、消えた行の掃除を再開してよい
    expect(files).toEqual(['Show - 08.mp4']);  });

  it('falls back to periodic reconciliation when the directory watcher fails', async () => {
    const dir = tmpDir();
    const db = createDb(':memory:');
    const fsWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    const log = { error: vi.fn() };
    const watcher = createMediaDirectoryWatcher({
      db,
      mediaDir: dir,
      watchFactory: vi.fn(() => fsWatcher as unknown as fs.FSWatcher),
      log,
    });

    await watcher.start();
    fsWatcher.emit('error', new Error('watch unavailable'));
    await watcher.reconcileNow();
    watcher.stop();

    expect(fsWatcher.close).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('media directory watcher failed; periodic reconciliation remains active');
  });

  it('starts periodic reconciliation when the operating system cannot create a watcher', async () => {
    const dir = tmpDir();
    const db = createDb(':memory:');
    const log = { error: vi.fn() };
    const watcher = createMediaDirectoryWatcher({
      db,
      mediaDir: dir,
      watchFactory: vi.fn(() => { throw new Error('watch unavailable'); }),
      log,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    await watcher.reconcileNow();
    watcher.stop();

    expect(log.error).toHaveBeenCalledWith('media directory watcher failed; periodic reconciliation remains active');
  });
});
