import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { constants } from 'node:fs';
import { access, open, mkdir, copyFile, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import type { Game } from './game.js';
import type { SharedJpeg } from './vision.js';
import type { RecordingInfo } from '../shared/recording.js';
import { RULES, type Side } from '../shared/protocol.js';
import { VISION_HZ, type VisionConfig } from '../shared/vision.js';
export type { RecordingInfo } from '../shared/recording.js';

export function ffmpegPath() {
  const source = import.meta.url.replaceAll('\\', '/').includes('/src/host/');
  return fileURLToPath(new URL(source ? '../../node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe' : './ffmpeg.exe', import.meta.url));
}

const FPS = VISION_HZ, STEPS = RULES.tickHz / FPS, WIDTH = RULES.width, HEIGHT = RULES.height + 80;
const MAX_PENDING = 32, MAX_PENDING_BYTES = 16 * 1024 * 1024;
type IndexEntry = Omit<SharedJpeg, 'bytes' | 'matchId'> & { offset: number; size: number };
type RecordData = ReturnType<Game['refereeRecord']>;
type Repeat = 'gap' | 'end';
type VideoSample = { step: number; source: IndexEntry; repeat?: Repeat };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const shanghaiClock = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function recordingStem(startedAt: Date) {
  const p=Object.fromEntries(shanghaiClock.formatToParts(startedAt).map(part=>[part.type,part.value]));
  return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`;
}
async function exists(filename: string) {
  try { await access(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return false; throw error; }
}

async function writeAll(file: FileHandle, data: Buffer) {
  for (let written = 0; written < data.length;) {
    const { bytesWritten } = await file.write(data, written, data.length - written, null);
    if (!bytesWritten) throw Error('磁盘写入未推进');
    written += bytesWritten;
  }
}

export class MatchRecorder {
  #info: RecordingInfo = { enabled: false, status: 'off' };
  #source?: FileHandle;
  #indexFile?: FileHandle;
  #index: IndexEntry[] = [];
  #queue = Promise.resolve();
  #pending = 0;
  #pendingBytes = 0;
  #lastFrame = 0;
  #sourceBytes = 0;
  #indexBytes = 0;
  #captureMs = 0;
  #diskWriteMs = 0;
  #maxPending = 0;
  #maxPendingBytes = 0;
  #finish?: Promise<void>;
  #ownedVideoPartial?: string;
  #child?: ReturnType<typeof spawn>;
  #config?: VisionConfig;
  #base?: string;

  constructor(readonly directory: string, private readonly executable = ffmpegPath()) {}

  get finishing() { return this.#finish !== undefined; }
  get failed() { return this.#info.status === 'error'; }

  info(): RecordingInfo {
    return { ...this.#info, maxPendingFrames: this.#maxPending, captureCpuMs: this.#captureMs,
      jpegFrames: this.#index.length, sourceBytes: this.#sourceBytes, indexBytes: this.#indexBytes,
      maxPendingBytes: this.#maxPendingBytes, diskWriteMs: this.#diskWriteMs };
  }

  async start(matchId: string, config: VisionConfig, startedAt = new Date()) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(matchId) || this.#info.enabled) throw Error('录制标识无效');
    this.#config = { ...config };
    this.#info = { enabled: true, status: 'recording', matchId, startedAt:startedAt.toISOString(), fps: FPS, width: WIDTH, height: HEIGHT };
    try {
      await mkdir(this.directory, { recursive: true });
      const base=await this.reserve(recordingStem(startedAt));
      this.#indexFile = await open(`${base}.jpeg-index.ndjson.partial`, 'wx');
      this.#info.indexPath = `${base}.jpeg-index.ndjson.partial`;
      await this.appendIndex({ schemaVersion: 1, matchId, config: this.#config, tickHz: RULES.tickHz });
    } catch (error) {
      this.fail(`录制文件无法打开：${message(error)}`);
      await this.closeInputs();
    }
  }

  private async reserve(stem: string) {
    for (let number=1;number<=9999;number++) {
      const name=number===1?stem:`${stem}_${number}`, base=path.join(this.directory,name);
      const sourcePath=`${base}.mjpeg.partial`;
      let source:FileHandle;
      try {source=await open(sourcePath,'wx');}
      catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')continue;throw error;}
      let available=false;
      try {
        available=!(await Promise.all(['.mp4','.json','.mp4.partial','.jpeg-index.ndjson.partial'].map(ext=>exists(base+ext)))).some(Boolean);
      } finally {
        if (!available) {await source.close();await unlink(sourcePath);}
      }
      if (!available) continue;
      this.#source=source;
      this.#info.sourcePath=sourcePath;
      this.#info.recordingName=`${name}.mp4`;
      return this.#base=base;
    }
    throw Error('同一秒的录像文件名已用尽');
  }

  beginSaving() {
    if (this.#info.status === 'recording') this.#info.status = 'saving';
  }

  capture(frame: SharedJpeg) {
    if (this.#finish || !this.#source || !this.#indexFile || this.#info.status === 'error' || frame.matchId !== this.#info.matchId || frame.frameId <= this.#lastFrame) return;
    const started = performance.now();
    const { bytes, matchId: _matchId, ...stamp } = frame;
    if (this.#pending >= MAX_PENDING || this.#pendingBytes + bytes.length > MAX_PENDING_BYTES) {
      this.fail('录像磁盘写入积压超过上限，已停止保存 JPEG');
      return;
    }
    this.#lastFrame = frame.frameId;
    this.#pending++;
    this.#pendingBytes += bytes.length;
    this.#maxPending = Math.max(this.#maxPending, this.#pending);
    this.#maxPendingBytes = Math.max(this.#maxPendingBytes, this.#pendingBytes);
    this.#queue = this.#queue.then(async () => {
      if (this.#info.status === 'error') return;
      const before = performance.now();
      const entry = { ...stamp, offset: this.#sourceBytes, size: bytes.length };
      await writeAll(this.#source!, bytes);
      await this.appendIndex(entry);
      this.#index.push(entry);
      this.#sourceBytes += bytes.length;
      this.#diskWriteMs += performance.now() - before;
    }).catch(error => this.fail(`录像磁盘写入失败：${message(error)}`)).finally(() => {
      this.#pending--;
      this.#pendingBytes -= bytes.length;
    });
    this.#captureMs += performance.now() - started;
  }

  fail(error: string) {
    if (this.#info.status === 'recording' || this.#info.status === 'saving') {
      this.#info.status = 'error';
      this.#info.error = error;
    }
  }

  private async appendIndex(value: object) {
    const line = Buffer.from(JSON.stringify(value) + '\n');
    await writeAll(this.#indexFile!, line);
    this.#indexBytes += line.length;
  }

  private async closeInputs() {
    const files = [this.#source, this.#indexFile];
    this.#source = this.#indexFile = undefined;
    for (const file of files) {
      try { await file?.close(); } catch (error) { this.fail(`录制文件关闭失败：${message(error)}`); }
    }
  }

  finish(record: RecordData) {
    this.beginSaving();
    return this.#finish ??= this.save(record);
  }

  private timeline(finalStep: number): VideoSample[] {
    const final = this.#index.at(-1);
    if (!final || final.step !== finalStep || !['ended','stopped'].includes(final.status)) throw Error('缺少共享通道的结算 JPEG');
    if (finalStep > 0 && this.#index.length === 1) throw Error('没有可用的比赛 JPEG');
    const frames: VideoSample[] = [];
    let source = 0, previousId = -1;
    for (let step = 0; step < finalStep; step += STEPS) {
      // Attribute a sampled boundary to its 30 Hz slot even if the pump ran
      // one control boundary late. The final JPEG has its own output slot.
      while (source + 1 < this.#index.length - 1 && this.#index[source + 1].step < step + STEPS) source++;
      const entry = this.#index[source];
      frames.push({ step, source: entry, repeat: entry.step >= step + STEPS || previousId === entry.frameId ? 'gap' : undefined });
      previousId = entry.frameId;
    }
    frames.push({ step: finalStep, source: final });
    for (let i = 0; i < FPS; i++) frames.push({ step: finalStep, source: final, repeat: 'end' });
    return frames;
  }

  private async save(record: RecordData) {
    await this.#queue;
    await this.closeInputs();
    const base = this.#base;
    if (!base) return;
    let timeline: VideoSample[] = [];
    if (this.#info.status !== 'error') {
      const started = performance.now();
      try {
        timeline = this.timeline(record.finalStep);
        await this.transcode(timeline, base);
        this.#info.frames = timeline.length;
      } catch (error) { this.fail(`MP4 转码失败：${message(error)}`); }
      this.#info.transcodeMs = performance.now() - started;
    }
    await this.removeVideoPartial();
    const mapping = timeline.map(({ step, source, repeat }, frame) => {
      const tick = Math.min(record.finalTick, Math.max(0, step - RULES.preparationMs * RULES.tickHz / 1000));
      return { frame, videoTimeMs: frame * 1000 / FPS, step, tick, gameTimeMs: tick * 1000 / RULES.tickHz,
        countdownMs: step === record.finalStep ? source.countdownMs : Math.max(0, RULES.preparationMs - step * 1000 / RULES.tickHz),
        status: source.status, sourceStep: source.step, frameId: source.frameId, hold: repeat !== undefined, repeat };
    });
    const finalStats = Object.fromEntries((['red','blue'] as Side[]).map(side => {
      const robot = record.finalState.robots[side];
      return [side,{hp:robot.hp,shots:robot.shots,hits:robot.hits,hitRate:robot.shots ? robot.hits / robot.shots : 0}];
    }));
    const success = this.#info.status !== 'error';
    const data = { ...record, finalStats, recording: {
      schemaVersion: 2, matchId: record.matchId, startedAt:this.#info.startedAt, videoFile: this.#info.videoPath ? path.basename(this.#info.videoPath) : null,
      dataFile: path.basename(`${base}.json`), codec: 'H.264', container: 'MP4', pixelFormat: 'yuv420p',
      fps: FPS, width: WIDTH, height: HEIGHT, audio: false, source: 'shared-mjpeg', sourceConfig: this.#config,
      status: success ? 'saved' : 'error', error: this.#info.error,
      recovery: success ? undefined : { sourceFile: this.#info.sourcePath && path.basename(this.#info.sourcePath), indexFile: this.#info.indexPath && path.basename(this.#info.indexPath) },
      timeBase: 'simulation steps including preparation; wall-clock pauses omitted', startStep: 0, endStep: record.finalStep,
      startGameTimeMs: 0, endGameTimeMs: record.finalTick * 1000 / RULES.tickHz,
      videoDurationMs: this.#info.videoPath ? mapping.length * 1000 / FPS : null,
      endHoldFrames: mapping.filter(entry => entry.repeat === 'end').length,
      gapHoldFrames: mapping.filter(entry => entry.repeat === 'gap').length,
      mapping, jpegIndex: this.#index,
      measurement: { condition: 'shared JPEG capture and disk writes; H.264 transcode after the match',
        jpegFrames: this.#index.length, sourceBytes: this.#sourceBytes, indexBytes: this.#indexBytes,
        maxPendingFrames: this.#maxPending, maxPendingBytes: this.#maxPendingBytes,
        captureCpuMs: this.#captureMs, diskWriteMs: this.#diskWriteMs, transcodeMs: this.#info.transcodeMs },
    } };
    try {
      await writeFile(`${base}.json`, JSON.stringify(data), { flag: 'wx' });
      this.#info.dataPath = `${base}.json`;
    } catch (error) {
      const previous = this.#info.error;
      this.#info.status = 'error';
      this.#info.error = `${previous ? `${previous}。` : ''}录制数据保存失败：${message(error)}`;
    }
    if (this.#info.status === 'error') return;
    this.#info.status = 'saved';
    await this.cleanSources();
  }

  private async transcode(timeline: VideoSample[], base: string) {
    const partial = `${base}.mp4.partial`;
    const reserve = await open(partial, 'wx');
    this.#ownedVideoPartial = partial;
    await reserve.close();
    const source = await open(this.#info.sourcePath!, 'r');
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot','WINDIR','PATH']) if (process.env[name]) env[name] = process.env[name];
    try {
      const child = spawn(this.executable, ['-hide_banner','-loglevel','error','-xerror',
        '-f','image2pipe','-framerate',String(FPS),'-vcodec','mjpeg','-i','pipe:0','-an',
        '-vf',`scale=${WIDTH}:${HEIGHT}:flags=lanczos`, '-c:v','libx264','-preset','ultrafast','-crf','17',
        '-pix_fmt','yuv420p','-threads','2','-filter_threads','1','-movflags','+faststart',
        '-progress','pipe:1','-nostats','-f','mp4','-y',partial], { env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      this.#child = child;
      let stderr = '', progress = '', frames = 0, spawnError: Error | undefined, timedOut = false;
      child.on('error', error => { spawnError = error; });
      child.stdin!.on('error', () => {});
      child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-2048); });
      child.stdout!.on('data', data => {
        progress += String(data);
        const lines = progress.split('\n');
        progress = lines.pop()!.slice(-1024);
        for (const line of lines) if (line.startsWith('frame=')) frames = Number(line.slice(6));
      });
      const exit = new Promise<number | null>(resolve => child.once('close', resolve));
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
      try {
        let lastId = -1, bytes = Buffer.alloc(0);
        for (const { source: entry } of timeline) {
          if (entry.frameId !== lastId) {
            bytes = Buffer.allocUnsafe(entry.size);
            for (let read = 0; read < bytes.length;) {
              const { bytesRead } = await source.read(bytes, read, bytes.length - read, entry.offset + read);
              if (!bytesRead) throw Error('MJPEG 源文件截断');
              read += bytesRead;
            }
            lastId = entry.frameId;
          }
          await new Promise<void>((resolve,reject) => child.stdin!.write(bytes, error => error ? reject(error) : resolve()));
        }
        child.stdin!.end();
        const code = await exit;
        if (timedOut) throw Error('转码超时');
        if (code !== 0 || frames !== timeline.length) throw spawnError ?? Error(stderr || `输出帧数 ${frames}/${timeline.length}`);
        const output = await open(partial,'r');
        try {
          const header = Buffer.alloc(12);
          await output.read(header);
          if (header.toString('ascii',4,8) !== 'ftyp') throw Error('输出不是完整的 MP4 容器');
        } finally { await output.close(); }
        await copyFile(partial, `${base}.mp4`, constants.COPYFILE_EXCL);
        this.#info.videoPath = `${base}.mp4`;
      } catch (error) {
        child.kill();
        await exit;
        throw timedOut ? Error('转码超时') : spawnError ?? (stderr ? Error(stderr.trim()) : error);
      } finally {
        clearTimeout(timeout);
        this.#child = undefined;
      }
    } finally { await source.close(); }
  }

  private async removeVideoPartial() {
    if (!this.#ownedVideoPartial) return;
    try { await unlink(this.#ownedVideoPartial); this.#ownedVideoPartial = undefined; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.fail(`MP4 临时文件清理失败：${message(error)}`);
    }
  }

  private async cleanSources() {
    for (const key of ['sourcePath','indexPath'] as const) {
      const filename = this.#info[key];
      if (!filename) continue;
      try { await unlink(filename); this.#info[key] = undefined; }
      catch (error) { this.#info.cleanupWarning = `临时录像文件清理失败：${message(error)}`; }
    }
  }

  async dispose() {
    if (this.#finish) { await this.#finish; return; }
    this.#child?.kill();
    await this.#queue;
    await this.closeInputs();
    await this.removeVideoPartial();
  }
}
