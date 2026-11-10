import { randomUUID, randomInt } from 'node:crypto';
import { motionCalibration, type MotionModel, RULES as R, SIDE, validateAction, validateFireSettings, validateSide, validateTuning, validateHistoricalTuning, type Action, type FireSettings, type OwnerObservation, type Side } from '../shared/protocol.js';
import { normalizeRoom, keyboardSide } from '../shared/room.js';
import { canFireWithoutOverheat, createState, tick, prepareTick, neutral, type Ballistics, type MatchConfig, type State } from './physics.js';
import { render } from './render.js';
import type { DisplayFrame } from '../shared/scene.js';
import { COMPUTER, computerAction, aimingSolution, privilegedAction, RandomWalk, TRADITIONAL_POLICY } from './opponent.js';
import { DEFAULT_AI, PRIVILEGED_AI, validatePrivilegedSeats } from '../shared/privileged-ai.js';
import { observedMotion, robotPoses, stationaryMotion, traditionalSnapshot, type ActualMotion } from './traditional-state.js';
import { SimulationNumericsError } from '../shared/numerics.js';
import { CONTROL_HZ, CONTROL_STEPS, leaseSteps, nextControlStep } from '../shared/control.js';
export type Controller = 'human' | 'agent' | 'script' | 'privileged' | 'computer' | 'spinner' | 'fixed' | 'idle';
export interface Setup extends MatchConfig { controllers: Record<Side, Controller> }
interface Lease { action: Action; until: number; source: Controller; steady?:Action; pulseUntil?:number; heatProtection?: true }
interface PendingInput { action:Action; until:number; source:Controller; assist?:boolean; firePulse:boolean }
export interface ActionRecord { step: number; tick: number; side?: Side; source?: Controller; action?: Action; aim?: {aimX:number;aimY:number}; effectiveTicks?: number; fire?: true; heatProtection?: true; cancel?: boolean; pause?: boolean; resume?: boolean; stop?: boolean }
interface HumanAim { aimX:number; aimY:number }
interface AssistanceEvent { step:number; tick:number; side:Side; enabled:boolean; reason:string }
export class Game {
  constructor(private readonly replaying = false, private readonly legacyEvents = false, private readonly diagnostics = false, private readonly playback?:{version?:string;bulletSpeed:number;fireHz:number;legacyActionTicks:boolean;heatEnabled?:boolean;humanFireHz?:number}) {
    if(playback&&!replaying)throw Error('历史规则仅供离线回放');
  }
  #state = createState();
  #id = randomUUID();
  #status: OwnerObservation['status'] = 'ready';
  #leases: Partial<Record<Side, Lease>> = {};
  #pending: Partial<Record<Side,PendingInput>> = {};
  #randomWalks: Partial<Record<Side,RandomWalk>> = {};
  #fire = new Set<Side>();
  #ballistics: Ballistics = R;
  #keyboardSide?: Side;
  #actions: ActionRecord[] = [];
  #snapshots: { step: number; tick: number; status: OwnerObservation['status']; countdownMs: number; state: State; motion:ActualMotion }[] = [];
  #elapsed = 0;
  #motion: ActualMotion = stationaryMotion();
  #setup: Setup = { clock: 'realtime', scenario: 'duel', targetSpin: 0.65, controllers: { red: 'human', blue: 'computer' } };
  #countdown = 0;
  #resumeStatus: 'running' | 'countdown' = 'running';
  #imageCache: { key: string; value: string } | undefined;
  #humanAim: Partial<Record<Side,HumanAim>> = {};
  #assistance: AssistanceEvent[] = [];
  #assistanceUsed=false;
  #events: State['events']=[];
  #capture?: (frame:DisplayFrame,step:number)=>void;
  #captureFailed?: (error:string)=>void;
  #recordingError='';
  #participantFrame?:DisplayFrame;
  get recording(){return this.#setup.recording===true;}
  get hasHistory(){return this.recording||this.replaying||this.diagnostics;}
  private get captureHistory(){return this.hasHistory&&!this.#recordingError;}
  setCapture(capture?: (frame:DisplayFrame,step:number)=>void,failed?:(error:string)=>void){this.#capture=capture;this.#captureFailed=failed;}
  private actionHistory(entry:ActionRecord){
    if(!this.captureHistory)return;
    if(this.#actions.length+this.#assistance.length>=100000){this.#recordingError='录制数据达到100000条事件预算，录制已停止；比赛继续';this.#captureFailed?.(this.#recordingError);return;}
    this.#actions.push(entry);
  }
  get elapsedSteps() { return this.#elapsed; }
  get tickCount() { return this.#state.tick; }
  get matchId() { return this.#id; }
  get clock() { return this.#setup.clock; }
  get status() { return this.#status; }
  get countdownMs() { return this.#countdown * 1000 / R.tickHz; }
  get setup(): Setup { return structuredClone(this.#setup); }
  private get singleFire() { return !this.playback || this.playback.version===R.version || this.playback.version==='0.7.9' || this.playback.version==='0.7.8' || this.playback.version==='0.7.7'; }
  private get motionModel(): MotionModel { const version=this.playback?.version; return !version||version===R.version?'current':version==='0.7.9'?'0.7.9':'legacy'; }
  start(input: unknown, initialState?: State) {
    if (!input || typeof input !== 'object') throw new Error('需要比赛配置');
    const s = input as Setup;
    if (!['realtime', 'stepped'].includes(s.clock) || !['duel', 'spinner', 'shooter'].includes(s.scenario)) throw new Error('模式无效');
    if (!Number.isFinite(s.targetSpin) || Math.abs(s.targetSpin) > 1) throw new Error('旋转档位必须在 [-1,1]');
    for (const side of SIDE) if (!['human', 'agent', 'script', 'privileged', 'computer', 'spinner', 'fixed', 'idle'].includes(s.controllers?.[side])) throw new Error('控制器无效');
    if (SIDE.filter(side=>s.controllers[side]==='human').length>1) throw new Error('本机只有一套键鼠，不能同时绑定双方');
    if (s.clock === 'stepped' && SIDE.some(side => s.controllers[side] === 'human')) throw new Error('键鼠使用实时模式；按步模式请配置 Agent / 脚本');
    if (s.clock === 'stepped' && SIDE.filter(side => ['agent', 'script'].includes(s.controllers[side])).length > 1) throw new Error('首版按步模式支持单个参与者；双方独立参与请用实时模式');
    const tuning = this.playback?.version && !['0.7.4','0.7.5','0.7.6','0.7.7','0.7.8','0.7.9',R.version].includes(this.playback.version)
      ? validateHistoricalTuning(s.tuning, this.playback.bulletSpeed, this.motionModel)
      : validateTuning(s.tuning);
    if(s.recording!==undefined&&typeof s.recording!=='boolean')throw new Error('录制开关必须为布尔值');
    const controllerSeeds=s.controllerSeeds??{red:randomInt(0,0x100000000),blue:randomInt(0,0x100000000)};
    if(SIDE.some(side=>!Number.isInteger(controllerSeeds[side])||controllerSeeds[side]<0||controllerSeeds[side]>0xffffffff))throw new Error('控制器种子必须是各阵营独立的32位非负整数');
    const fireSettings: FireSettings = this.singleFire ? validateFireSettings(s) : {};
    const {fireRateHz,minFireIntervalMs} = fireSettings;
    // A cooldown longer than the entire match can only permit the first shot.
    const baseFireTicks = fireRateHz!==undefined
      ? Math.min(Math.ceil(R.tickHz/fireRateHz),R.durationMs*R.tickHz/1000+1)
      : minFireIntervalMs===undefined ? undefined : Number((BigInt(minFireIntervalMs)*BigInt(R.tickHz)+999n)/1000n);
    const fireIntervalTicks = baseFireTicks===undefined ? undefined : Object.fromEntries(SIDE.map(side=>[
      side, ['computer','privileged'].includes(s.controllers[side]) ? Math.max(baseFireTicks,R.tickHz/TRADITIONAL_POLICY.fireHz) : baseFireTicks,
    ])) as Record<Side,number>;
    this.#ballistics = {...(this.playback ?? R),fireIntervalTicks,motionModel:this.motionModel};
    const privilegedAI = validatePrivilegedSeats(s.privilegedAI);
    for (const side of SIDE) if (s.controllers[side]==='privileged') privilegedAI[side] ??= {...DEFAULT_AI};
    this.#randomWalks={};
    for (const side of SIDE) if (s.controllers[side]==='privileged' && privilegedAI[side]?.movement==='random') {
      this.#randomWalks[side]=new RandomWalk(controllerSeeds[side]);
    }
    this.#setup = { ...structuredClone(s), ...fireSettings, ...(Object.keys(privilegedAI).length?{privilegedAI}:{}), recording:s.recording===true, controllerSeeds:{...controllerSeeds}, tuning, countdownMs: R.preparationMs, ...(s.room ? {room:normalizeRoom(s.room)} : {}) };
    if(initialState&&!this.replaying)throw new Error('初始状态恢复仅供离线回放');
    this.#keyboardSide = SIDE.find(side => s.controllers[side] === 'human');
    this.#state = initialState?structuredClone(initialState):createState(tuning,this.playback?.heatEnabled,this.playback?.bulletSpeed,this.motionModel); this.#id = randomUUID(); this.#leases = {};this.#pending={}; this.#actions = []; this.#elapsed = 0;
    this.#motion=stationaryMotion();
    this.#fire.clear();
    this.#humanAim={}; this.#assistance=[];this.#assistanceUsed=false;this.#events=[];this.#capture=undefined;this.#captureFailed=undefined;this.#recordingError='';
    this.#countdown = R.preparationMs * R.tickHz / 1000; this.#status = 'countdown'; this.#resumeStatus = 'running'; this.#imageCache = undefined;
    this.#snapshots = []; this.snapshot();
    this.#participantFrame=this.display();
  }
  action(sideInput: unknown, input: unknown, source: Controller, restoredTicks?:number, restoredProtection?:true): number {
    const side = validateSide(sideInput); let action = validateAction(input);
    if (!['running','countdown'].includes(this.#status)) throw new Error('比赛未运行');
    if (this.#setup.controllers[side] !== source) throw new Error('该席位由其他控制器占用，请在页面重新配置');
    if (this.singleFire && (source==='agent'||source==='script')) action = {...action,fire:false};
    if (this.#status === 'countdown') action = {...action,moveX:0,moveY:0,fire:false};
    if(restoredTicks!==undefined&&(!this.replaying||!Number.isInteger(restoredTicks)||restoredTicks<1||restoredTicks>R.tickHz/2))throw Error('回放动作时限无效');
    if (restoredProtection !== undefined && (!this.replaying || restoredProtection !== true || source !== 'human' || (this.playback && this.playback.humanFireHz === undefined))) {
      throw Error('回放热量保护状态无效');
    }
    const ticks = restoredTicks??(this.playback?.legacyActionTicks?Math.ceil(action.durationMs*R.tickHz/1000):leaseSteps(action.durationMs));
    if(this.replaying){this.applyAction(side,action,source,this.#elapsed+ticks,restoredProtection);return ticks;}
    const start=nextControlStep(this.#elapsed),previous=this.#pending[side];
    // One latest input per side. A brief human trigger press survives a release
    // before sampling, but only for one control period (never a whole lease).
    this.#pending[side]={action,source,until:start+ticks,firePulse:source==='human'&&(action.fire||previous?.firePulse===true)};
    return start+ticks-this.#elapsed;
  }
  fire(sideInput: unknown, source: Controller) {
    const side = validateSide(sideInput);
    if (!this.singleFire || (source!=='agent' && source!=='script') || this.#setup.controllers[side]!==source) throw Error('无权为该席位发射');
    const robot = this.#state.robots[side];
    if (this.#status!=='running' || robot.hp<=0 || robot.ammo<=0 || this.#state.tick<robot.nextShot || this.#fire.has(side)) return false;
    this.#fire.add(side);
    this.actionHistory({step:this.#elapsed,tick:this.#state.tick,side,source,fire:true});
    return true;
  }
  private applyAction(side:Side,action:Action,source:Controller,until:number,heatProtection?:true){
    this.#leases[side]={action:{...action},source,until,heatProtection};
    this.actionHistory({step:this.#elapsed,tick:this.#state.tick,side,source,action:{...action},effectiveTicks:until-this.#elapsed,...(heatProtection?{heatProtection}:{})});
  }
  // Owner-only keyboard input. Assistance is deliberately outside Action.
  humanInput(sideInput: unknown, input: unknown, assist: unknown = false): number {
    const side=validateSide(sideInput); let action=validateAction(input);
    if (this.#setup.controllers[side]!=='human'||(this.#setup.room&&keyboardSide(this.#setup.room)!==side)) throw new Error('自瞄仅供本机键鼠席位');
    if (!['running','countdown'].includes(this.#status)) throw new Error('比赛未运行');
    if (typeof assist!=='boolean') throw new Error('右键辅助标志必须为布尔值');
    const ticks=this.action(side,action,'human');
    this.#pending[side]!.assist=assist;
    return ticks;
  }
  // Host/replay only: retarget an existing human lease without extending it.
  retargetHuman(sideInput: unknown, aim: {aimX:number;aimY:number}) {
    const side=validateSide(sideInput),lease=this.#leases[side];
    if(this.#setup.controllers[side]!=='human'||lease?.source!=='human'||this.#elapsed>=lease.until) throw new Error('没有可更新的键鼠动作');
    lease.action=validateAction({...lease.action,...aim});
    this.actionHistory({step:this.#elapsed,tick:this.#state.tick,side,source:'human',aim:{aimX:aim.aimX,aimY:aim.aimY}});
  }
  private clearHumanAim(side: Side, reason: string) {
    if(!this.#humanAim[side])return;
    delete this.#humanAim[side];
    if(this.captureHistory)this.#assistance.push({step:this.#elapsed,tick:this.#state.tick,side,enabled:false,reason});
  }
  private clearHumanAssistance(reason: string) { for(const side of SIDE)this.clearHumanAim(side,reason); }
  cancel(sideInput: unknown, source: Controller) {
    const side = validateSide(sideInput);
    if (this.#setup.controllers[side] !== source) throw new Error('不能取消其他控制器');
    this.clearHumanAim(side,'cancel');
    delete this.#pending[side];
    delete this.#leases[side];
    this.#fire.delete(side);
    this.actionHistory({ step: this.#elapsed, tick: this.#state.tick, side, source, cancel: true });
  }
  advance(ticks: number) {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > R.tickHz * 2) throw new Error('推进量无效');
    for (let i = 0; i < ticks && ['running', 'countdown'].includes(this.#status); i++) {
      for(const side of SIDE)if(this.#humanAim[side]&&(!this.#leases[side]||this.#leases[side]!.until<=this.#elapsed))this.clearHumanAim(side,'input-expired');
      if(!this.replaying&&this.#elapsed%CONTROL_STEPS===0){
        for(const side of SIDE){
          const lease=this.#leases[side];
          if(lease?.steady&&this.#elapsed>=lease.pulseUntil!&&this.#elapsed<lease.until)this.applyAction(side,lease.steady,lease.source,lease.until,lease.heatProtection);
          const queued=this.#pending[side];delete this.#pending[side];
          if(!queued||queued.until<=this.#elapsed)continue;
          const sampled={...queued.action,fire:queued.action.fire||queued.firePulse};
          this.applyAction(side,sampled,queued.source,queued.until,queued.assist ? true : undefined);
          if(sampled.fire!==queued.action.fire)Object.assign(this.#leases[side]!,{steady:queued.action,pulseUntil:this.#elapsed+CONTROL_STEPS});
          if(queued.source==='human'){
            if(queued.assist){
              if(!this.#humanAim[side]){
                this.#humanAim[side]={aimX:sampled.aimX,aimY:sampled.aimY};this.#assistanceUsed=true;
                if(this.captureHistory)this.#assistance.push({step:this.#elapsed,tick:this.#state.tick,side,enabled:true,reason:'right-button'});
              }
            }else this.clearHumanAim(side,'right-button-up');
          }
        }
        // Both sides observe precisely the same frozen pre-physics state.
        const pending=SIDE.filter(side=>['computer','privileged'].includes(this.#setup.controllers[side]));
        const assisted=SIDE.filter(side=>this.#humanAim[side]);
        if(pending.length||assisted.length){
          const input=traditionalSnapshot(this.#state,this.#motion,this.#elapsed*1000/R.tickHz,this.#status,this.#ballistics.fireIntervalTicks?.[pending[0]]);
          for (const side of pending) {
            const source=this.#setup.controllers[side],seed=this.#setup.controllerSeeds![side];
            let action=source==='privileged'
              ? privilegedAction(input,side,this.#setup.privilegedAI![side]!,seed,this.#randomWalks[side])
              : computerAction(input,side,seed);
            if(this.#status==='countdown')action={...action,moveX:0,moveY:0,fire:false};
            this.applyAction(side,action,source,this.#elapsed+CONTROL_STEPS);
          }
          for(const side of assisted) {
            const aim=aimingSolution(input,side),mode=this.#humanAim[side]!;
            mode.aimX=aim.x/R.width;mode.aimY=aim.y/R.height;
            this.retargetHuman(side,{aimX:mode.aimX,aimY:mode.aimY});
          }
        }
      }
      const actions = {} as Record<Side, Action>;
      for (const side of SIDE) {
        const r = this.#state.robots[side], lease = this.#leases[side];
        if (lease && this.#elapsed < lease.until) actions[side] = lease.action;
        else {
          delete this.#leases[side]; actions[side] = neutral(r);
          const c = this.#setup.controllers[side];
          if (c === 'spinner') actions[side].spin = this.#setup.targetSpin;
          if (c === 'fixed') {
            actions[side].fire = ![R.version,'0.7.8','0.7.9'].includes(this.playback?.version ?? R.version)
              || (this.#state.tick>=r.nextShot && canFireWithoutOverheat(r.heatUnits??0,0));
            actions[side].aimX = Math.cos(r.turret)>=0?1:0;
            actions[side].aimY = 0.5;
          }
        }
        if (this.singleFire) {
          const protectedAI=this.#setup.controllers[side]==='privileged';
          const fire = this.#fire.has(side) || (actions[side].fire && this.#state.tick>=r.nextShot && (!protectedAI || canFireWithoutOverheat(r.heatUnits??0,0)));
          if (fire!==actions[side].fire) actions[side]={...actions[side],fire};
        }
      }
      this.#fire.clear();
      const before=robotPoses(this.#state.robots);
      const eventCursor=this.#state.events.length;
      if (this.#status === 'countdown') {
        prepareTick(this.#state,actions,this.playback?.legacyActionTicks,this.motionModel);this.#elapsed++;
        if (--this.#countdown === 0) { this.#status='running';this.#leases={};this.#pending={};this.clearHumanAssistance('battle-start'); }
      } else {
        const side = this.#keyboardSide;
        const fireHz = this.playback ? this.playback.humanFireHz : R.humanFireHz;
        const humanFire = side && fireHz !== undefined ? { side, fireHz, heatProtection: this.#leases[side]?.heatProtection === true } : undefined;
        try { tick(this.#state,actions,this.#ballistics,this.playback?.legacyActionTicks,humanFire); }
        catch (error) { if (error instanceof SimulationNumericsError) this.stop(); throw error; }
        this.#elapsed++;
      }
      this.#motion=observedMotion(before,this.#state.robots);
      if(this.captureHistory)this.#events.push(...this.#state.events.slice(eventCursor));
      if(!this.legacyEvents)this.#state.events=this.#state.events.filter(event=>this.#state.tick-event.tick<=R.tickHz*.4);
      if (this.#elapsed % (R.tickHz / 2) === 0 || this.#state.winner) this.snapshot();
      if (this.#state.winner) { this.#status = 'ended'; this.#leases = {};this.#pending={};this.clearHumanAssistance('ended'); }
      if(this.#elapsed%CONTROL_STEPS===0||this.#state.winner)this.#participantFrame=this.display();
      if(this.recording&&this.#capture&&(this.#elapsed%8===0||this.#state.winner))this.#capture(this.display(),this.#elapsed);
    }
  }
  private snapshot() { if(this.captureHistory)this.#snapshots.push({step:this.#elapsed,tick:this.#state.tick,status:this.#status,countdownMs:this.countdownMs,state:structuredClone(this.#state),motion:structuredClone(this.#motion)}); }
  pause() { if (this.#status === 'running' || this.#status === 'countdown') { this.#resumeStatus = this.#status; this.#status = 'paused'; this.#leases = {};this.#pending={};this.#fire.clear();this.clearHumanAssistance('paused');this.#motion=stationaryMotion(); this.actionHistory({ step: this.#elapsed, tick: this.#state.tick, pause: true }); } }
  resume() { if (this.#status === 'paused') { this.#status = this.#resumeStatus; this.actionHistory({ step: this.#elapsed, tick: this.#state.tick, resume: true }); } }
  stop() { this.#leases = {};this.#pending={};this.#fire.clear();this.clearHumanAssistance('stopped');this.#motion=stationaryMotion(); this.#countdown = 0; this.#status = 'stopped'; this.actionHistory({ step: this.#elapsed, tick: this.#state.tick, stop: true }); }
  observe(): OwnerObservation {
    const key = `${this.#elapsed}:${this.#status}`;
    if (this.#imageCache?.key !== key) this.#imageCache = { key, value: render(this.#state, this.#status, this.countdownMs).toString('base64') };
    return { ...this.metadata(), image: { mimeType: 'image/png', width: R.width, height: R.height + 80, base64: this.#imageCache.value } };
  }
  metadata(): Omit<OwnerObservation, 'image'> {
    const hud = Object.fromEntries(SIDE.map(side => { const r = this.#state.robots[side]; return [side, { hp: r.hp, ammo: r.ammo, shots: r.shots, hits: r.hits, ...(r.heatUnits===undefined?{}:{heat:r.heatUnits/R.tickHz}) }]; })) as OwnerObservation['hud'];
    return { version: this.playback?.version??R.version, matchId: this.#id, timestampMs: this.#state.tick * 1000 / R.tickHz, countdownMs: this.countdownMs, rules: { ...this.#state.tuning }, clock: this.clock, status: this.#status, scenario: this.#setup.scenario, winner: this.#state.winner, ...(this.#state.overheatDeaths ? {overheatDeaths:[...this.#state.overheatDeaths]} : {}), hud, controller: { ...this.#setup.controllers } };
  }
  // Owner-only rendering channel. participant() must never expose this method.
  participantFrame():DisplayFrame {
    return this.#participantFrame?.status===this.#status?this.#participantFrame:this.display();
  }
  display(): DisplayFrame {
    const robots = Object.fromEntries(SIDE.map(side => { const { x,y,angle,turret,hp,ammo,shots,hits,heatUnits } = this.#state.robots[side]; return [side,{side,x,y,angle,turret,hp,ammo,shots,hits,heatUnits}]; })) as DisplayFrame['scene']['robots'];
    return { matchId: this.#id, timestampMs: this.#state.tick * 1000 / R.tickHz, countdownMs: this.countdownMs, status: this.#status, scene: { tick:this.#state.tick, tuning:{...this.#state.tuning}, robots, bullets:this.#state.bullets.map(b=>({...b})), events:this.#state.events.filter(e=>this.#state.tick-e.tick<=R.tickHz*0.4).map(e=>({...e})), winner:this.#state.winner, overheatDeaths:this.#state.overheatDeaths?.slice() } };
  }
  refereeFrame(index: unknown) {
    if (['running', 'countdown', 'paused'].includes(this.#status)) throw new Error('比赛结束后才可查看裁判回放');
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= this.#snapshots.length) throw new Error('回放帧越界');
    const frame = this.#snapshots[index as number];
    return { timestampMs: frame.tick * 1000 / R.tickHz, countdownMs:frame.countdownMs, status:frame.status, image: { mimeType: 'image/png', width: R.width, height: R.height + 80, base64: render(frame.state, frame.state.winner ? 'ended' : frame.status, frame.countdownMs).toString('base64') } };
  }
  // Adjudicator-only entry. Never registered as a model tool or script capability.
  refereeRecord() {
    const {heat,humanFireHz,minFireIntervalMs,...rules}=R;
    const {maxSpeed,maxSpin} = motionCalibration(this.motionModel);
    const fireSettings: FireSettings = this.singleFire ? validateFireSettings(this.#setup) : {};
    const keyboardRules = this.playback ? this.playback.humanFireHz : humanFireHz;
    const controllerImplementations = Object.fromEntries(SIDE
      .filter(side=>['computer','privileged'].includes(this.#setup.controllers[side]))
      .map(side=>[side,this.#setup.controllers[side]==='privileged'
        ? {...PRIVILEGED_AI,input:'robot-full-state',config:{...this.#setup.privilegedAI![side]}}
        : {...COMPUTER,input:'robot-full-state',policy:{...TRADITIONAL_POLICY}}]));
    return { format: 'laboratory-referee-v2', version: this.playback?.version??R.version, matchId: this.#id, rules: { ...rules, maxSpeed, maxSpin, ...fireSettings, ...(this.playback?.heatEnabled===false?{}:{heat}), ...(keyboardRules===undefined?{}:{humanFireHz:keyboardRules}), ...this.#state.tuning,version:this.playback?.version??R.version,bulletSpeed:this.playback?.bulletSpeed??R.bulletSpeed,fireHz:this.playback?.fireHz??R.fireHz,...(this.playback?.legacyActionTicks?{}:{controlHz:CONTROL_HZ,controlSteps:CONTROL_STEPS}) }, setup: this.setup, controllerImplementations, humanAimAssist: {used:this.#assistanceUsed,privileged:true,implementation:COMPUTER.implementation,algorithm:'aimingSolution',decisionMs:TRADITIONAL_POLICY.decisionMs,events:structuredClone(this.#assistance)}, finalTick: this.#state.tick, finalStep: this.#elapsed, status: this.#status, actions: structuredClone(this.#actions), recordingEnabled:this.recording,...(this.#recordingError?{recordingError:this.#recordingError}:{}),events: structuredClone(this.#events), snapshots: structuredClone(this.#snapshots), finalState: structuredClone(this.#state),finalMotion:structuredClone(this.#motion) };
  }
}
