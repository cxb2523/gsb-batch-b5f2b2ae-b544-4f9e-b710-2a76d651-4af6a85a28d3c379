import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../../db.js';
import { parseFilename } from './filename.js';
import {
  decidePlayability, buildRemuxArgs, buildTranscodeArgs, buildExtractSubArgs, pickSubtitleStream,
  probeFile, runFfmpeg, type ProbeResult,
} from './ffmpeg.js';

export interface FfmpegOps {
  probe(file: string): Promise<ProbeResult>;
  remux(input: string, output: string): Promise<void>;
  transcode(input: string, output: string): Promise<void>;
  extractSub(input: string, streamIndex: number, output: string): Promise<void>;
}

export const realOps: FfmpegOps = {
  probe: probeFile,
  remux: (i, o) => runFfmpeg(buildRemuxArgs(i, o)),
  transcode: (i, o) => runFfmpeg(buildTranscodeArgs(i, o)),
  extractSub: (i, s, o) => runFfmpeg(buildExtractSubArgs(i, s, o)),
};

const VIDEO_EXT = new Set(['.mkv', '.mp4']);
const SUB_EXT = new Set(['.srt', '.ass']);
const PLAYBACK_COPY_RE = /\.play\.mp4$/i;
const EXTRACTED_SUB_RE = /\.extracted\.(?:srt|ass)$/i;
// 途中で落ちた ffmpeg の出力は最終パスではなく、隠しファイル `.partial.<name>` に書く。
// プロセスが中断しても最終パスに半製品が残らず、次回スキャンで必ず作り直せる。
const PARTIAL_PREFIX = '.partial.';

async function assertPlayableVideo(file: string, ops: FfmpegOps): Promise<void> {
  // 実在するだけでは足りない。中断した ffmpeg は 0 バイトの入れ物を残し得るので、
  // サイズと ffprobe の両方で「完全な再生副本」であることを確かめる。
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error('Playback copy is incomplete');
  }
  const probe = await ops.probe(file);
  if (!probe.streams.some((stream) => stream.codec_type === 'video')) {
    throw new Error('Playback copy has no video stream');
  }
}

export interface ScanResult {
  importedIds: number[];
  failedFiles: string[];
}

function findExternalSub(dir: string, videoBase: string): string | null {
  const entries = fs.readdirSync(dir);
  for (const e of entries) {
    const ext = path.extname(e).toLowerCase();
    if (!SUB_EXT.has(ext)) continue;
    // "Show - 02.ja.srt" は "Show - 02" にマッチ
    const subBase = e.slice(0, -ext.length).replace(/\.(ja|jpn|jp)$/i, '');
    if (subBase === videoBase) return path.join(dir, e);
  }
  return null;
}

export function listSourceVideos(mediaDir: string): string[] {
  const files: string[] = [];
  // ルートが存在しない（外付けドライブ未マウント等）場合は空を返す。ここで mkdir すると
  // 「空になった」と誤認して削除掃除が全行を消しかねないため、作成はしない。
  let stat: fs.Stats;
  try {
    stat = fs.statSync(mediaDir);
  } catch {
    return files;
  }
  if (!stat.isDirectory()) return files;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (
        entry.isFile()
        && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())
        && !PLAYBACK_COPY_RE.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };

  visit(mediaDir);
  return files;
}

// 既存の media 行を最新の parseFilename で解析し直し、変わった行だけ series/episode を更新する。
// 解析器を改善したとき、再スキャンで古いゴミ作品名（jimaku 検索が失敗する原因）を直すため。
export function reparseExistingMedia(db: Db): number {
  const rows = db.prepare('SELECT id, file_path, series, episode FROM media').all() as
    { id: number; file_path: string; series: string; episode: number | null }[];
  const update = db.prepare('UPDATE media SET series=?, episode=? WHERE id=?');
  let changed = 0;
  const apply = db.transaction(() => {
    for (const row of rows) {
      const { series, episode } = parseFilename(path.basename(row.file_path));
      if (series !== row.series || episode !== row.episode) {
        update.run(series, episode, row.id);
        changed++;
      }
    }
  });
  apply();
  return changed;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function partialPathFor(output: string): string {
  return path.join(path.dirname(output), `${PARTIAL_PREFIX}${path.basename(output)}`);
}

function removeIfPresent(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch { /* 後片付けの失敗は本処理を止めない */ }
}

// 変換は一時ファイルに対して行い、ffprobe で完全性を確認できたものだけを最終パスへ rename する。
// 途中で例外・プロセス中断が起きても、最終パスには完全な副本しか現れない。
async function renderPlaybackCopy(
  input: string,
  output: string,
  kind: 'remux' | 'transcode',
  ops: FfmpegOps,
): Promise<void> {
  const temp = partialPathFor(output);
  removeIfPresent(temp);
  try {
    if (kind === 'remux') await ops.remux(input, temp);
    else await ops.transcode(input, temp);
    await assertPlayableVideo(temp, ops);
    fs.renameSync(temp, output);
  } catch (error) {
    removeIfPresent(temp);
    throw error;
  }
}

async function scanFilesNow(
  db: Db,
  mediaDir: string,
  filePaths: string[],
  ops: FfmpegOps,
  platform: NodeJS.Platform,
): Promise<ScanResult> {
  reparseExistingMedia(db);
  const importedIds: number[] = [];
  const failedFiles: string[] = [];
  const root = path.resolve(mediaDir);

  for (const filePath of filePaths) {
    const full = path.resolve(filePath);
    const relative = path.relative(root, full);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const file = path.basename(full);
    if (!VIDEO_EXT.has(path.extname(file).toLowerCase())) continue;
    if (PLAYBACK_COPY_RE.test(file) || file.startsWith(PARTIAL_PREFIX)) continue; // 自前で生成した再生用ファイル
    const existing = db.prepare('SELECT id, codec_status, playable_path FROM media WHERE file_path=?').get(full) as
      { id: number; codec_status: string; playable_path: string | null } | undefined;
    if (existing && existing.codec_status !== 'transcode_needed') {
      if (existing.codec_status !== 'remuxed' && existing.codec_status !== 'transcoded') continue;
      try {
        if (!existing.playable_path) throw new Error('Playback copy is missing');
        await assertPlayableVideo(existing.playable_path, ops);
        continue;
      } catch { /* 无效副本会在下面重新生成 */ }
    }

    const ext = path.extname(file).toLowerCase();
    const { series, episode } = parseFilename(file);

    let probe: ProbeResult;
    try {
      probe = await ops.probe(full);
    } catch {
      failedFiles.push(full);
      continue;
    }

    const playability = decidePlayability(probe, ext, platform);
    let playablePath: string | null = null;
    let status: string = playability === 'direct' ? 'direct' : playability;

    if (playability === 'direct') {
      playablePath = full;
    } else if (playability === 'remux') {
      playablePath = full.replace(/\.[^.]+$/, '') + '.play.mp4';
      try {
        await renderPlaybackCopy(full, playablePath, 'remux', ops);
        status = 'remuxed';
      } catch {
        try {
          await renderPlaybackCopy(full, playablePath, 'transcode', ops);
          status = 'transcoded';
        } catch {
          playablePath = null;
          status = 'transcode_needed';
          failedFiles.push(full);
        }
      }
    }

    if (existing) {
      if (status === 'transcode_needed') {
        db.prepare('UPDATE media SET playable_path=NULL, codec_status=? WHERE id=?')
          .run(status, existing.id);
        continue;
      }
      db.prepare('UPDATE media SET playable_path=?, codec_status=? WHERE id=?')
        .run(playablePath, status, existing.id);
      importedIds.push(existing.id);
      continue;
    }

    const info = db.prepare(`INSERT INTO media (series, episode, file_path, playable_path, codec_status) VALUES (?,?,?,?,?)`)
      .run(series, episode, full, playablePath, status);
    const mediaId = info.lastInsertRowid as number;
    importedIds.push(Number(mediaId));

    // 字幕: 外部ファイル優先、なければ内蔵から抽出
    const videoBase = file.slice(0, -ext.length);
    const external = findExternalSub(path.dirname(full), videoBase);
    if (external) {
      const fmt = path.extname(external).slice(1).toLowerCase();
      db.prepare(`INSERT INTO subtitle_file (media_id, file_path, format) VALUES (?,?,?)`).run(mediaId, external, fmt);
    } else {
      const stream = pickSubtitleStream(probe);
      if (stream) {
        const fmt = stream.codec === 'subrip' || stream.codec === 'srt' ? 'srt' : 'ass';
        const out = full.replace(/\.[^.]+$/, '') + `.extracted.${fmt}`;
        const temp = partialPathFor(out);
        removeIfPresent(temp);
        try {
          await ops.extractSub(full, stream.index, temp);
          if (!fs.statSync(temp).isFile() || fs.statSync(temp).size === 0) {
            throw new Error('Extracted subtitle is incomplete');
          }
          fs.renameSync(temp, out);
          db.prepare(`INSERT INTO subtitle_file (media_id, file_path, format) VALUES (?,?,?)`).run(mediaId, out, fmt);
        } catch { /* 字幕なし。再生ページ側で案内 */ }
        removeIfPresent(temp);
      }
    }
  }

  return { importedIds, failedFiles };
}

// 削除されたソース動画の行と、そこから派生した再生副本・抽出字幕を片付ける。
// 外部字幕（ユーザーが置いた .ja.srt など）は消さない。1 ファイルの失敗は他へ波及させない。
//
// 安全弁: ルートやソースの親ディレクトリが無い行は「外付けドライブ未マウント」とみなして
// 触らない。ファイル 1 本だけ消した場合は親ディレクトリが残るので、通常どおり掃除される。
export function pruneMissingMedia(db: Db, mediaDir: string): number[] {
  const root = path.resolve(mediaDir);
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const rows = db.prepare('SELECT id, file_path, playable_path FROM media').all() as
    { id: number; file_path: string; playable_path: string | null }[];
  const removed: number[] = [];
  const selectSubs = db.prepare('SELECT file_path FROM subtitle_file WHERE media_id=?');
  const removeRow = db.transaction((mediaId: number) => {
    db.prepare('DELETE FROM subtitle_file WHERE media_id=?').run(mediaId);
    db.prepare('DELETE FROM subtitle_sync_state WHERE media_id=?').run(mediaId);
    db.prepare('DELETE FROM progress WHERE media_id=?').run(mediaId);
    // 生词本はユーザーの学習資産なので消さない。media への外部キーだけ外して
    // 出典不明の語として残す（FK 制約で削除が失敗しないようにする）。
    db.prepare('UPDATE vocab SET media_id=NULL WHERE media_id=?').run(mediaId);
    db.prepare('DELETE FROM media WHERE id=?').run(mediaId);
  });

  for (const row of rows) {
    if (!isPathInside(root, row.file_path)) continue;
    if (fs.existsSync(row.file_path)) continue;
    // 親ディレクトリごと消えている = 外付けドライブが外れた可能性が高いので保留する。
    // 個別ファイルの削除なら親は残る。
    try {
      if (!fs.statSync(path.dirname(row.file_path)).isDirectory()) continue;
    } catch {
      continue;
    }

    const derived = new Set<string>();
    if (row.playable_path && row.playable_path !== row.file_path
      && PLAYBACK_COPY_RE.test(row.playable_path) && isPathInside(root, row.playable_path)) {
      derived.add(row.playable_path);
    }
    // DB に残っていない半製品も、命名規則から辿って掃除する。
    const base = row.file_path.replace(/\.[^.]+$/, '');
    derived.add(`${base}.play.mp4`);
    derived.add(`${base}.extracted.srt`);
    derived.add(`${base}.extracted.ass`);
    for (const sub of selectSubs.all(row.id) as { file_path: string }[]) {
      if (EXTRACTED_SUB_RE.test(sub.file_path) && isPathInside(root, sub.file_path)) {
        derived.add(sub.file_path);
      }
    }

    for (const file of derived) {
      if (!isPathInside(root, file)) continue;
      try {
        fs.rmSync(file, { force: true });
        fs.rmSync(partialPathFor(file), { force: true });
      } catch { /* 清掃失敗は他のファイルの取り込みを止めない */ }
    }

    try {
      removeRow(row.id);
      removed.push(row.id);
    } catch { /* 行削除に失敗したら次回スキャンで再試行 */ }
  }
  return removed;
}

interface ScanRequest {
  all: boolean;
  prune: boolean;
  filePaths: string[];
  ops: FfmpegOps;
  platform: NodeJS.Platform;
}
interface ScanWaiter {
  resolve: (value: ScanResult) => void;
  reject: (reason: unknown) => void;
}

interface ScanBatch {
  all: boolean;
  prune: boolean;
  files: Set<string>;
  ops: FfmpegOps;
  platform: NodeJS.Platform;
  waiters: ScanWaiter[];
}

// 同一 DB・同一ディレクトリのスキャンは常に 1 本だけ走らせる。
// 実行中に来た要求は 1 回分の補掃にまとめ、ffmpeg を並列で走らせない。
class SerialScanner {
  private active: ScanBatch | null = null;
  private queued: ScanBatch | null = null;

  constructor(private readonly db: Db, private readonly mediaDir: string) {}

  submit(request: ScanRequest): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const waiter: ScanWaiter = { resolve, reject };
      if (!this.active) {
        const batch = this.newBatch(request);
        batch.waiters.push(waiter);
        this.active = batch;
        void this.runBatch(batch);
        return;
      }
      const batch = this.queued ?? (this.queued = this.newBatch(request));
      if (request.all) batch.all = true;
      if (request.prune) batch.prune = true;
      for (const file of request.filePaths) batch.files.add(path.resolve(file));
      batch.waiters.push(waiter);
    });
  }

  private newBatch(request: ScanRequest): ScanBatch {
    return {
      all: request.all,
      prune: request.prune,
      files: new Set(request.filePaths.map((file) => path.resolve(file))),
      ops: request.ops,
      platform: request.platform,
      waiters: [],
    };
  }

  private async runBatch(batch: ScanBatch): Promise<void> {
    let result: ScanResult | null = null;
    let failure: unknown = null;
    try {
      if (batch.all) {
        result = await scanFilesNow(this.db, this.mediaDir, listSourceVideos(this.mediaDir), batch.ops, batch.platform);
      } else {
        result = await scanFilesNow(this.db, this.mediaDir, [...batch.files], batch.ops, batch.platform);
      }
    } catch (error) {
      failure = error;
    }

    // 掃除は取り込みの成否と切り離す。失敗しても他のファイルの導入結果は返す。
    if (batch.prune) {
      try {
        pruneMissingMedia(this.db, this.mediaDir);
      } catch {
        /* 次回スキャンで再試行 */
      }
    }

    // 待機中の要求を同期的に昇格させ、その後で結果を返す（合間に新しい要求が割り込まない）。
    this.active = null;
    const next = this.queued;
    this.queued = null;
    if (next) {
      this.active = next;
      void this.runBatch(next);
    }
    for (const waiter of batch.waiters) {
      if (failure) waiter.reject(failure);
      else waiter.resolve(result!);
    }
  }
}

const scannersByDb = new WeakMap<Db, Map<string, SerialScanner>>();

function scannerFor(db: Db, mediaDir: string): SerialScanner {
  let byDirectory = scannersByDb.get(db);
  if (!byDirectory) {
    byDirectory = new Map();
    scannersByDb.set(db, byDirectory);
  }
  const key = path.resolve(mediaDir);
  let scanner = byDirectory.get(key);
  if (!scanner) {
    scanner = new SerialScanner(db, key);
    byDirectory.set(key, scanner);
  }
  return scanner;
}

// 指定ファイルだけを走査する（watcher 用）。同一ディレクトリで実行中の走査があれば、
// その完了後に 1 回の補掃へまとめて合流する。
export async function scanFiles(
  db: Db,
  mediaDir: string,
  filePaths: string[],
  ops: FfmpegOps = realOps,
  platform: NodeJS.Platform = process.platform,
): Promise<ScanResult> {
  return scannerFor(db, mediaDir).submit({ all: false, prune: false, filePaths, ops, platform });
}

// ディレクトリ全体を走査する（手動スキャン用）。実行中の走査には並行せず合流する。
// 全走査では、削除済みソースの行と派生ファイルも併せて片付ける。
export async function scanLibrary(
  db: Db,
  mediaDir: string,
  ops: FfmpegOps = realOps,
  platform: NodeJS.Platform = process.platform,
): Promise<ScanResult> {
  return scannerFor(db, mediaDir).submit({ all: true, prune: true, filePaths: [], ops, platform });
}
