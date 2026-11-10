import React from 'react';
import { RULES, TUNING_FIELDS, validateFireSettings, validateTuningField, type ScriptChoice, type Side } from '../shared/protocol.js';
import { numericInput } from './controls.js';
import { KEYBOARD, keyboardSide, upgradeRoomAI } from '../shared/room.js';
import { AI_OPTIONS, DEFAULT_AI, PRIVILEGED_AI, type PrivilegedAI } from '../shared/privileged-ai.js';
import { labels, type Setup } from './types.js';
import { canEnterRoom, createRoomSetup, selectRoomController, validateRoomSetup, type ConnectionState } from './room.js';
export interface RoomPanelProps {
  setup: Setup; scripts: ScriptChoice[]; playerSide: Side; connection: ConnectionState; connectionError: string; busy: boolean;
  change(setup: Setup): void; selectSide(side: Side): void; enter(): void; retry(): void;
  existingMatch?: boolean; continueMatch(): void; recording?:boolean; saving?:boolean; record?(enabled:boolean):void; recordingNotice?:React.ReactNode;
}
function RobotPreview({ side }: { side: Side }) {
  const armorOffset=RULES.spawnArmorAngle*180/Math.PI;
  return <svg className="room-robot" viewBox="0 0 240 180" aria-label={`${labels[side]}机体预览`} role="img"><circle cx="120" cy="90" r="58" fill="none" stroke="currentColor" opacity=".14"/><circle className="robot-body" cx="120" cy="90" r={RULES.bodyRadius * 1.5} fill="#171c25"/><circle cx="120" cy="90" r={RULES.bodyRadius * 1.5 - 0.75} fill="none" stroke="#8591a4" strokeWidth="1.5"/><path d="M120 61v58M91 90h58" stroke="#c6ceda" strokeWidth="5"/><g fill="currentColor" transform="translate(120 90) scale(1.5)">{[0, 90, 180, 270].map(angle => <rect key={angle} transform={`rotate(${angle+armorOffset})`} x={RULES.radius - RULES.plateThickness / 2} y={-RULES.plateLength / 2} width={RULES.plateThickness} height={RULES.plateLength}/>)}</g><circle cx="120" cy="90" r="15" fill="#141b29" stroke="#b9c2d1"/><g className="robot-barrel" transform={`rotate(${side === 'red' ? 180 : 0} 120 90)`}><path d="M120 90L77 65" stroke="#07121d" strokeWidth="10"/><path d="M120 90L77 65" stroke="#d9edf2" strokeWidth="5"/></g></svg>;
}
export function RoomPanel({ setup, scripts, connection, connectionError, busy, change, selectSide, enter, retry, existingMatch, continueMatch, recording, saving, record, recordingNotice }: RoomPanelProps) {
  const {room,privilegedAI} = upgradeRoomAI(setup.room ?? createRoomSetup().room!,setup.privilegedAI);
  const tuning = setup.tuning === undefined
    ? { hp: RULES.hp, damage: RULES.damage, power: RULES.power }
    : { ...setup.tuning, power: setup.tuning?.power === undefined ? RULES.power : setup.tuning.power };
  const draft = { ...setup, room, tuning, privilegedAI }, errors = validateRoomSetup(draft, scripts);
  const fields = ['hp','damage','power'] as const;
  const fieldErrors: Partial<Record<typeof fields[number],string>> = {};
  for (const field of fields) {
    try { validateTuningField(field, tuning[field]); }
    catch(error) { fieldErrors[field]=(error as Error).message; }
  }
  const fireRate = setup.fireRateHz ?? 1000 / (setup.minFireIntervalMs ?? RULES.minFireIntervalMs);
  let fireRateError = '';
  try { validateFireSettings(setup); } catch (error) { fireRateError = (error as Error).message; }
  const otherErrors=errors.filter(error=>error!==fireRateError&&!Object.values(fieldErrors).includes(error));
  const choose = (side: Side, value: string) => {
    const next=selectRoomController(draft,side,value);change(next);
    const keyboard=keyboardSide(next.room);if(keyboard)selectSide(keyboard);
  };
  const aiFields = Object.keys(AI_OPTIONS) as (keyof PrivilegedAI)[];
  const aiLabels = {movement:'移动',rotation:'旋转',shooting:'射击'};
  const seat = (side: Side) => <article key={side} className={`room-seat ${side}${room.seats[side]===KEYBOARD?' is-player':''}`}>
    <header><span>{labels[side]}</span></header>
    <RobotPreview side={side}/>
    <div className="room-role-select"><div className="room-controller-heading"><label htmlFor={`controller-${side}`}>控制者</label></div>
      <select id={`controller-${side}`} aria-label={`${labels[side]}控制者`} value={room.seats[side]} disabled={busy} onChange={e=>choose(side,e.target.value)}>
        <option value={KEYBOARD}>键盘输入</option>
        {scripts.map(script=><option key={script.id} value={script.id}>{script.name}</option>)}
      </select>
      {room.seats[side]===PRIVILEGED_AI.id&&<div className="room-ai-options">
        {aiFields.map(field=>{
          const config=privilegedAI[side]??DEFAULT_AI;
          return <label key={field}><span>{aiLabels[field]}</span><select aria-label={`${labels[side]}${aiLabels[field]}`} disabled={busy} value={config[field]} onChange={event=>change({...draft,privilegedAI:{...privilegedAI,[side]:{...config,[field]:event.target.value}}})}>
            {Object.entries(AI_OPTIONS[field]).map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select></label>;
        })}
      </div>}
    </div>
  </article>;
  return <main className="room-page">

    <div className="room-layout">{seat('red')}
      <aside className="room-options" aria-label="对局设置"><h3>机器人性能参数</h3>
        <section className="room-performance" aria-label="机器人性能参数">
          {fields.map(field=>{
            const {min,max}=TUNING_FIELDS[field],error=fieldErrors[field];
            const label=field==='hp'?'血量':TUNING_FIELDS[field].label;
            return <label key={field}><span>{label}：</span><input aria-label={label} aria-invalid={!!error} aria-describedby={error?`room-${field}-error`:undefined} type="number" min={min} max={max} step={1} disabled={busy} value={Number.isFinite(tuning[field])?tuning[field]:''} onChange={e=>change({...draft,tuning:{...tuning,[field]:numericInput(e.target.value)}})}/>{error&&<small className="room-field-error" id={`room-${field}-error`} role="alert">{error}</small>}</label>;
          })}
          <label><span>射速：</span><input aria-label="射速" type="number" step="any" disabled={busy} aria-invalid={!!fireRateError} aria-describedby={fireRateError?'room-fire-rate-error':undefined} value={Number.isFinite(fireRate)?fireRate:''} onChange={e=>change({...draft,minFireIntervalMs:undefined,fireRateHz:numericInput(e.target.value)})}/>{fireRateError&&<small className="room-field-error" id="room-fire-rate-error" role="alert">{fireRateError}</small>}</label>
        </section>
        {connection==='ready'&&otherErrors.length>0&&<div className="room-validation" role="alert">{otherErrors.map(error=><p key={error}>{error}</p>)}</div>}
        {connection!=='ready'&&<div className={`room-connection ${connection}`} role="status"><i/>{connection==='connecting'?'正在连接…':connection==='error'?'连接失败':''}{connection==='error'&&<button disabled={busy} onClick={retry}>重试连接</button>}</div>}
        {connectionError&&<p className="room-connection-error">{connectionError}</p>}
        {record&&<label className="room-record"><input type="checkbox" checked={!!recording} disabled={busy} onChange={event=>record(event.target.checked)}/>录制本局</label>}
        <button className="game-primary room-enter" data-testid="enter-match" disabled={!canEnterRoom(connection,busy)||saving||errors.length>0} onClick={enter}>{busy?'准备中…':'进入对局'}<span>→</span></button>
        {existingMatch&&<button className="game-text-button room-continue" disabled={!canEnterRoom(connection,busy)} onClick={continueMatch}>继续对局</button>}
        {recordingNotice}
      </aside>{seat('blue')}
    </div>
  </main>;
}
