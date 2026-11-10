import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SoundEvents, readBattleAudio } from '../src/client/battle-audio.js';
import type { DisplayFrame, DisplayScene } from '../src/shared/scene.js';
import { Game } from '../src/host/game.js';

test('audio events deduplicate polls, discard stale history and distinguish destruction from timeout',()=>{
  const audio=new SoundEvents();
  const base=new Game().display();
  const frame=(tick:number,events:DisplayScene['events'],status:DisplayFrame['status']='running',matchId='one') =>
    ({...base,status,matchId,scene:{...base.scene,tick,events}});
  assert.equal(readBattleAudio(),false);
  const old={tick:19,type:'shot'},shot={tick:20,type:'shot'},hit={tick:20,type:'hit',hp:10};
  assert.deepEqual(audio.take(frame(20,[old])),[]);
  assert.deepEqual(audio.take(frame(21,[old,shot,hit])),['shot','hit']);
  assert.deepEqual(audio.take(frame(21,[old,shot,hit])),[]);
  assert.deepEqual(audio.take(frame(22,[shot,hit,{tick:22,type:'end'}],'ended')),[]);
  audio.take(frame(25,[],'running','two'));
  assert.deepEqual(audio.take(frame(26,[{tick:25,type:'hit',hp:0}],'ended','two')),['destroy']);
  audio.take(frame(30,[],'running','three'));
  audio.take(frame(31,[{tick:30,type:'shot'}],'paused','three'));
  assert.deepEqual(audio.take(frame(32,[{tick:30,type:'shot'}],'running','three')),[]);
  assert.deepEqual(audio.take(frame(120,[{tick:33,type:'shot'},{tick:119,type:'hit',hp:2}],'running','three')),['hit']);
});
