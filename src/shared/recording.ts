// Owner-only recording status; never part of ParticipantObservation.
export interface RecordingInfo {
  enabled: boolean;
  status: 'off' | 'recording' | 'saving' | 'saved' | 'error';
  matchId?: string;
  recordingName?: string;
  startedAt?: string;
  videoPath?: string;
  dataPath?: string;
  sourcePath?: string;
  indexPath?: string;
  error?: string;
  cleanupWarning?: string;
  fps?: number;
  width?: number;
  height?: number;
  frames?: number;
  jpegFrames?: number;
  sourceBytes?: number;
  indexBytes?: number;
  maxPendingFrames?: number;
  maxPendingBytes?: number;
  captureCpuMs?: number;
  diskWriteMs?: number;
  transcodeMs?: number;
}
