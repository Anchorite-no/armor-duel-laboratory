import React from 'react';
import type {RecordingInfo} from '../shared/recording.js';
export function RecordingFiles({info,open}:{info?:RecordingInfo;open():void}) {
  if(!info?.enabled)return null;
  if(info.status==='saving')return <p role="status">正在保存录像{info.recordingName ? ` ${info.recordingName}` : ''}…</p>;
  if(info.status==='saved')return <div className="recording-files"><p>录制已保存</p><small title={info.videoPath}>录像：{info.recordingName}</small><small title={info.dataPath}>数据：{info.recordingName?.replace(/\.mp4$/,'.json')}</small>{info.cleanupWarning&&<small>{info.cleanupWarning}</small>}<button onClick={open}>打开保存位置</button></div>;
  if(info.status==='error')return <div className="recording-files" role="alert"><p>录制失败：{info.error}</p>{info.dataPath&&<small title={info.dataPath}>数据已保存在 {info.dataPath}</small>}{info.sourcePath&&<small title={info.sourcePath}>保留 MJPEG 源文件 {info.sourcePath}</small>}{info.indexPath&&<small title={info.indexPath}>保留帧索引 {info.indexPath}</small>}{(info.videoPath||info.dataPath||info.sourcePath||info.indexPath)&&<button onClick={open}>打开保存位置</button>}</div>;
  return null;
}
