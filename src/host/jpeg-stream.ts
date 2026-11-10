// FFmpeg image2pipe emits concatenated baseline JPEGs. Length-prefixed marker
// segments may contain FF D9; only an unescaped marker ends the scan.
export const MAX_JPEG_BYTES = 8 * 1024 * 1024;

export class JpegStream {
  #parts: Buffer[] = [];
  #size = 0;
  #remaining = 0;
  #marker = 0;
  #mode: 'soi' | 'start' | 'prefix' | 'marker' | 'lengthHi' | 'lengthLo' | 'segment' | 'scan' | 'scanMarker' = 'soi';

  constructor(private readonly onFrame: (frame: Buffer) => void, private readonly maxBytes = MAX_JPEG_BYTES) {}

  push(chunk: Buffer) {
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (++this.#size > this.maxBytes) throw Error('JPEG 帧超出大小上限');
      switch (this.#mode) {
        case 'soi':
          if (byte !== 0xff) throw Error('JPEG 起始标记无效');
          this.#mode = 'start';
          break;
        case 'start':
          if (byte !== 0xd8) throw Error('JPEG 起始标记无效');
          this.#mode = 'prefix';
          break;
        case 'prefix':
          if (byte !== 0xff) throw Error('JPEG 段标记无效');
          this.#mode = 'marker';
          break;
        case 'marker':
          if (byte === 0xff) break;
          if (byte < 0xc0 || (byte >= 0xd0 && byte <= 0xd9)) throw Error('JPEG 段标记无效');
          this.#marker = byte;
          this.#mode = 'lengthHi';
          break;
        case 'lengthHi':
          this.#remaining = byte << 8;
          this.#mode = 'lengthLo';
          break;
        case 'lengthLo':
          this.#remaining += byte - 2;
          if (this.#remaining < 0) throw Error('JPEG 段长度无效');
          this.#mode = this.#remaining > 0 ? 'segment' : this.#marker === 0xda ? 'scan' : 'prefix';
          break;
        case 'segment':
          if (--this.#remaining === 0) this.#mode = this.#marker === 0xda ? 'scan' : 'prefix';
          break;
        case 'scan':
          if (byte === 0xff) this.#mode = 'scanMarker';
          break;
        case 'scanMarker':
          if (byte === 0xff) break;
          if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) {
            this.#mode = 'scan';
            break;
          }
          if (byte !== 0xd9) throw Error('JPEG 扫描结束标记无效');
          this.#parts.push(chunk.subarray(from, i + 1));
          const frame = Buffer.concat(this.#parts, this.#size);
          from = i + 1;
          this.#parts = [];
          this.#size = 0;
          this.#mode = 'soi';
          this.onFrame(frame);
          break;
      }
    }
    if (from < chunk.length) this.#parts.push(chunk.subarray(from));
  }
}
