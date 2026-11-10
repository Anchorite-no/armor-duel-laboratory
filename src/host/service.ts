import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RULES as R, SIDE, validateMotionAction, validateSide, validateTuning, type Side } from '../shared/protocol.js';
import { upgradeRoomAI, validateRoom, KEYBOARD } from '../shared/room.js';
import { Game, type Controller, type Setup } from './game.js';
import { Program, RESTRICTION, verifyProgramRuntime } from './program.js';
import { ScriptLibrary, type SelectedScript } from './library.js';
import { BUILD_ID } from '../shared/build.js';
import { VisualFeed } from './vision.js';
import { PROVISIONAL_VISION, type VisionConfig } from '../shared/vision.js';
import { SimulationNumericsError } from '../shared/numerics.js';
import { MatchRecorder,type RecordingInfo } from './recorder.js';
import { spawn } from 'node:child_process';
import { nextControlStep } from '../shared/control.js';
export class Laboratory {
  readonly game:Game;
  readonly programs = { blue: new Program(), red: new Program() };
  #last = performance.now();
  #remainder = 0;
  #timer?: NodeJS.Timeout;
  #busy = new Map<Side, AbortController>();
  #disposed = false;
  #recordPath: string;
  readonly library: ScriptLibrary;
  #selected = new Map<Side, SelectedScript>();
  #pendingPrograms = false;
  #controllerError = '';
  #startedPrograms = new Set<Side>();
  #launches = new Set<Promise<unknown>>();
  #visual:VisualFeed;
  #recorder?:MatchRecorder;#saving?:Promise<void>;#initializing=false;
  #transition?: Promise<unknown>;
  #controlWaiters=new Set<()=>void>();
  constructor(recordPath = fileURLToPath(new URL(import.meta.url.replaceAll('\\','/').includes('/src/host/')?'../../.local/referee':'../.local/referee', import.meta.url)), vision:VisionConfig=PROVISIONAL_VISION, private readonly diagnostics=false, private readonly recordingDirectory=path.join(path.dirname(recordPath),'recordings')) { this.game=new Game(false,false,diagnostics);this.#recordPath = recordPath; this.library = new ScriptLibrary(path.join(path.dirname(recordPath), 'scripts.json'));this.#visual=new VisualFeed(vision); }
  startClock() { if(this.#timer||this.#disposed)return;this.#timer = setInterval(() => this.pump(), 8); this.#timer.unref(); }
  private updateVision() {
    if (this.#recorder?.failed && !this.#saving) this.#visual.unsubscribeRecording(this.game.matchId);
    if (this.#visual.interested) this.#visual.update(this.game.participantFrame(), this.game.clock === 'realtime');
  }
  private observeImage() {
    const realtime = this.game.clock === 'realtime';
    if (realtime && ['running','countdown'].includes(this.game.status)) this.startClock();
    return this.#visual.observe(() => this.game.participantFrame(), realtime, this.game.elapsedSteps);
  }
  private notifyControlWaiters(){for(const check of this.#controlWaiters)check();}
  private waitForAppliedStep(match: string, applyAt: number, signal: AbortSignal) {
    this.startClock();
    return new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{this.#controlWaiters.delete(check);signal.removeEventListener('abort',aborted);if(!this.#controlWaiters.size)this.#timer?.unref();};
      const aborted=()=>{cleanup();reject(signal.reason);};
      const check=()=>{
        if(signal.aborted){aborted();return;}
        if(this.game.matchId!==match||!['running','countdown'].includes(this.game.status)||this.game.elapsedSteps>applyAt){cleanup();resolve();}
      };
      this.#controlWaiters.add(check);this.#timer?.ref();signal.addEventListener('abort',aborted,{once:true});check();
    });
  }
  pump(now = performance.now()) {
    const elapsed = Math.max(0, now - this.#last); this.#last = now;
    if (this.#initializing || this.game.clock !== 'realtime' || !['running', 'countdown'].includes(this.game.status)) { this.#remainder = 0;this.notifyControlWaiters(); this.updateVision(); return; }
    this.#remainder += elapsed * R.tickHz / 1000;
    let count = Math.floor(this.#remainder); this.#remainder -= count;
    try {
      while (count > 0 && ['running', 'countdown'].includes(this.game.status)) { const batch = Math.min(count, R.tickHz * 2); this.game.advance(batch); count -= batch; }
    } catch (error) {
      if (!(error instanceof SimulationNumericsError)) throw error;
      this.#controllerError = error.message; this.#pendingPrograms = false;
      for (const controller of this.#busy.values()) controller.abort();
      for (const program of Object.values(this.programs)) void program.stop();
      this.notifyControlWaiters();this.updateVision();void this.finalizeRecording(); return;
    }
    this.notifyControlWaiters();
    if (['running','countdown'].includes(this.game.status) && this.#pendingPrograms) void this.launchSelected();
    for (const side of this.#startedPrograms) if (['running','countdown'].includes(this.game.status) && this.programs[side].info().status === 'error') {
      this.#controllerError = `${side === 'blue' ? '蓝方' : '红方'}脚本运行失败，请在脚本库查看输出`;
      this.game.stop(); this.#pendingPrograms = false;
      for (const program of Object.values(this.programs)) void program.stop();
      void this.finalizeRecording();
    }
    if ((this.game.status as string) === 'ended') { for (const p of Object.values(this.programs)) void p.stop(); void this.finalizeRecording(); }
    this.updateVision();
  }
  async launchSelected() {
    this.#pendingPrograms = false;
    const match = this.game.matchId;
    let work: Promise<unknown> | undefined;
    try {
      work = Promise.all([...this.#selected].filter(([, s]) => s.kind === 'custom').map(async ([side, script]) => {
        if (this.game.matchId !== match || !['running','countdown'].includes(this.game.status)) return;
        await this.programs[side].run(script.code, side, (m, a, s) => this.boundParticipant(match,m,a,s), () => { if(this.game.matchId===match)try { this.game.cancel(side, 'script'); } catch {} });
        if (this.game.matchId !== match || !['running','countdown'].includes(this.game.status)) await this.programs[side].stop();
        else this.#startedPrograms.add(side);
      }));
      this.#launches.add(work); await work;
    } catch (e) {
      if (this.game.matchId !== match || !['running','countdown'].includes(this.game.status)) return;
      this.#controllerError = e instanceof Error ? e.message : String(e); this.game.stop();
      await Promise.all(Object.values(this.programs).map(p => p.stop()));
    } finally { if (work) this.#launches.delete(work); }
  }
  async prepareRoom(input: unknown): Promise<{ setup: Setup; selected: Map<Side, SelectedScript> }> {
    if (!input || typeof input !== 'object') throw new Error('需要房间配置');
    const setup = structuredClone(input) as Setup, selected = new Map<Side, SelectedScript>();
    setup.tuning = validateTuning(setup.tuning);
    if (setup.room) {
      if (setup.clock !== 'realtime') throw new Error('本地房间使用实时模式');
      const upgraded = upgradeRoomAI(setup.room,setup.privilegedAI);
      setup.room = validateRoom(upgraded.room, await this.library.list());
      setup.privilegedAI = upgraded.privilegedAI;
      setup.scriptBindings = [];
      for (const side of SIDE) {
        if (setup.room.seats[side] === KEYBOARD) { setup.controllers[side] = 'human'; continue; }
        const script = await this.library.get(setup.room.seats[side]); selected.set(side, script); setup.controllers[side] = script.controller;
        if (script.kind === 'custom') verifyProgramRuntime();
        setup.scriptBindings.push({ side, id: script.id, name: script.name, kind: script.kind, hash: script.hash, ...(script.implementation ? {implementation:script.implementation} : {}) });
      }
    }
    // Validate all rules before stopping the previous round or launching a process.
    const validation = new Game(); validation.start(setup);
    return { setup, selected };
  }
  async play(sideInput: unknown, action: unknown, source: Controller, signal?: AbortSignal) {
    const side = validateSide(sideInput);
    if (this.#busy.has(side)) throw new Error('该席位仍有动作调用，请等它完成或先取消');
    signal?.throwIfAborted(); this.pump();
    const match = this.game.matchId;
    const applyAt=nextControlStep(this.game.elapsedSteps);
    const count = this.game.action(side, action, source);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    this.#busy.set(side, controller);
    try {
      if (this.game.clock === 'stepped') this.game.advance(count);
      else await this.waitForAppliedStep(match,applyAt,combined);
      combined.throwIfAborted(); this.pump();
      if (match !== this.game.matchId) throw new Error('比赛已重新开始');
      const frame=await this.observeImage();
      combined.throwIfAborted();if(match!==this.game.matchId)throw Error('比赛已重新开始');return frame;
    } finally {
      if (match === this.game.matchId && combined.aborted && this.game.setup.controllers[side] === source) this.game.cancel(side, source);
      if (this.#busy.get(side) === controller) this.#busy.delete(side);
      if (this.game.status === 'ended') void this.finalizeRecording();
    }
  }
  private boundParticipant(match:string,method:string,payload:unknown,signal:AbortSignal){
    if(match!==this.game.matchId||signal.aborted)return Promise.reject(Error('Participant request failed.'));
    return this.participant(method,payload,'script',signal);
  }
  async participant(method: string, payload: unknown, source: 'agent' | 'script', signal?: AbortSignal): Promise<unknown> {
    try {
    if (this.#disposed) throw new Error('实验室已卸载');
    if(this.#initializing)throw new Error('录制正在准备');
    signal?.throwIfAborted(); this.pump();
    const p = (payload ?? {}) as { side?: unknown; action?: unknown };
    if (['act','cancel','fire'].includes(method) && Object.keys(p).some(key=>key!=='side' && (method!=='act' || key!=='action'))) throw new Error('Invalid participant request');
    if (method === 'observe' || method === 'fire') {
      const match=this.game.matchId;
      if (method === 'fire' && this.game.fire(p.side,source)) {
        if (this.game.clock==='stepped') this.game.advance(1);
        else await this.waitForAppliedStep(match,this.game.elapsedSteps,signal ?? new AbortController().signal);
      }
      if (this.#disposed || match!==this.game.matchId) throw Error('比赛已重新开始');
      const frame=await this.observeImage();
      signal?.throwIfAborted();if(match!==this.game.matchId)throw Error('比赛已重新开始');return frame;
    }
    if (method === 'act') return await this.play(p.side,{...validateMotionAction(p.action),fire:false},source,signal);
    if (method === 'cancel') { const side = validateSide(p.side); this.game.cancel(side, source); this.#busy.get(side)?.abort(); return { cancelled: true }; }
    throw new Error('参赛接口仅支持 observe / act / fire / cancel');
    } catch { throw new Error('Participant request failed.'); }
  }
  async admin(method: string, payload: unknown, signal?: AbortSignal, onStart?: () => void): Promise<unknown> {
    if (!['start','pause','resume','stop','configureVision'].includes(method)) return this.performAdmin(method, payload, signal);
    if (this.#transition) throw Error('比赛状态正在切换，请稍后再试');
    const operation = this.performAdmin(method, payload, signal, onStart);
    this.#transition = operation;
    try { return await operation; } finally { this.#transition = undefined; }
  }
  private async performAdmin(method: string, payload: unknown, signal?: AbortSignal, onStart?: () => void): Promise<unknown> {
    if (this.#disposed) throw new Error('实验室已卸载');
    this.pump();
    const p = (payload ?? {}) as { side?: Side; matchId?:unknown; action?: unknown; aimAssist?:unknown; setup?: unknown; code?: unknown; index?: unknown; name?: unknown; id?: unknown; vision?:unknown };
    switch (method) {
      case 'display': return { runtime: { buildId: BUILD_ID, version: R.version }, frame: this.game.display(), observation: this.game.metadata(), controllerError: this.#controllerError,recording:this.recordingInfo() };
      case 'view': return { runtime: { buildId: BUILD_ID, version: R.version }, observation: this.game.observe(), setup: this.game.setup, scripts: await this.library.list(), controllerError: this.#controllerError, programs: { blue: this.programs.blue.info(), red: this.programs.red.info() }, restriction: RESTRICTION, vision:this.#visual.config,recording:this.recordingInfo() };
      case 'configureVision': {
        if(['running','countdown','paused'].includes(this.game.status))throw Error('本轮供图参数已冻结，请结束后调整');
        await this.#visual.configure(p.vision);return this.admin('view',{});
      }
      case 'start': {
        if (this.#saving) throw Error('上一局正在生成视频，保存完成后可开启新局');
        const prepared = await this.prepareRoom(p.setup);
        this.#pendingPrograms = false;
        if (this.#launches.size) { this.game.pause(); await Promise.allSettled([...this.#launches]); }
        for (const controller of this.#busy.values()) controller.abort();
        await Promise.all(Object.values(this.programs).map(program => program.stop()));
        if (['running','countdown','paused'].includes(this.game.status))this.game.stop();
        void this.finalizeRecording();
        if (this.#saving) throw Error('上一局正在生成视频，保存完成后可开启新局');
        await this.#visual.reset();
        const startedAt=new Date();
        this.game.start({...prepared.setup,vision:this.#visual.config});this.#recorder=undefined;
        if(this.game.recording&&!this.diagnostics){
          this.#initializing=true;const recorder=new MatchRecorder(this.recordingDirectory);this.#recorder=recorder;
          try {
            await recorder.start(this.game.matchId, this.#visual.config,startedAt);
            if (!recorder.failed) {
              this.#visual.subscribeRecording(this.game.matchId, frame => recorder.capture(frame));
              this.game.setCapture(this.game.clock === 'stepped' ? frame => this.#visual.update(frame, false) : undefined, error => recorder.fail(error));
              // Begin on the shared preparation frame before starting the round clock.
              await this.#visual.captureInitial(this.game.display()).catch(() => {});
            }
          }
          finally{this.#initializing=false;}
        }
        this.#selected = prepared.selected; this.#pendingPrograms = true; this.#startedPrograms.clear(); this.#controllerError = ''; this.#last = performance.now(); this.#remainder = 0;
        onStart?.();
        if (this.game.recording && this.game.clock === 'realtime') this.startClock();
        await this.launchSelected();
        if (this.#controllerError) throw new Error(this.#controllerError);
        return this.admin('view', null);
      }
      case 'input':
        if(this.#initializing||p.matchId!==this.game.matchId) return {accepted:false};
        // A frame already in flight can outlive the round. Releasing input or
        // ending normally should not produce a spurious game error banner.
        if (!['running','countdown'].includes(this.game.status)) return { accepted: false, status: this.game.status };
        this.game.humanInput(p.side, p.action, p.aimAssist); return { accepted: true };
      case 'release': if(p.matchId!==this.game.matchId)return {cancelled:false};this.game.cancel(p.side, 'human'); return { cancelled: true };
      case 'pause': this.game.pause(); for (const controller of this.#busy.values()) controller.abort(); await this.#visual.reset(); await Promise.allSettled([...this.#launches]); await Promise.all(Object.values(this.programs).map(program => program.stop())); return this.admin('view', null);
      case 'resume': this.game.resume(); this.#pendingPrograms = true; this.#last = performance.now(); return this.admin('view', null);
      case 'stop': this.#pendingPrograms = false; if(this.game.status!=='ended')this.game.stop(); for (const controller of this.#busy.values()) controller.abort(); await Promise.allSettled([...this.#launches]); await Promise.all(Object.values(this.programs).map(program => program.stop())); void this.finalizeRecording(); this.updateVision(); return this.admin('view', null);
      case 'saveScript': { await this.library.save(p.name, p.code, p.id); return this.admin('view', null); }
      case 'scriptSource': { const script = await this.library.get(p.id); if (script.kind !== 'custom') throw new Error('内置控制器实现不提供给参赛脚本'); return { id: script.id, name: script.name, code: script.code }; }
      case 'program': {
        if (this.game.setup.room) throw new Error('房间对局使用已绑定脚本，请在房间更换后重新进入');
        const side = validateSide(p.side);
        if (!['running','countdown'].includes(this.game.status) || this.game.setup.controllers[side] !== 'script') throw new Error('请先配置脚本席位并开始比赛');
        const match=this.game.matchId;
        return this.programs[side].run(p.code, side, (m, a, s) => this.boundParticipant(match,m,a,s), () => { if(this.game.matchId===match)try { this.game.cancel(side, 'script'); } catch {} });
      }
      case 'stopProgram': await this.programs[validateSide(p.side)].stop(); return this.admin('view', null);
      case 'recordingOpen': {
        const info=this.recordingInfo(),filename=info.videoPath??info.dataPath??info.sourcePath??info.indexPath;if(!filename)throw Error('尚无已保存的录制文件');
        const child=spawn('explorer.exe',[path.dirname(filename)],{windowsHide:true,detached:true,stdio:'ignore'});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {opened:true};
      }
      case 'record': {
        if(!this.game.hasHistory)throw Error('本局未选择录制，没有完整对局记录');
        if (['running', 'countdown', 'paused'].includes(this.game.status)) throw new Error('请先结束比赛，再打开裁判记录');
        return { path: await this.saveRecord(), record: this.game.refereeRecord() };
      }
      case 'replayFrame': return this.game.refereeFrame(p.index);
      default: throw new Error('未知管理操作');
    }
  }
  recordingInfo():RecordingInfo{return this.#recorder?.info()??{enabled:this.game.recording,status:this.game.recording?'recording':'off'};}
  // Headless diagnostics can wait for the asynchronous save without an owner RPC timeout.
  async waitForRecording() { await this.#saving; }
  // Headless owner diagnostics only; never projected through participant RPC.
  visionMetrics(){return this.#visual.metrics;}
  private async finalizeRecording(){
    if(this.#saving)return this.#saving;
    const recorder=this.#recorder;if(!recorder||recorder.finishing)return;
    this.game.setCapture(undefined);
    const matchId = this.game.matchId;
    recorder.beginSaving();
    this.#saving = (async () => {
      if (!recorder.failed) {
        try { await this.#visual.captureFinal(this.game.display(), this.game.elapsedSteps); }
        catch (error) { recorder.fail(`结算 JPEG 无法保存：${(error as Error).message}`); }
      }
      this.#visual.unsubscribeRecording(matchId);
      await recorder.finish(this.game.refereeRecord());
    })().finally(()=>{this.#saving=undefined;});
    return this.#saving;
  }
  async saveRecord() {
    if(!this.game.hasHistory)throw Error('本局未录制');
    if (this.#recorder) {
      await this.finalizeRecording();
      const {dataPath} = this.#recorder.info();
      if (dataPath) return dataPath;
      throw Error('没有已保存的对局数据');
    }
    await mkdir(this.#recordPath, { recursive: true });
    const record = this.game.refereeRecord();
    const filename = path.join(this.#recordPath, `${record.matchId}.json`);
    await writeFile(filename, JSON.stringify(record)); return filename;
  }
  async dispose() {
    this.#disposed = true; this.#pendingPrograms = false; clearInterval(this.#timer);
    await this.#transition?.catch(() => {});
    if(this.game.status!=='ended')this.game.stop();
    this.notifyControlWaiters();
    for (const controller of this.#busy.values()) controller.abort();
    await Promise.allSettled([...this.#launches]);
    await Promise.all(Object.values(this.programs).map(program => program.stop()));
    await this.finalizeRecording();
    await this.#visual.dispose();await this.#recorder?.dispose();
  }
}
