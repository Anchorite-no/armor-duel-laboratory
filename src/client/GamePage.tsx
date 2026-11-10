import React,{useCallback,useEffect,useRef,useState} from 'react';
import { RULES,type Side } from '../shared/protocol.js';
import { pointerAim,isEditableTarget } from './controls.js';
import { HumanInput,canUseHumanInput,humanSide,type InputContext } from './human-input.js';
import { resultHeading,resultDetail,type Api,type Setup,type View } from './types.js';
import { RoomPanel } from './RoomPanel.js';
import { HelpDialog } from './HelpDialog.js';
import { MatchStats } from './MatchStats.js';
import { RecordingFiles } from './RecordingFiles.js';
import { BattleCanvas } from './BattleCanvas.js';
import { BattleAudio, readBattleAudio, saveBattleAudio } from './battle-audio.js';
import { createRoomSetup,validateRoomSetup,freshMatchSetup,type ConnectionState } from './room.js';
export function LaboratoryPage({api}:{api:Api}) {
  const [view,setView]=useState<View>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [phase,setPhase]=useState<'room'|'battle'>('room'),[roomSetup,setRoomSetup]=useState<Setup>(()=>createRoomSetup());
  const [connection,setConnection]=useState<ConnectionState>('connecting'),[connectionError,setConnectionError]=useState('');
  const [recordNext,setRecordNext]=useState(false),[focused,setFocused]=useState(false),[assisting,setAssisting]=useState(false),[hurt,setHurt]=useState(false);
  const [activeSide,setActiveSide]=useState<Side>('red'),[helpOpen,setHelpOpen]=useState(false);
  const [sound,setSound]=useState(readBattleAudio),[audio]=useState(()=>new BattleAudio(sound));
  const audioBlocked=useRef(false);
  const arena=useRef<HTMLDivElement>(null),input=useRef(new HumanInput());
  const live=useRef({view,focused,activeSide,phase,connection,helpOpen,busy});live.current={view,focused,activeSide,phase,connection,helpOpen,busy};
  const inputPending=useRef<Promise<unknown>>(),lease=useRef<{side:Side;matchId:string}>(),lastInput=useRef(0),generation=useRef(0),starting=useRef(false);
  const refreshConnection=useRef<()=>void>(()=>{}),previousHp=useRef<number>(RULES.hp);
  const context=():InputContext=>{
    const current=live.current;
    return {phase:current.phase,connection:current.connection,setup:current.view?.setup,matchId:current.view?.observation.matchId,status:current.view?.observation.status,side:current.activeSide,focused:current.focused,blocked:current.helpOpen||current.busy};
  };
  const syncState=()=>{setAssisting(input.current.aimAssist);};
  const run=useCallback(async(method:string,payload?:unknown)=>{
    const id=++generation.current;setError('');
    try{const result=await api(method,payload);if(result&&typeof result==='object'&&'observation' in result&&id===generation.current)setView(result as View);return result;}
    catch(e){setError(e instanceof Error?e.message:String(e));return undefined;}
  },[api]);
  const release=useCallback(()=>{
    input.current.reset();setAssisting(false);live.current.focused=false;setFocused(false);
    const owner=lease.current;lease.current=undefined;if(!owner)return;
    const cancel=()=>api('release',owner).catch(()=>{});
    const pending=inputPending.current;
    // Keep later input blocked until the old in-flight input and both releases
    // settle. The round ID also prevents an old release cancelling a new round.
    const cleanup=Promise.allSettled([cancel(),pending]).then(cancel).finally(()=>{if(inputPending.current===cleanup)inputPending.current=undefined;});
    inputPending.current=cleanup;
  },[api]);
  useEffect(()=>{
    let disposed=false,polling=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      if(disposed||polling)return;
      if(document.hidden){timer=setTimeout(()=>void poll(),500);return;}
      polling=true;const id=generation.current;let failed=false;
      try{const value=await api('view') as View;if(!disposed&&id===generation.current){setView(value);setConnection('ready');setConnectionError('');if(value.controllerError)setError(value.controllerError);}}
      catch(e){failed=true;if(!disposed&&id===generation.current){setConnection('error');setConnectionError(e instanceof Error?e.message:String(e));}}
      finally{polling=false;if(!disposed)timer=setTimeout(()=>void poll(),failed?2000:1000);}
    };
    refreshConnection.current=()=>{clearTimeout(timer);void poll();};void poll();
    return()=>{disposed=true;clearTimeout(timer);refreshConnection.current=()=>{};input.current.reset();const owner=lease.current;if(owner)void api('release',owner).catch(()=>{});};
  },[api]);
  useEffect(()=>{
    const hidden=()=>{if(document.hidden)release();};window.addEventListener('blur',release);document.addEventListener('visibilitychange',hidden);
    return()=>{window.removeEventListener('blur',release);document.removeEventListener('visibilitychange',hidden);};
  },[release]);
  useEffect(()=>{
    const hidden=()=>{if(document.hidden)audio.silence();};
    document.addEventListener('visibilitychange',hidden);
    return()=>{document.removeEventListener('visibilitychange',hidden);audio.dispose();};
  },[audio]);
  const sendInput=(force=false)=>{
    const packet=input.current.packet(context());
    if(!packet||inputPending.current||(!force&&performance.now()-lastInput.current<16))return;
    lastInput.current=performance.now();lease.current={side:packet.side,matchId:packet.matchId};
    const pending=api('input',packet).then(()=>input.current.acknowledge(packet)).catch(e=>{if(canUseHumanInput(context()))setError(String(e));}).finally(()=>{if(inputPending.current===pending)inputPending.current=undefined;});
    inputPending.current=pending;
  };
  const send=useRef(sendInput);send.current=sendInput;
  useEffect(()=>{
    let raf=0,last=-1;
    const sample=(now:number)=>{const slot=Math.floor(now*60/1000);if(slot!==last){last=slot;send.current(true);}raf=requestAnimationFrame(sample);};
    raf=requestAnimationFrame(sample);return()=>cancelAnimationFrame(raf);
  },[]);
  const savingRecording=view?.recording?.status==='saving';
  const o=view?.observation,eligible=canUseHumanInput(context()),assigned=humanSide(view?.setup);
  useEffect(()=>{release();},[phase,o?.matchId,assigned,activeSide,release]);
  useEffect(()=>{if(!eligible)release();},[eligible,release]);
  useEffect(()=>{
    const hp=o?.hud[activeSide].hp??RULES.hp;
    if(eligible&&hp<previousHp.current){setHurt(true);const timer=setTimeout(()=>setHurt(false),190);previousHp.current=hp;return()=>clearTimeout(timer);}
    previousHp.current=hp;setHurt(false);
  },[o?.hud[activeSide].hp,activeSide,eligible]);
  const begin=async(setup:Setup)=>{
    if(starting.current||savingRecording)return;
    if(connection!=='ready'){setError('尚未连接，请重试。');return;}
    if(setup.room){const errors=validateRoomSetup(setup,view?.scripts??[]);if(errors.length){setError(errors.join('；'));return;}}
    starting.current=true;setBusy(true);release();
    audio.silence();
    const next=freshMatchSetup(setup,recordNext);
    const result=await run('start',{setup:next}) as View|undefined;
    if(result){const side=humanSide(result.setup);if(side)setActiveSide(side);setRecordNext(false);setRoomSetup(next);setPhase('battle');setHelpOpen(false);previousHp.current=setup.tuning?.hp??RULES.hp;setHurt(false);}
    starting.current=false;setBusy(false);
  };
  const returnRoom=async()=>{
    if(starting.current)return;starting.current=true;setBusy(true);release();
    audioBlocked.current=true;audio.silence();
    try{if(['running','countdown','paused'].includes(live.current.view?.observation.status??'')){if(!await run('stop'))return;}setPhase('room');setRecordNext(false);setHelpOpen(false);}
    finally{audioBlocked.current=false;starting.current=false;setBusy(false);}
  };
  const resume=async()=>{release();if(inputPending.current)await inputPending.current;await run('resume');};
  const pause=()=>{release();audioBlocked.current=true;audio.silence();void run('pause').finally(()=>{audioBlocked.current=false;});};
  const openHelp=()=>{release();if(phase==='battle'&&['running','countdown'].includes(o?.status??''))pause();setHelpOpen(true);};
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||event.repeat||event.isComposing||isEditableTarget(event.target))return;
      event.preventDefault();if(helpOpen){setHelpOpen(false);return;}
      if(live.current.phase!=='battle')return;
      if(live.current.view?.observation.status==='paused')void resume();else pause();
    };
    window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
  },[helpOpen,release,run]);
  const keyDown=(event:React.KeyboardEvent)=>{
    if(event.defaultPrevented||event.nativeEvent.isComposing||isEditableTarget(event.target))return;
    const key=event.key.toLowerCase();
    if(key==='escape'){event.preventDefault();event.stopPropagation();if(!event.repeat){if(o?.status==='paused')void resume();else pause();}return;}
    if(key==='?'){event.preventDefault();if(!event.repeat)openHelp();return;}
    if(input.current.keyDown(context(),key,event.repeat)){event.preventDefault();syncState();sendInput(true);}else syncState();
  };
  const movePointer=(event:React.PointerEvent)=>{
    if(!canUseHumanInput(context()))return;
    const surface=arena.current?.querySelector('canvas');if(!surface)return;
    const bounds=surface.getBoundingClientRect(),aim=pointerAim(event.clientX,event.clientY,bounds);
    if(!input.current.aim(context(),aim.x,aim.y))return;
    arena.current?.style.setProperty('--aim-x',`${Math.max(0,Math.min(100,(event.clientX-bounds.left)/bounds.width*100))}%`);
    arena.current?.style.setProperty('--aim-y',`${Math.max(0,Math.min(100,(event.clientY-bounds.top)/bounds.height*100))}%`);sendInput();
  };
  const syncButtons=(buttons:number)=>{const accepted=input.current.buttons(context(),buttons);syncState();if(accepted)sendInput(true);};
  const stopOverlayEvent=(event:React.SyntheticEvent)=>event.stopPropagation();
  return <div className={'armor-game'+(hurt?' is-hurt':'')} onPointerDownCapture={()=>audio.unlock()} onKeyDownCapture={()=>audio.unlock()}>
    <header className="game-header"><h1>装甲对决</h1><nav>
      {phase==='battle'&&view?.recording?.status==='recording'&&<span className="recording-active">● 录制中</span>}
      {phase==='battle'&&<button disabled={busy} onClick={()=>void returnRoom()}>返回房间</button>}
      {phase==='battle'&&['running','countdown'].includes(o?.status??'')&&<button onClick={pause}>暂停</button>}
      <button type="button" aria-label="音效" aria-pressed={sound} onClick={()=>{const enabled=!sound;audio.setEnabled(enabled);saveBattleAudio(enabled);setSound(enabled);}}>音效{sound?'开':'关'}</button>
      <button className="game-icon-button" onClick={openHelp} aria-label="操作说明" aria-haspopup="dialog" aria-expanded={helpOpen}>?</button>
    </nav></header>
    {phase==='battle'&&view?.recording?.status==='error'&&!['ended','stopped'].includes(o?.status??'')&&<div className="game-error" role="alert">录制失败：{view.recording.error}</div>}
    {(error||(phase==='battle'&&connectionError))&&<div className="game-error" role="alert">{error||connectionError}<button aria-label="关闭错误提示" onClick={()=>{setError('');setConnectionError('');}}>×</button></div>}
    {phase==='room'?<RoomPanel setup={roomSetup} scripts={view?.scripts??[]} playerSide={activeSide} connection={connection} connectionError={connectionError} busy={busy} saving={savingRecording} change={setup=>{release();setRoomSetup(setup);}} selectSide={side=>{release();setActiveSide(side);}} enter={()=>void begin(roomSetup)} retry={()=>{setConnection('connecting');refreshConnection.current();}} recording={recordNext} record={setRecordNext} recordingNotice={<RecordingFiles info={view?.recording} open={()=>void run('recordingOpen')}/>} existingMatch={!!o&&['running','countdown','paused'].includes(o.status)} continueMatch={()=>{if(view&&connection==='ready'){release();setRecordNext(false);setRoomSetup(structuredClone(view.setup));const side=humanSide(view.setup);if(side)setActiveSide(side);setPhase('battle');}}}/>:<main className="game-field">
      <div ref={arena} className={'game-stage'+(focused&&eligible?' is-focused':'')} tabIndex={eligible?0:-1} role={eligible?'application':'img'} aria-label="装甲对决战场" onFocus={()=>{if(canUseHumanInput(context())){live.current.focused=true;setFocused(true);}}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))release();}} onKeyDown={keyDown} onKeyUp={event=>{if(isEditableTarget(event.target))return;if(input.current.keyUp(context(),event.key.toLowerCase()))sendInput(true);syncState();}} onPointerMove={movePointer} onPointerDown={event=>{
        if(!canUseHumanInput(context())||![0,2].includes(event.button))return;
        event.currentTarget.focus();live.current.focused=true;setFocused(true);event.currentTarget.setPointerCapture(event.pointerId);movePointer(event);syncButtons(event.buttons);
      }} onMouseDown={event=>{if(canUseHumanInput(context())&&[0,2].includes(event.button))syncButtons(event.buttons);}} onMouseUp={event=>syncButtons(event.buttons)} onPointerUp={event=>syncButtons(event.buttons)} onLostPointerCapture={()=>syncButtons(0)} onContextMenu={event=>event.preventDefault()}>
        <BattleCanvas key={o?.matchId} api={api} onFrame={frame=>{if(!audioBlocked.current)audio.frame(frame);}} onStatus={value=>setView(old=>old&&old.observation.matchId===value.observation.matchId?{...old,recording:value.recording??old.recording,observation:{...value.observation,image:old.observation.image}}:old)} onError={setError}/>
        {eligible&&focused&&<span className="game-reticle"/>}
        {eligible&&focused&&assisting&&<span className="game-aim-assist" role="status">自瞄已启用</span>}
        {o?.status==='countdown'&&<span className="game-countdown-announcement" role="status">准备 {Math.max(1,Math.ceil(o.countdownMs/1000))}</span>}
        {o?.status==='paused'&&<div className="game-overlay game-pause" onPointerDown={stopOverlayEvent} onKeyDown={stopOverlayEvent}><h2>已暂停</h2><button className="game-primary" onClick={()=>void resume()}>继续</button></div>}
        {o&&['ended','stopped'].includes(o.status)&&<div className="game-overlay game-result" onPointerDown={stopOverlayEvent} onKeyDown={stopOverlayEvent}><h2>{o.status==='stopped'?'对局已停止':resultHeading(o.winner)}</h2>{o.status==='ended'&&<p>{resultDetail(o)}</p>}<MatchStats hud={o.hud}/><RecordingFiles info={view?.recording} open={()=>void run('recordingOpen')}/><div className="game-result-actions"><button className="game-primary" disabled={busy||savingRecording||connection!=='ready'} onClick={()=>void begin(roomSetup)}>再来一局</button></div></div>}
        {eligible&&!focused&&<button className="game-focus-hint" onClick={()=>arena.current?.focus()}>点击操控</button>}
      </div>
    </main>}
    {helpOpen&&<HelpDialog tuning={phase==='room'?roomSetup.tuning:o?.rules} close={()=>setHelpOpen(false)}/>}
  </div>;
}
