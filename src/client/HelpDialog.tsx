import React, { useEffect, useRef } from 'react';
import { RULES, TUNING_FIELDS, validateTuningField, type TuningInput } from '../shared/protocol.js';
import { motionCaps } from '../shared/motion.js';

export function HelpDialog({ tuning, close }: { tuning?:TuningInput; close():void }) {
  const dialog=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;closeButton.current?.focus();
    return ()=>previous?.focus();
  },[]);
  let caps: ReturnType<typeof motionCaps>|undefined;
  try { caps=motionCaps(validateTuningField('power', tuning?.power === undefined ? RULES.power : tuning.power)); } catch {}
  const keyDown=(event:React.KeyboardEvent)=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.key!=='Tab')return;
    const items=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]');
    if(!items?.length)return;
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  };
  return <div className="game-modal-shade" onPointerDown={event=>{if(event.target===event.currentTarget)close();}}>
    <section ref={dialog} id="game-help-dialog" className="game-modal game-help" role="dialog" aria-modal="true" aria-labelledby="game-help-title" onKeyDown={keyDown}>
      <button ref={closeButton} className="game-modal-close" aria-label="关闭帮助" onClick={close}>×</button>
      <h2 id="game-help-title">操作与参数说明</h2>
      <h3>操作</h3><dl>
        <dt>W / A / S / D</dt><dd>上下左右移动</dd>
        <dt>鼠标 / 左键</dt><dd>瞄准 / 持续开火，空格也可开火</dd>
        <dt>按住右键</dt><dd>装甲预测自瞄与热量保护。配合左键或空格开火，过热时暂缓，散热后继续。松开右键恢复手动瞄准与无保护开火。</dd>
        <dt>Q / E</dt><dd>逆 / 顺时针旋转。无平移输入时用满旋转功率，有平移输入时以 60% 转速旋转。同键再按停止，反键换向，长按只切换一次，松键保持。</dd>
        <dt>X / Esc</dt><dd>停止旋转 / 暂停或继续</dd>
      </dl>
      <p>控制者选择保存在各自阵营；本机只有一套键鼠，另一侧选择键盘时自动转移绑定。没有键盘席位时可观战。固定 5 秒准备期允许旋转与瞄准，移动和射击锁定。</p>
      <h3>机器人性能参数</h3>
      <p>{Object.values(TUNING_FIELDS).map(({label,min,max})=>`${label} [${min}, ${max}]`).join('、')}，均为整数。默认生命值 200、攻击力 10、功率 50。参数用于同一轮的所有机器人。</p>
      <p>射速按每秒发数填写，默认 20 发/秒，相邻两发至少间隔 50 毫秒。可输入正有限小数，最小间隔按物理步向上取整。键鼠与特权 AI 仍以 10 发/秒为常态上限。</p>
      <dl><dt>当前纯移动上限</dt><dd>{caps?(caps.maxSpeed/RULES.bodyDiameter).toFixed(2):'—'} m/s</dd><dt>当前纯旋转上限</dt><dd>{caps?caps.maxSpin.toFixed(2):'—'} rad/s</dd><dt>弹速 / 玩家默认射速上限</dt><dd>{(RULES.bulletSpeed/RULES.bodyDiameter).toFixed(2)} m/s · {RULES.humanFireHz} 发/s</dd></dl>
      <h3>枪械热量</h3>
      <p>开局热量为 0。每发射一颗子弹增加 {RULES.heat.perShot} 热量，战斗中每秒散去 {RULES.heat.coolingPerSecond}。无保护开火时，若发射后超过 {RULES.heat.limit}，该发扣除最大生命值的 {RULES.heat.maxHpFraction * 100}%，可能导致损毁。特权 AI 会主动控热。</p>
      <p>底盘直径为 1 米。功率 50 时，纯移动上限为 4 m/s，纯旋转上限为 8 rad/s。上限随功率的平方根缩放。混合请求超出预算时，两种速度按同一比例缩小。</p>
      <h3>命中、胜负与对手</h3>
      <p>四块装甲可受伤；非装甲底盘挡弹但不扣血，炮管不挡弹。正式战斗限时 {RULES.durationMs / 1000} 秒。击毁对手即获胜，时间耗尽时按剩余血量判胜负，同步致命或超时同血量则平局。</p>
      <p>特权 AI 分别配置移动、旋转和射击，自动暂缓会超热的发射。右键自瞄与预判射击共用预测，玩家自行决定何时开火。</p>
      <button className="game-primary" onClick={close}>关闭帮助</button>
    </section>
  </div>;
}
