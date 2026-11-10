import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegPath } from './recorder.js';
import type { RecordingInfo } from '../shared/recording.js';

const execute = promisify(execFile);
const failed = () => Error('Participant request failed.');
type SavedRecording = {recordingName:string; durationMs:number; frames:number; fps:number; file:string};

export class ContestRecordings {
  #entries = new Map<string,SavedRecording>();
  #extracting = false;
  constructor(readonly directory: string) {}

  add(info: RecordingInfo) {
    const {status,recordingName,videoPath,frames,fps} = info;
    if (status==='saved' && recordingName && videoPath && frames && fps) {
      this.#entries.set(recordingName,{recordingName,durationMs:frames*1000/fps,frames,fps,file:videoPath});
    }
  }

  list() {
    return [...this.#entries.values()].map(({recordingName,durationMs})=>({recordingName,durationMs}));
  }

  async frame(recordingName: unknown, timestampMs: unknown, signal: AbortSignal) {
    if (this.#extracting || typeof recordingName!=='string' || typeof timestampMs!=='number' ||
        !Number.isFinite(timestampMs) || timestampMs<0) throw failed();
    const item=this.#entries.get(recordingName);
    if (!item || timestampMs>=item.durationMs) throw failed();
    let index=Math.min(item.frames-1,Math.floor(timestampMs*item.fps/1000));
    if ((index+1)*1000/item.fps<=timestampMs) index++;
    else if (index*1000/item.fps>timestampMs) index--;
    // Seek to a whole second, then select the exact frame inside that second.
    const second=Math.floor(index/item.fps), offset=index%item.fps;
    this.#extracting=true;
    try {
      const {stdout}=await execute(ffmpegPath(),[
        '-hide_banner','-loglevel','error','-nostdin','-ss',String(second),'-threads','1','-i',item.file,
        '-map','0:v:0','-an','-sn','-vf',`select=eq(n\\,${offset})`,'-frames:v','1','-threads','1',
        '-c:v','mjpeg','-q:v','2','-f','image2pipe','pipe:1',
      ],{encoding:'buffer',windowsHide:true,maxBuffer:1024*1024,timeout:6000,signal});
      if (stdout.length<4 || stdout.readUInt16BE(0)!==0xffd8 || stdout.readUInt16BE(stdout.length-2)!==0xffd9) throw failed();
      return {timestampMs:index*1000/item.fps,data:stdout.toString('base64')};
    } catch { throw failed(); }
    finally { this.#extracting=false; }
  }
}
