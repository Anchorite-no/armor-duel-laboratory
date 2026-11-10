import React from 'react';
import type { OwnerObservation } from '../shared/protocol.js';
export function MatchStats({hud}:{hud:OwnerObservation['hud']}) {
  return <div className="match-stats">{(['red','blue'] as const).map(side=>{
    const robot=hud[side],rate=robot.shots>0?Math.round(robot.hits/robot.shots*1000)/10:0;
    return <section key={side} className={`match-stats-${side}`} aria-label={`${side==='red'?'红':'蓝'}方统计`}><h3>{side==='red'?'红方':'蓝方'}</h3><dl>
      <dt>发弹量</dt><dd>{robot.shots}</dd><dt>命中数</dt><dd>{robot.hits}</dd><dt>命中率</dt><dd>{rate}%</dd><dt>剩余血量</dt><dd>{robot.hp}</dd>
    </dl></section>;
  })}</div>;
}
