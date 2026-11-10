import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { RULES } from '../shared/protocol.js';
import type { DisplayFrame } from '../shared/scene.js';
import { jpegQscale, VISION_HZ, type VisionConfig } from '../shared/vision.js';
import { JpegStream } from './jpeg-stream.js';

export type EncodedFrame = { data: Buffer; renderMs: number; encodeMs: number };
type Request = {
  resolve: (frame: EncodedFrame) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  renderMs: number;
  pipeStarted?: number;
};

export class NativeJpegEncoder {
  #worker: Worker;
  #child: ReturnType<typeof spawn>;
  #exited: Promise<void>;
  #closing?: Promise<void>;
  #request?: Request;
  #stderr = '';
  #failure?: Error;

  constructor(executable: string, config: VisionConfig) {
    const source = import.meta.url.replaceAll('\\', '/').includes('/src/host/');
    this.#worker = new Worker(new URL(source ? '../../.local/runner/vision-worker.mjs' : './vision-worker.mjs', import.meta.url), { execArgv: [] });
    const width = RULES.width, height = RULES.height + 80;
    const outputHeight = Math.round(config.width * height / width);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0',
      '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`,
      '-framerate', String(VISION_HZ), '-i', 'pipe:0', '-an',
      '-vf', `scale=${config.width}:${outputHeight}:flags=neighbor`,
      '-c:v', 'mjpeg', '-q:v', String(jpegQscale(config.quality)), '-pix_fmt', 'yuvj444p',
      '-threads', '1', '-filter_threads', '1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
      '-f', 'image2pipe', '-flush_packets', '1', 'pipe:1',
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot','WINDIR','PATH']) if (process.env[key]) env[key] = process.env[key];
    try {
      this.#child = spawn(executable, args, { windowsHide: true, env, stdio: ['pipe','pipe','pipe'] });
    } catch (error) {
      void this.#worker.terminate();
      throw error;
    }
    this.#exited = new Promise(resolve => this.#child.once('close', () => resolve()));
    const stream = new JpegStream(data => {
      const request = this.#request;
      if (!request || request.pipeStarted === undefined) throw Error('JPEG 编码器返回了未请求的帧');
      this.#request = undefined;
      clearTimeout(request.timeout);
      request.resolve({ data, renderMs: request.renderMs, encodeMs: performance.now() - request.pipeStarted });
    });
    this.#child.stdout!.on('data', (chunk: Buffer) => {
      if (this.#closing) return;
      try { stream.push(chunk); } catch (error) { this.fail(error as Error); }
    });
    this.#child.stderr!.on('data', (chunk: Buffer) => { this.#stderr = (this.#stderr + chunk.toString()).slice(-1024); });
    this.#child.stdin!.on('error', error => this.fail(error));
    this.#child.stdout!.on('error', error => this.fail(error));
    this.#child.stderr!.on('error', error => this.fail(error));
    this.#child.on('error', error => this.fail(error));
    this.#child.on('close', code => this.fail(Error(`JPEG 编码进程退出 (${code}) ${this.#stderr.trim()}`)));
    this.#worker.on('error', error => this.fail(error));
    this.#worker.on('exit', code => this.fail(Error(`JPEG 绘制线程退出 (${code})`)));
    this.#worker.on('message', (message: { data?: Uint8Array; renderMs: number; error?: string }) => {
      const request = this.#request;
      if (this.#closing || !request) return;
      if (message.error || !message.data) {
        this.fail(Error(message.error ?? 'JPEG 绘制未返回像素'));
        return;
      }
      request.renderMs = message.renderMs;
      request.pipeStarted = performance.now();
      // A single request owns the pipe until its complete JPEG arrives.
      try { this.#child.stdin!.write(message.data); } catch (error) { this.fail(error as Error); }
    });
  }

  get pid() { return this.#closing ? undefined : this.#child.pid; }
  get failed() { return this.#failure !== undefined; }

  encode(frame: DisplayFrame): Promise<EncodedFrame> {
    if (this.#failure || this.#closing || this.#request) return Promise.reject(this.#failure ?? Error('JPEG 编码器不可用'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(Error('JPEG 编码超时')), 2000);
      this.#request = { resolve, reject, timeout, renderMs: 0 };
      try { this.#worker.postMessage(frame); } catch (error) { this.fail(error as Error); }
    });
  }

  private fail(error: Error) {
    if (this.#closing) return;
    this.#failure = error;
    void this.close(error);
  }

  close(reason = Error('图像请求已失效')): Promise<void> {
    if (this.#closing) return this.#closing;
    const request = this.#request;
    this.#request = undefined;
    if (request) {
      clearTimeout(request.timeout);
      request.reject(reason);
    }
    this.#closing = Promise.resolve().then(async () => {
      this.#child.stdin?.destroy();
      this.#child.kill();
      await Promise.allSettled([this.#worker.terminate(), this.#exited]);
    });
    return this.#closing;
  }
}
