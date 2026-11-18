import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db.js';
import {
  scanFiles, scanLibrary, pruneMissingMedia, reparseExistingMedia, type FfmpegOps,
} from '../src/modules/media/scanner.js';

function tmpLib(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

const fakeOps: FfmpegOps = {
  probe: async () => ({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'jpn' } },
    ],
  }),
  remux: async (_i, out) => { fs.writeFileSync(out, 'mp4'); },
  transcode: async (_i, out) => { fs.writeFileSync(out, 'mp4'); },
  extractSub: async (_i, _s, out) => { fs.writeFileSync(out, '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'); },
};

describe('scanLibrary', () => {
  it('imports mkv: remuxes, extracts subs, records rows', async () => {
    const dir = tmpLib(['[SubsPlease] Test Show - 01 (1080p).mkv']);
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);

    const media: any = db.prepare('SELECT * FROM media').get();
    expect(media.series).toBe('Test Show');
    expect(media.episode).toBe(1);
    expect(media.codec_status).toBe('remuxed');
    expect(fs.existsSync(media.playable_path)).toBe(true);

    const sub: any = db.prepare('SELECT * FROM subtitle_file WHERE media_id=?').get(media.id);
    expect(sub.format).toBe('ass');
  });

  it('is idempotent (second scan adds nothing)', async () => {
    const dir = tmpLib(['[SubsPlease] Test Show - 01 (1080p).mkv']);
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);
    await scanLibrary(db, dir, fakeOps);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });
  });

  it('rebuilds an existing corrupted playback copy', async () => {
    const dir = tmpLib(['Show - 01.mkv']);
    const file = path.join(dir, 'Show - 01.mkv');
    const playable = path.join(dir, 'Show - 01.play.mp4');
    fs.writeFileSync(playable, 'corrupt');
    const db = createDb(':memory:');
    const id = Number(db.prepare(`
      INSERT INTO media (series, episode, file_path, playable_path, codec_status)
      VALUES ('Show', 1, ?, ?, 'remuxed')
    `).run(file, playable).lastInsertRowid);
    const repairingOps: FfmpegOps = {
      ...fakeOps,
      probe: async (candidate) => {
        if (candidate === playable && fs.readFileSync(candidate, 'utf8') === 'corrupt') {
          throw new Error('invalid playback copy');
        }
        return fakeOps.probe(candidate);
      },
    };

    const result = await scanLibrary(db, dir, repairingOps);

    expect(result.importedIds).toEqual([id]);
    expect(fs.readFileSync(playable, 'utf8')).toBe('mp4');
  });

  it('falls back to H.264 when the remuxed video cannot be probed', async () => {
    const dir = tmpLib(['Show - 06.mkv']);
    const db = createDb(':memory:');
    let outputState = 'none';
    let remuxCalls = 0;
    let transcodeCalls = 0;
    const fallbackOps: FfmpegOps = {
      ...fakeOps,
      probe: async (file) => {
        if (file.endsWith('.play.mp4') && outputState === 'remuxed') {
          throw new Error('invalid remux');
        }
        return fakeOps.probe(file);
      },
      remux: async (_input, output) => {
        remuxCalls++;
        outputState = 'remuxed';
        fs.writeFileSync(output, 'broken remux');
      },
      transcode: async (_input, output) => {
        transcodeCalls++;
        outputState = 'transcoded';
        fs.writeFileSync(output, 'h264');
      },
    };

    await scanLibrary(db, dir, fallbackOps);

    const media: any = db.prepare('SELECT * FROM media').get();
    expect(media.codec_status).toBe('transcoded');
    expect(remuxCalls).toBe(1);
    expect(transcodeCalls).toBe(1);
  });

  it('prefers external .srt/.ass file over embedded', async () => {
    const dir = tmpLib(['Show - 02.mkv', 'Show - 02.ja.srt']);
    fs.writeFileSync(path.join(dir, 'Show - 02.ja.srt'), '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n');
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);
    const sub: any = db.prepare('SELECT * FROM subtitle_file').get();
    expect(sub.format).toBe('srt');
    expect(sub.file_path.endsWith('.srt')).toBe(true);
  });

  it('recursively imports a season folder and finds its same-directory subtitle', async () => {
    const dir = tmpLib([]);
    const seasonDir = path.join(dir, 'Show Season 1');
    fs.mkdirSync(seasonDir);
    fs.writeFileSync(path.join(seasonDir, 'Show - 01.mkv'), 'video');
    fs.writeFileSync(path.join(seasonDir, 'Show - 01.ja.srt'), 'subtitle');
    const db = createDb(':memory:');

    await scanLibrary(db, dir, fakeOps);

    const media: any = db.prepare('SELECT * FROM media').get();
    expect(media.file_path).toBe(path.join(seasonDir, 'Show - 01.mkv'));
    const sub: any = db.prepare('SELECT * FROM subtitle_file').get();
    expect(sub.file_path).toBe(path.join(seasonDir, 'Show - 01.ja.srt'));
  });

  it('remuxes hevc without re-encoding video', async () => {
    const dir = tmpLib(['Show - 03.mkv']);
    const db = createDb(':memory:');
    const hevcOps: FfmpegOps = {
      ...fakeOps,
      probe: async () => ({
        streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le' }],
      }),
    };
    await scanLibrary(db, dir, hevcOps, 'darwin');
    const media: any = db.prepare('SELECT * FROM media').get();
    expect(media.codec_status).toBe('remuxed');
    expect(fs.existsSync(media.playable_path)).toBe(true);
  });

  it('repairs an existing transcode_needed row when the codec becomes remuxable', async () => {
    const dir = tmpLib(['Show - 04.mkv']);
    const file = path.join(dir, 'Show - 04.mkv');
    const db = createDb(':memory:');
    const id = Number(db.prepare(`
      INSERT INTO media (series, episode, file_path, codec_status)
      VALUES ('Show', 4, ?, 'transcode_needed')
    `).run(file).lastInsertRowid);
    const hevcOps: FfmpegOps = {
      ...fakeOps,
      probe: async () => ({
        streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le' }],
      }),
    };

    const result = await scanLibrary(db, dir, hevcOps, 'darwin');

    expect(result.importedIds).toEqual([id]);
    const media: any = db.prepare('SELECT * FROM media WHERE id=?').get(id);
    expect(media.codec_status).toBe('remuxed');
    expect(fs.existsSync(media.playable_path)).toBe(true);
  });

  it('keeps hevc marked as needing conversion on Windows', async () => {
    const dir = tmpLib(['Show - 05.mkv']);
    const db = createDb(':memory:');
    const hevcOps: FfmpegOps = {
      ...fakeOps,
      probe: async () => ({
        streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le' }],
      }),
    };

    await scanLibrary(db, dir, hevcOps, 'win32');

    const media: any = db.prepare('SELECT * FROM media').get();
    expect(media.codec_status).toBe('transcode_needed');
    expect(media.playable_path).toBeNull();
  });

  it('does not record probe failures and can import the file on retry', async () => {
    const dir = tmpLib(['Show - 04.mkv']);
    const db = createDb(':memory:');
    let fail = true;
    const retryOps: FfmpegOps = {
      ...fakeOps,
      probe: async (file) => {
        if (fail) throw new Error(`incomplete: ${file}`);
        return fakeOps.probe(file);
      },
    };

    const first = await scanLibrary(db, dir, retryOps);
    expect(first.importedIds).toEqual([]);
    expect(first.failedFiles).toEqual([path.join(dir, 'Show - 04.mkv')]);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 0 });

    fail = false;
    const second = await scanLibrary(db, dir, retryOps);
    expect(second.importedIds).toHaveLength(1);
    expect(second.failedFiles).toEqual([]);
  });
});

describe('concurrent scanning', () => {
  function trackedOps(delayMs = 0) {
    const state = { remux: 0, transcode: 0, active: 0, maxActive: 0 };
    const gate = (fn: () => void) => async () => {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        fn();
      } finally {
        state.active--;
      }
    };
    const ops: FfmpegOps = {
      probe: async () => fakeOps.probe(''),
      remux: async (_i, out) => { state.remux++; await gate(() => fs.writeFileSync(out, 'mp4'))(); },
      transcode: async (_i, out) => { state.transcode++; await gate(() => fs.writeFileSync(out, 'mp4'))(); },
      extractSub: async (_i, _s, out) => { fs.writeFileSync(out, 'sub'); },
    };
    return { ops, state };
  }

  it('serializes overlapping scans of the same directory and imports each file once', async () => {
    const dir = tmpLib(['Show - 01.mkv', 'Show - 02.mkv']);
    const db = createDb(':memory:');
    const { ops, state } = trackedOps(5);

    const [first, second, third] = await Promise.all([
      scanLibrary(db, dir, ops),
      scanLibrary(db, dir, ops),
      scanFiles(db, dir, [path.join(dir, 'Show - 01.mkv')], ops),
    ]);

    expect(state.maxActive).toBe(1);
    expect(state.remux).toBe(2); // 各話 1 回ずつ。並行要求が ffmpeg を重複実行しない
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 2 });
    expect(new Set([...first.importedIds, ...second.importedIds, ...third.importedIds]).size).toBe(2);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.partial.'))).toEqual([]);
  });

  it('merges later requests into a single follow-up scan instead of running them in parallel', async () => {
    const dir = tmpLib(['Show - 01.mkv', 'Show - 02.mkv']);
    const db = createDb(':memory:');
    let probed = 0;
    const ops: FfmpegOps = {
      ...fakeOps,
      // ソース本体の probe 回数 = 走査パスの回数（副本の再検証は数えない）
      probe: async (file) => { if (!file.endsWith('.play.mp4')) probed++; return fakeOps.probe(file); },
    };

    const running = scanLibrary(db, dir, ops); // 先に 1 本走らせる
    const pending = Array.from({ length: 5 }, () => scanLibrary(db, dir, ops));
    const [, ...pendingResults] = await Promise.all([running, ...pending]);

    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 2 });
    expect(pendingResults.every((r) => r.importedIds.length === 0)).toBe(true);
    // 最初の全走査 + 合流した補掃の 1 回まで。5 本が個別に走らない。
    expect(probed).toBeLessThanOrEqual(4);
  });
});

describe('incomplete playback copies', () => {
  it('rebuilds when the recorded copy is an empty file left by an interrupted ffmpeg', async () => {
    const dir = tmpLib(['Show - 11.mkv']);
    const file = path.join(dir, 'Show - 11.mkv');
    const playable = path.join(dir, 'Show - 11.play.mp4');
    fs.writeFileSync(playable, '');
    const db = createDb(':memory:');
    const id = Number(db.prepare(`
      INSERT INTO media (series, episode, file_path, playable_path, codec_status)
      VALUES ('Show', 11, ?, ?, 'remuxed')
    `).run(file, playable).lastInsertRowid);

    await scanLibrary(db, dir, fakeOps);

    const media: any = db.prepare('SELECT * FROM media WHERE id=?').get(id);
    expect(media.codec_status).toBe('remuxed');
    expect(fs.readFileSync(playable, 'utf8')).toBe('mp4');
  });

  it('does not publish a half-written copy when ffmpeg fails midway, and retries next scan', async () => {
    const dir = tmpLib(['Show - 12.mkv']);
    const db = createDb(':memory:');
    let fail = true;
    const flakyOps: FfmpegOps = {
      ...fakeOps,
      remux: async (_i, out) => {
        fs.writeFileSync(out, 'half'); // ffmpeg が途中で落ちた状態を模擬
        if (fail) throw new Error('ffmpeg died');
      },
      transcode: async (_i, out) => {
        fs.writeFileSync(out, 'half');
        if (fail) throw new Error('ffmpeg died');
      },
    };

    const first = await scanLibrary(db, dir, flakyOps);
    expect(first.failedFiles).toEqual([path.join(dir, 'Show - 12.mkv')]);
    expect(fs.existsSync(path.join(dir, 'Show - 12.play.mp4'))).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.partial.'))).toEqual([]);
    const row: any = db.prepare('SELECT codec_status, playable_path FROM media').get();
    expect(row).toMatchObject({ codec_status: 'transcode_needed', playable_path: null });

    fail = false;
    const second = await scanLibrary(db, dir, flakyOps);
    expect(second.failedFiles).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'Show - 12.play.mp4'), 'utf8')).toBe('half');
  });

  it('ignores a partial output left in the media directory by a previous crash', async () => {
    const dir = tmpLib(['Show - 13.mkv', '.partial.Show - 13.play.mp4']);
    const db = createDb(':memory:');

    await scanLibrary(db, dir, fakeOps);

    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });
  });
});

describe('pruneMissingMedia', () => {
  it('removes the row and its derived playback copy and extracted subtitle', async () => {
    const dir = tmpLib([]);
    const file = path.join(dir, 'Show - 21.mkv');
    fs.writeFileSync(file, 'video');
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);
    const media: any = db.prepare('SELECT * FROM media').get();
    const sub: any = db.prepare('SELECT * FROM subtitle_file WHERE media_id=?').get(media.id);
    expect(fs.existsSync(media.playable_path)).toBe(true);
    expect(fs.existsSync(sub.file_path)).toBe(true);

    fs.rmSync(file);
    const removed = pruneMissingMedia(db, dir);

    expect(removed).toEqual([media.id]);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM subtitle_file').get()).toEqual({ c: 0 });
    expect(fs.existsSync(media.playable_path)).toBe(false);
    expect(fs.existsSync(sub.file_path)).toBe(false);
  });

  it('keeps user-supplied external subtitles and files still present', async () => {
    const dir = tmpLib(['Show - 22.mkv', 'Show - 22.ja.srt']);
    fs.writeFileSync(path.join(dir, 'Show - 22.ja.srt'), '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n');
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);
    const file = path.join(dir, 'Show - 22.mkv');

    fs.rmSync(file);
    pruneMissingMedia(db, dir);

    expect(fs.existsSync(path.join(dir, 'Show - 22.ja.srt'))).toBe(true);
  });

  it('keeps collected vocabulary when its source video is removed', async () => {
    const dir = tmpLib(['Show - 24.mp4']);
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);
    const media: any = db.prepare('SELECT * FROM media').get();
    db.prepare(`INSERT INTO vocab (kind, word, sentence, media_id) VALUES ('word', 'テスト', 'テストです', ?)`).run(media.id);

    fs.rmSync(path.join(dir, 'Show - 24.mp4'));
    const removed = pruneMissingMedia(db, dir);

    expect(removed).toEqual([media.id]);
    const vocab: any = db.prepare('SELECT word, media_id FROM vocab').get();
    expect(vocab).toEqual({ word: 'テスト', media_id: null });
  });

  it('keeps rows whose parent directory disappeared, as an unmounted drive would', async () => {
    const dir = tmpLib([]);
    const seasonDir = path.join(dir, 'Show Season 1');
    fs.mkdirSync(seasonDir);
    const file = path.join(seasonDir, 'Show - 25.mp4');
    fs.writeFileSync(file, 'video');
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);

    fs.rmSync(seasonDir, { recursive: true, force: true });

    expect(pruneMissingMedia(db, dir)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });
  });

  it('does not block other imports when cleaning one file fails', async () => {
    const dir = tmpLib([]);
    const gone = path.join(dir, 'Gone - 01.mkv');
    fs.writeFileSync(gone, 'video');
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);
    const goneRow: any = db.prepare('SELECT * FROM media WHERE file_path=?').get(gone);
    expect(fs.existsSync(goneRow.playable_path)).toBe(true);

    fs.rmSync(gone);
    // 派生副本の削除を失敗させる: ディレクトリを置くと rmSync({force:true}) は
    // 再帰削除しないためエラーになる（Windows/Unix 共通の EISDIR 相当）。
    fs.rmSync(goneRow.playable_path);
    fs.mkdirSync(goneRow.playable_path);

    fs.writeFileSync(path.join(dir, 'New - 01.mkv'), 'video');
    const result = await scanLibrary(db, dir, fakeOps);

    expect(result.importedIds).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) c FROM media WHERE file_path=?').get(gone)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM media WHERE file_path=?')
      .get(path.join(dir, 'New - 01.mkv'))).toEqual({ c: 1 });
    // 清掃は実際に失敗している（それでも行削除と他ファイルの導入は完了する）
    expect(fs.statSync(goneRow.playable_path).isDirectory()).toBe(true);
  });

  it('leaves rows pointing outside the media directory alone', () => {
    const dir = tmpLib([]);
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')), 'x.mkv');
    const db = createDb(':memory:');
    db.prepare(`INSERT INTO media (series, file_path, codec_status) VALUES ('X', ?, 'direct')`).run(outside);

    expect(pruneMissingMedia(db, dir)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });
  });

  it('does not wipe the library when the media directory itself is unavailable', async () => {
    const dir = tmpLib([]);
    const file = path.join(dir, 'Show - 23.mp4');
    fs.writeFileSync(file, 'video');
    const db = createDb(':memory:');
    await scanLibrary(db, dir, fakeOps);
    const row: any = db.prepare('SELECT * FROM media').get();

    // 外付けドライブが外れた状態を模擬（ディレクトリごと消える）
    fs.rmSync(dir, { recursive: true, force: true });

    expect(pruneMissingMedia(db, dir)).toEqual([]);
    const scanResult = await scanLibrary(db, dir, fakeOps);
    expect(scanResult.importedIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM media').get()).toEqual({ c: 1 });
    expect(fs.existsSync(dir)).toBe(false); // スキャンが勝手に空ディレクトリを作らない
    expect(row.codec_status).toBe('direct');
  });
});

describe('reparseExistingMedia', () => {  it('re-parses stored rows with the improved parser and reports changes', () => {
    const db = createDb(':memory:');
    // 旧パーサが残した「ゴミ作品名 + episode null」を模擬
    db.prepare(`INSERT INTO media (series, episode, file_path, codec_status) VALUES (?,?,?,?)`).run(
      'Mushoku.Tensei.Jobless.Reincarnation.S02E01.The.Depressed.Magician.1080p.AMZN.WEB-DL.DDP2.0.H.264-VARYG',
      null,
      '/lib/Mushoku.Tensei.Jobless.Reincarnation.S02E01.The.Depressed.Magician.1080p.AMZN.WEB-DL.DDP2.0.H.264-VARYG.mkv',
      'remuxed',
    );
    // すでに正しく解析済みの行は変更されない
    db.prepare(`INSERT INTO media (series, episode, file_path, codec_status) VALUES (?,?,?,?)`).run(
      'Sousou no Frieren', 1, '/lib/Sousou no Frieren - 01 [1080p].mkv', 'direct',
    );

    const changed = reparseExistingMedia(db);
    expect(changed).toBe(1);

    const rows = db.prepare('SELECT series, episode FROM media ORDER BY id').all() as any[];
    expect(rows[0]).toEqual({ series: 'Mushoku Tensei Jobless Reincarnation', episode: 1 });
    expect(rows[1]).toEqual({ series: 'Sousou no Frieren', episode: 1 });
  });
});
