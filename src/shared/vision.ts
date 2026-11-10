// Provisional local test profile, not a final model evaluation specification.
export interface VisionConfig { fps:number; width:number; quality:number }
export const VISION_HZ = 30;
export const PROVISIONAL_VISION:Readonly<VisionConfig>=Object.freeze({fps:VISION_HZ,width:960,quality:85});
// A monotonic control for FFmpeg qscale (lower is better), not jpeg-js quality.
export const jpegQscale = (quality: number) => Math.round(2 + (100 - quality) ** 2 * 29 / 90 ** 2);
export function validateVision(input:unknown):VisionConfig {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('需要 JPEG 供图配置');
  const c=input as Record<string,unknown>;
  if(Object.keys(c).some(k=>!['fps','width','quality'].includes(k)))throw Error('供图配置含未知字段');
  if(typeof c.fps!=='number'||!Number.isFinite(c.fps)||c.fps<.25||c.fps>VISION_HZ)throw Error(`供图频率范围为 0.25 至 ${VISION_HZ} FPS`);
  if(!Number.isInteger(c.width)||(c.width as number)<240||(c.width as number)>1920)throw Error('供图宽度范围为240..1920');
  if(!Number.isInteger(c.quality)||(c.quality as number)<10||(c.quality as number)>100)throw Error('JPEG质量范围为10..100');
  return {fps:c.fps,width:c.width as number,quality:c.quality as number};
}
