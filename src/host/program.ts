import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RULES, type Side } from '../shared/protocol.js';
export interface ProgramState { status: 'idle' | 'running' | 'ended' | 'stopped' | 'error'; output: string; restriction: string }
export const RESTRICTION = '实验限制：独立 Node 进程；仅允许读取运行器，禁止文件写入、子进程、Worker、原生扩展。网络和资源用量未实现操作系统隔离，不能用于不可信代码或正式公平评测。';
const CONTEST_RESTRICTION = '参赛脚本使用独立受限运行时，通过标准输入输出调用参赛接口。';
const sourceBuild = import.meta.url.replaceAll('\\','/').includes('/src/host/');
const contestRuntime = fileURLToPath(new URL(sourceBuild ? '../../.local/contest-runtime/' : '../.local/contest-runtime/', import.meta.url));
const contestFlags = ['run','--no-config','--no-lock','--no-npm','--no-remote','--no-prompt',
  '--deny-read','--deny-write','--deny-net','--deny-env','--deny-run','--deny-ffi','--deny-sys','--deny-import',
  '--v8-flags=--max-old-space-size=96'];

function contestDiagnostic(stderr: string) {
  for (const line of stderr.split(/\r?\n/)) {
    try {
      const error = JSON.parse(line);
      if (typeof error?.message !== 'string') continue;
      if (error.name === 'NotCapable' || error.name === 'PermissionDenied') return 'PermissionDenied: 脚本无权访问该资源。';
      const name = /^(Syntax|Type|Reference|Range|Eval|URI)?Error$/.test(error.name) ? error.name : 'Error';
      const message = error.message.split(/[\r\n]/,1)[0]
        .replace(/"[^"\r\n]*[\\/][^"\r\n]*"|'[^'\r\n]*[\\/][^'\r\n]*'/g,'[path]')
        .replace(/(?:\b[a-z][\w+.-]*:\/{1,2}|\b[A-Z]:\\|\\\\|\/)[^\s)<>]+/gi,'[path]')
        .replace(/[\x00-\x1f\x7f]/g,' ').slice(0,500);
      return `${name}: ${message}`;
    } catch { /* Ignore raw runtime output. */ }
  }
  return '脚本运行时异常退出。';
}

function runnerEnvironment(contest: boolean) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot','WINDIR','PATH']) if (process.env[key]) env[key] = process.env[key];
  if (contest) {
    env.DENO_NO_UPDATE_CHECK = '1';
    env.DENO_DIR = path.join(contestRuntime,'cache');
  }
  return env;
}

let verifiedContest: { command: string; version: string } | undefined;
export function verifyContestRuntime() {
  const command = process.env.LAB_CONTEST_DENO ?? path.join(contestRuntime,'deno.exe');
  if (verifiedContest?.command === command) return verifiedContest;
  const check = spawnSync(command, ['--version'], { env:runnerEnvironment(true), encoding:'utf8', windowsHide:true, timeout:5000 });
  const version = check.stdout?.split(/\r?\n/)[0] ?? '';
  if (check.status !== 0 || !/^deno 2\./.test(version)) throw Error('参赛脚本需要项目本地 Deno 2，或配置 LAB_CONTEST_DENO');
  return verifiedContest = {command,version};
}
let verifiedCommand: string | undefined;
export function verifyProgramRuntime(): string {
  const command = process.env.LAB_NODE_COMMAND ?? 'node';
  if (verifiedCommand === command) return command;
  const check = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (check.status !== 0 || !/^v(2[4-9]|[3-9]\d)\./.test(check.stdout.trim())) throw new Error('脚本需要 PATH 中的 Node 24+，或配置 LAB_NODE_COMMAND');
  verifiedCommand = command; return command;
}
export class Program {
  #child?: ChildProcessWithoutNullStreams;
  #state: ProgramState = { status: 'idle', output: '', restriction: RESTRICTION };
  #timer?: NodeJS.Timeout;
  #generation = 0;
  #cancel?: () => void;
  #abort?: AbortController;
  constructor(private readonly contestDirectory?: string) {}
  info(): ProgramState { return { ...this.#state }; }
  async run(code: unknown, side: Side, call: (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>, cancel: () => void, startGate?: Promise<void>) {
    if (typeof code !== 'string' || code.length > 64000) throw new Error('脚本应为不超过 64 KB 的 JavaScript');
    await this.stop();
    const contest = this.contestDirectory !== undefined;
    const command = contest ? verifyContestRuntime().command : verifyProgramRuntime();
    const runner = fileURLToPath(new URL(sourceBuild?'../../.local/runner/runner.mjs':'./runner.mjs', import.meta.url));
    const args = contest ? [...contestFlags,runner] : ['--permission', `--allow-fs-read=${runner}`, '--max-old-space-size=96', runner];
    const child = spawn(command, args, { env:runnerEnvironment(contest), cwd:this.contestDirectory, windowsHide:true, stdio:['pipe','pipe','pipe'] });
    this.#child = child; this.#cancel = cancel;
    const generation = ++this.#generation, abort = new AbortController();
    let ready = () => {};
    let notReady = (_error: Error) => {};
    const staged = startGate && new Promise<void>((resolve,reject)=>{ready=resolve;notReady=reject;});
    this.#abort = abort;
    this.#state = { status: 'running', output: '', restriction: contest ? CONTEST_RESTRICTION : RESTRICTION };
    let buffer = '', stderr = '', busy = false, count = 0;
    const append = (value: string) => { if (generation === this.#generation) this.#state.output = (this.#state.output + value).slice(-4096); };
    const finish = (status: ProgramState['status']) => { abort.abort(); if (generation !== this.#generation) return; this.#state.status = status; this.#child = undefined; this.#cancel?.(); this.#cancel = undefined; clearTimeout(this.#timer); };
    child.on('error', error => { append(contest?'脚本运行时无法启动。':error.message); finish('error'); });
    child.on('close', code => {
      if (generation !== this.#generation || this.#state.status !== 'running') return;
      if (contest && code !== 0) append(contestDiagnostic(stderr)+'\n');
      finish(code === 0 ? 'ended' : 'error');
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => {
      if (contest) stderr = (stderr + String(data)).slice(-4096);
      else append(String(data));
    });
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 131072) { append('输出超过上限'); child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (staged && line === '{"ready":true}') { ready(); continue; }
        let message: { id: number; method: string; payload: unknown };
        try { message = JSON.parse(line); } catch { append('脚本协议无效'); child.kill(); return; }
        if (!message || !Number.isSafeInteger(message.id) || !['observe', 'act', 'fire', 'cancel', 'log'].includes(message.method) || ++count > 30000 || busy) { append('脚本调用超限或并发调用'); child.kill(); return; }
        if (message.method === 'log') { append(String(message.payload).slice(0, 1000) + '\n'); child.stdin.write(JSON.stringify({ id: message.id, value: null }) + '\n'); continue; }
        busy = true;
        void call(message.method, message.method==='act'?{side,action:message.payload}:{side}, abort.signal).then(value => {
          if (!child.killed && !abort.signal.aborted) child.stdin.write(JSON.stringify({ id: message.id, value }) + '\n');
        }, error => { if (!child.killed && !abort.signal.aborted) child.stdin.write(JSON.stringify({ id: message.id, error: 'Participant request failed.' }) + '\n'); }).finally(() => { busy = false; });
      }
    });
    const begin = () => {
      if (generation !== this.#generation || abort.signal.aborted) return;
      const limit=RULES.durationMs+RULES.preparationMs;
      this.#timer = setTimeout(() => { append(`脚本达到 ${limit/1000} 秒墙钟上限（含准备期）`); void this.stop(); }, limit);
      child.stdin.write(JSON.stringify({ code, side, contest }) + '\n');
    };
    if (staged && startGate) {
      const reject = () => notReady(Error('Contest runner did not become ready'));
      abort.signal.addEventListener('abort',reject,{once:true});
      const timeout = setTimeout(reject,5000);
      try { child.stdin.write('{"stage":true}\n'); await staged; }
      catch (error) { if (generation === this.#generation) await this.stop(); throw error; }
      finally { clearTimeout(timeout); abort.signal.removeEventListener('abort',reject); }
      void startGate.then(begin);
    } else begin();
    return this.info();
  }
  async stop() {
    const child = this.#child;
    this.#generation++; this.#abort?.abort(); this.#abort = undefined; clearTimeout(this.#timer); this.#child = undefined;
    if (this.#state.status === 'running') this.#state.status = 'stopped';
    this.#cancel?.(); this.#cancel = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); });
  }
}
