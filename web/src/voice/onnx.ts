// A small ONNX reader and CPU interpreter for the wake-word model (wakeModel.ts): just the operators its two graphs
// use, in plain TypeScript. WHY not onnxruntime-web: its 11 MB WebAssembly file can only reach the page by fetch()
// (which a WakeEngine must never call) or as a ~15 MB base64 script; the graphs here are small enough to run without it.
// It reads bytes it is handed and computes; it has no I/O of any kind.

export type Tensor = { dims: number[]; data: Float32Array };

interface Node {
  op: string;
  inputs: string[];
  outputs: string[];
  attrs: Map<string, { i?: number; f?: number; ints?: number[]; floats?: number[]; s?: string; t?: Tensor }>;
}

export interface OnnxGraph {
  nodes: Node[];
  init: Map<string, Tensor>;
  inputs: string[];
  outputs: string[];
  meta: Map<string, string>;
}

// --- protobuf wire format (just enough for ONNX) ---

class Reader {
  pos = 0;
  constructor(
    readonly b: Uint8Array,
    readonly end = b.length,
  ) {}
  varint(): number {
    let x = 0;
    let mul = 1;
    for (;;) {
      const c = this.b[this.pos++]!;
      x += (c & 0x7f) * mul;
      if (c < 0x80) return x;
      mul *= 128;
    }
  }
  /** An int64 varint as a JS number (sign-extended for negatives, e.g. axis -1). */
  int64(): number {
    let x = 0n;
    let shift = 0n;
    for (;;) {
      const c = this.b[this.pos++]!;
      x |= BigInt(c & 0x7f) << shift;
      if (c < 0x80) break;
      shift += 7n;
    }
    return Number(BigInt.asIntN(64, x));
  }
  sub(): Reader {
    const n = this.varint();
    const r = new Reader(this.b, this.pos + n);
    r.pos = this.pos;
    this.pos += n;
    return r;
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  str(): string {
    return new TextDecoder().decode(this.bytes());
  }
  f32(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`onnx: wire type ${wire}`);
  }
  *fields(): Generator<[number, number]> {
    while (this.pos < this.end) {
      const k = this.varint();
      yield [k >>> 3, k & 7];
    }
  }
}

function packedInts(r: Reader, wire: number, out: number[]) {
  if (wire === 2) {
    const s = r.sub();
    while (s.pos < s.end) out.push(s.int64());
  } else out.push(r.int64());
}

function readTensor(r: Reader): { name: string; t: Tensor } {
  const dims: number[] = [];
  let type = 1;
  let name = '';
  let raw: Uint8Array | null = null;
  const floats: number[] = [];
  const ints: number[] = [];
  for (const [f, w] of r.fields()) {
    if (f === 1) packedInts(r, w, dims);
    else if (f === 2) type = r.varint();
    else if (f === 8) name = r.str();
    else if (f === 9) raw = r.bytes();
    else if (f === 4) {
      if (w === 2) {
        const s = r.sub();
        while (s.pos < s.end) floats.push(s.f32());
      } else floats.push(r.f32());
    } else if (f === 5 || f === 7) packedInts(r, w, ints);
    else r.skip(w);
  }
  const n = dims.reduce((a, b) => a * b, 1);
  const data = new Float32Array(n);
  if (raw) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < n; i++) {
      if (type === 1) data[i] = dv.getFloat32(i * 4, true);
      else if (type === 7) data[i] = Number(dv.getBigInt64(i * 8, true));
      else if (type === 6) data[i] = dv.getInt32(i * 4, true);
      else throw new Error(`onnx: tensor ${name} has data type ${type}`);
    }
  } else data.set(floats.length ? floats : ints);
  return { name, t: { dims, data } };
}

function readAttr(r: Reader): [string, Node['attrs'] extends Map<string, infer V> ? V : never] {
  let name = '';
  const a: { i?: number; f?: number; ints?: number[]; floats?: number[]; s?: string; t?: Tensor } = {};
  for (const [f, w] of r.fields()) {
    if (f === 1) name = r.str();
    else if (f === 2) a.f = r.f32();
    else if (f === 3) a.i = r.int64();
    else if (f === 4) a.s = r.str();
    else if (f === 5) a.t = readTensor(r.sub()).t;
    else if (f === 7) {
      a.floats ??= [];
      if (w === 2) {
        const s = r.sub();
        while (s.pos < s.end) a.floats.push(s.f32());
      } else a.floats.push(r.f32());
    } else if (f === 8) packedInts(r, w, (a.ints ??= []));
    else r.skip(w);
  }
  return [name, a];
}

function readNode(r: Reader): Node {
  const n: Node = { op: '', inputs: [], outputs: [], attrs: new Map() };
  for (const [f, w] of r.fields()) {
    if (f === 1) n.inputs.push(r.str());
    else if (f === 2) n.outputs.push(r.str());
    else if (f === 4) n.op = r.str();
    else if (f === 5) {
      const [k, v] = readAttr(r.sub());
      n.attrs.set(k, v);
    } else r.skip(w);
  }
  return n;
}

function valueName(r: Reader): string {
  let name = '';
  for (const [f, w] of r.fields()) {
    if (f === 1) name = r.str();
    else r.skip(w);
  }
  return name;
}

/** Parse an ONNX model (ModelProto bytes). */
export function parseOnnx(bytes: Uint8Array): OnnxGraph {
  const g: OnnxGraph = { nodes: [], init: new Map(), inputs: [], outputs: [], meta: new Map() };
  const top = new Reader(bytes);
  for (const [f, w] of top.fields()) {
    if (f === 7) {
      const gr = top.sub();
      for (const [gf, gw] of gr.fields()) {
        if (gf === 1) g.nodes.push(readNode(gr.sub()));
        else if (gf === 5) {
          const { name, t } = readTensor(gr.sub());
          g.init.set(name, t);
        } else if (gf === 11) g.inputs.push(valueName(gr.sub()));
        else if (gf === 12) g.outputs.push(valueName(gr.sub()));
        else gr.skip(gw);
      }
    } else if (f === 14) {
      const m = top.sub();
      let k = '';
      let v = '';
      for (const [mf, mw] of m.fields()) {
        if (mf === 1) k = m.str();
        else if (mf === 2) v = m.str();
        else m.skip(mw);
      }
      g.meta.set(k, v);
    } else top.skip(w);
  }
  g.inputs = g.inputs.filter((n) => !g.init.has(n));
  return g;
}
