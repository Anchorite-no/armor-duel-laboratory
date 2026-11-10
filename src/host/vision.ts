import { performance } from 'node:perf_hooks';
import { RULES, type ParticipantObservation } from '../shared/protocol.js';
import { PROVISIONAL_VISION, validateVision, type VisionConfig } from '../shared/vision.js';
import type { DisplayFrame } from '../shared/scene.js';
import { ffmpegPath } from './recorder.js';
import { NativeJpegEncoder } from './native-jpeg.js';

type FrameTiming = {
  frameId: number;
  step: number;
  capturedAt: number;
  completedAt: number;
  renderMs: number;
  encodeMs: number;
};
export type SharedJpeg = {
  matchId: string;
  frameId: number;
  bytes: Buffer;
  step: number;
  tick: number;
  gameTimeMs: number;
  countdownMs: number;
  status: DisplayFrame['status'];
};
const preparationSteps = RULES.preparationMs * RULES.tickHz / 1000;
const activePhase = (frame: Pick<DisplayFrame, 'status'>) => frame.status === 'countdown' || frame.status === 'running';
const sourceStep = (frame: DisplayFrame) => frame.status === 'countdown'
  ? preparationSteps - Math.round(frame.countdownMs * RULES.tickHz / 1000)
  : preparationSteps + frame.scene.tick;

export class VisualFeed {
  #config: VisionConfig;
  #encoder?: NativeJpegEncoder;
  #closing?: Promise<void>;
  #closed = false;
  #sequence = 0;
  #epoch = 0;
  #context = '';
  #enabled = false;
  #lastStep = -1;
  #lastSlot = -1;
  #captured = -Infinity;
  #retryAt = -Infinity;
  #error?: Error;
  #cache?: SharedJpeg;
  #observation?: ParticipantObservation;
  #pending?: Promise<SharedJpeg>;
  #recording?: { matchId: string; capture: (frame: SharedJpeg) => void };
  #lastFrame?: FrameTiming;
  #metrics = { captures: 0, completed: 0, cacheHits: 0, pendingReturns: 0, renderMs: 0, encodeMs: 0,
    maxPending: 0, maxQueued: 0, droppedSlots: 0, encoderStarts: 0, failures: 0 };

  constructor(config: VisionConfig = PROVISIONAL_VISION, private readonly executable = ffmpegPath()) {
    this.#config = validateVision(config);
  }

  get config() { return { ...this.#config }; }
  get metrics() { return { ...this.#metrics, encoderPid: this.#encoder?.pid, lastFrame: this.#lastFrame && { ...this.#lastFrame } }; }
  get interested() { return this.#enabled || this.#recording !== undefined; }

  subscribeRecording(matchId: string, capture: (frame: SharedJpeg) => void) {
    this.#recording = { matchId, capture };
  }

  unsubscribeRecording(matchId: string) {
    if (this.#recording?.matchId !== matchId) return;
    this.#recording = undefined;
    if (this.#cache?.matchId === matchId && !activePhase(this.#cache) && this.#cache.status !== 'paused') {
      this.#context = `${matchId}:${this.#cache.status}`;
      void this.retire();
    } else if (!this.#enabled) void this.reset();
  }

  configure(config: unknown) {
    this.#config = validateVision(config);
    return this.reset();
  }

  reset() {
    this.#epoch++;
    this.#enabled = false;
    this.#context = '';
    this.#cache = undefined;
    this.#observation = undefined;
    this.#pending = undefined;
    this.#lastFrame = undefined;
    this.#lastStep = this.#lastSlot = -1;
    this.#captured = this.#retryAt = -Infinity;
    this.#error = undefined;
    return this.retire();
  }

  private retire() {
    if (this.#encoder) {
      this.#closing = this.#encoder.close();
      this.#encoder = undefined;
    }
    return this.#closing;
  }

  private sync(frame: DisplayFrame) {
    // Preparation and battle share a simulation clock. All other phase/round
    // changes invalidate both pending work and the published frame immediately.
    const terminal = frame.status === 'ended' || frame.status === 'stopped';
    const useActive = activePhase(frame) || (terminal && this.#recording?.matchId === frame.matchId);
    const context = `${frame.matchId}:${useActive ? 'active' : frame.status}`;
    if (context !== this.#context) {
      void this.reset();
      this.#context = context;
    }
  }

  update(frame: DisplayFrame, realtime: boolean) {
    if (this.#closed) return;
    this.sync(frame);
    if (activePhase(frame) && ((this.#enabled && realtime) || this.#recording?.matchId === frame.matchId)) this.capture(frame, realtime);
  }

  async observe(capture: () => DisplayFrame, realtime = false, terminalStep?: number): Promise<ParticipantObservation> {
    if (this.#closed) throw Error('图像通道已关闭');
    const frame = capture();
    this.sync(frame);
    this.#enabled = true;
    const terminal = frame.status === 'ended' || frame.status === 'stopped';
    const step = terminal ? terminalStep ?? sourceStep(frame) : sourceStep(frame);
    if (terminal) return this.asObservation(await this.captureFinal(frame, step));
    this.capture(frame, realtime);
    if (this.#cache) {
      this.#metrics.cacheHits++;
      if (this.#pending) this.#metrics.pendingReturns++;
      return this.asObservation(this.#cache);
    }
    if (this.#pending) return this.asObservation(await this.#pending);
    throw this.#error ?? Error('暂未取得 JPEG 图像');
  }

  async captureInitial(frame: DisplayFrame) {
    this.sync(frame);
    this.capture(frame, true);
    await this.#pending;
  }

  async captureFinal(frame: DisplayFrame, step: number) {
    this.sync(frame);
    const epoch = this.#epoch;
    if (this.#pending) await this.#pending.catch(() => {});
    if (epoch !== this.#epoch || this.#closed) throw Error('结算图像请求已失效');
    if (this.#cache?.status === frame.status && this.#cache.step === step) return this.#cache;
    this.capture(frame, false, step, true);
    if (!this.#pending) throw this.#error ?? Error('无法生成结算 JPEG');
    return this.#pending;
  }

  private asObservation(shared: SharedJpeg): ParticipantObservation {
    if (this.#cache !== shared) throw Error('图像请求已失效');
    if (this.#observation?.frameId === shared.frameId) return this.#observation;
    const image = Object.freeze({ mimeType: 'image/jpeg' as const, width: this.#config.width,
      height: Math.round(this.#config.width * (RULES.height + 80) / RULES.width), base64: shared.bytes.toString('base64') });
    const observation = Object.freeze({ frameId: shared.frameId, image });
    if (this.#cache === shared) this.#observation = observation;
    return observation;
  }

  private capture(frame: DisplayFrame, realtime: boolean, step = sourceStep(frame), force = false) {
    const now = performance.now();
    if (this.#pending || (!force && now < this.#retryAt)) return;
    const slot = Math.floor(step * this.#config.fps / RULES.tickHz);
    const stream = realtime && activePhase(frame);
    if (this.#cache && !force) {
      if (!activePhase(frame) || step === this.#lastStep) return;
      if (stream ? slot <= this.#lastSlot : now - this.#captured < 1000 / this.#config.fps) return;
    }
    if (stream && this.#lastSlot >= 0) this.#metrics.droppedSlots += Math.max(0, slot - this.#lastSlot - 1);
    const epoch = this.#epoch;
    const config = this.#config;
    this.#lastStep = step;
    this.#lastSlot = slot;
    this.#captured = now;
    this.#metrics.captures++;
    this.#metrics.maxPending = 1;

    const pending = this.encode(frame, config, epoch).then(encoded => {
      if (this.#closed || epoch !== this.#epoch) throw Error('图像请求已失效');
      const frameId = ++this.#sequence;
      const shared = Object.freeze({ matchId: frame.matchId, frameId, bytes: encoded.data, step,
        tick: frame.scene.tick, gameTimeMs: frame.timestampMs, countdownMs: frame.countdownMs, status: frame.status });
      this.#cache = shared;
      this.#observation = undefined;
      this.#lastFrame = { frameId, step, capturedAt: now, completedAt: performance.now(), renderMs: encoded.renderMs, encodeMs: encoded.encodeMs };
      this.#metrics.renderMs += encoded.renderMs;
      this.#metrics.encodeMs += encoded.encodeMs;
      this.#metrics.completed++;
      if (this.#recording?.matchId === frame.matchId && frame.status !== 'paused') this.#recording.capture(shared);
      if (!activePhase(frame)) void this.retire();
      return shared;
    }).catch((error: Error) => {
      if (epoch === this.#epoch) {
        this.#cache = undefined;
        this.#observation = undefined;
        this.#lastFrame = undefined;
        this.#error = error;
        this.#retryAt = performance.now() + 250;
        this.#metrics.failures++;
        void this.retire();
      }
      throw error;
    }).finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    // The sampler may encode with no RPC currently waiting for its result.
    void pending.catch(() => {});
  }

  private async encode(frame: DisplayFrame, config: VisionConfig, epoch: number) {
    if (this.#encoder?.failed) await this.retire();
    await this.#closing;
    if (this.#closed || epoch !== this.#epoch) throw Error('图像请求已失效');
    if (!this.#encoder) {
      this.#encoder = new NativeJpegEncoder(this.executable, config);
      this.#metrics.encoderStarts++;
    }
    return this.#encoder.encode(frame);
  }

  async dispose() {
    this.#closed = true;
    this.#recording = undefined;
    await this.reset();
  }
}
