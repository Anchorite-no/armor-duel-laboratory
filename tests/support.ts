import { Game } from '../src/host/game.js';
import { Laboratory } from '../src/host/service.js';
import type { VisionConfig } from '../src/shared/vision.js';
import { neutral } from '../src/host/physics.js';
// Historical adjudication tests explicitly opt into in-memory diagnostics.
// The production constructors keep full capture off unless recording is chosen.
export class TracedGame extends Game { constructor(replaying=false,legacyEvents=false){super(replaying,legacyEvents,true);} }
export class TracedLaboratory extends Laboratory { constructor(directory?:string,vision?:VisionConfig){super(directory,vision,true);} }
// Existing battle tests explicitly pass the fixed preparation interval first.
export function finishPreparation(game: Game) { while(game.status==='countdown')game.advance(Math.min(480,Math.ceil(game.countdownMs*240/1000))); }
export function startReady(game: Game, setup: unknown) { game.start(setup); finishPreparation(game); }
export function neutralMotion() { const {fire,...motion}=neutral(); return motion; }
