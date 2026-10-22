// Mikrofonu 16 kHz mono float32'ye indirip 1024'lük paketler halinde gönderir.
// Tarayıcı 16 kHz desteklemiyorsa basit doğrusal interpolasyonla yeniden örnekler.
const TARGET = 16000;

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = new Float32Array(1024);
    this.n = 0;
    this.pos = 0;              // girdi akışındaki kesirli konum
    this.prev = 0;             // önceki örneğin değeri
    this.ratio = sampleRate / TARGET;
  }

  push(v) {
    this.out[this.n++] = v;
    if (this.n === this.out.length) {
      this.port.postMessage(this.out.slice(0));
      this.n = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    if (Math.abs(this.ratio - 1) < 1e-6) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
      return true;
    }
    // doğrusal interpolasyon
    for (let i = 0; i < ch.length; i++) {
      const next = ch[i];
      while (this.pos < 1) {
        this.push(this.prev + (next - this.prev) * this.pos);
        this.pos += this.ratio;
      }
      this.pos -= 1;
      this.prev = next;
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
