// A minimal D-Bus client for the Linux session bus: just enough to call the desktop
// portal and receive its signals, with no native module (nothing to rebuild per platform).
//
// Values: s/o/g are strings, y/n/q/i/u numbers, x/t bigints, b booleans, arrays are
// arrays, structs are arrays of their fields, a{..} dictionaries are plain objects.
// A variant to send is written [signature, value]; received variants are just the value.

import net from 'net';
import os from 'os';

export type Value = string | number | bigint | boolean | Value[] | { [key: string]: Value };

export interface Message {
  type: number;
  serial: number;
  path?: string;
  iface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  sender?: string;
  signature?: string;
  body: Value[];
}

const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
const SIGNAL = 4;

const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4, s: 4, o: 4, g: 1, a: 4, '(': 8, '{': 8, v: 1 };

/** Splits a signature into its complete types, e.g. "sa{sv}u" → ["s", "a{sv}", "u"] */
export function splitSignature(sig: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sig.length) {
    const end = typeEnd(sig, i);
    out.push(sig.slice(i, end));
    i = end;
  }
  return out;
}

function typeEnd(sig: string, i: number): number {
  const c = sig[i];
  if (c === 'a') return typeEnd(sig, i + 1);
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let j = i + 1;
    while (sig[j] !== close) j = typeEnd(sig, j);
    return j + 1;
  }
  if (!(c in ALIGN)) throw new Error(`Unsupported D-Bus type "${c}"`);
  return i + 1;
}

class Writer {
  private bufs: Buffer[] = [];
  length = 0;

  private push(b: Buffer): void { this.bufs.push(b); this.length += b.length; }
  align(n: number): void { const pad = (n - (this.length % n)) % n; if (pad) this.push(Buffer.alloc(pad)); }
  bytes(): Buffer { return Buffer.concat(this.bufs); }

  write(type: string, v: Value): void {
    const c = type[0];
    this.align(ALIGN[c]);
    switch (c) {
      case 'y': this.push(Buffer.from([v as number])); return;
      case 'b': case 'u': case 'h': { const b = Buffer.alloc(4); b.writeUInt32LE(c === 'b' ? (v ? 1 : 0) : (v as number)); this.push(b); return; }
      case 'i': { const b = Buffer.alloc(4); b.writeInt32LE(v as number); this.push(b); return; }
      case 'n': { const b = Buffer.alloc(2); b.writeInt16LE(v as number); this.push(b); return; }
      case 'q': { const b = Buffer.alloc(2); b.writeUInt16LE(v as number); this.push(b); return; }
      case 'x': { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v as bigint)); this.push(b); return; }
      case 't': { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v as bigint)); this.push(b); return; }
      case 'd': { const b = Buffer.alloc(8); b.writeDoubleLE(v as number); this.push(b); return; }
      case 's': case 'o': {
        const s = Buffer.from(v as string, 'utf8');
        const len = Buffer.alloc(4); len.writeUInt32LE(s.length);
        this.push(len); this.push(s); this.push(Buffer.alloc(1));
        return;
      }
      case 'g': { const s = Buffer.from(v as string, 'ascii'); this.push(Buffer.from([s.length])); this.push(s); this.push(Buffer.alloc(1)); return; }
      case 'v': { const [sig, inner] = v as [string, Value]; this.write('g', sig); this.write(sig, inner); return; }
      case '(': { const fields = splitSignature(type.slice(1, -1)); fields.forEach((f, k) => this.write(f, (v as Value[])[k])); return; }
      case 'a': {
        const elem = type.slice(1);
        const lenAt = this.length;
        this.write('u', 0); // patched below
        this.align(ALIGN[elem[0]]);
        const start = this.length;
        if (elem[0] === '{') {
          const [kt, vt] = splitSignature(elem.slice(1, -1));
          for (const [k, val] of Object.entries(v as Record<string, Value>)) { this.align(8); this.write(kt, k); this.write(vt, val); }
        } else {
          for (const item of v as Value[]) this.write(elem, item);
        }
        this.patchU32(lenAt, this.length - start);
        return;
      }
    }
  }

  private patchU32(offset: number, value: number): void {
    let pos = 0;
    for (const b of this.bufs) {
      if (offset < pos + b.length) { b.writeUInt32LE(value, offset - pos); return; }
      pos += b.length;
    }
  }
}

class Reader {
  constructor(private buf: Buffer, public pos = 0) {}

  align(n: number): void { this.pos += (n - (this.pos % n)) % n; }

  read(type: string): Value {
    const c = type[0];
    this.align(ALIGN[c]);
    const b = this.buf;
    switch (c) {
      case 'y': return b[this.pos++];
      case 'b': { const v = b.readUInt32LE(this.pos); this.pos += 4; return v !== 0; }
      case 'u': case 'h': { const v = b.readUInt32LE(this.pos); this.pos += 4; return v; }
      case 'i': { const v = b.readInt32LE(this.pos); this.pos += 4; return v; }
      case 'n': { const v = b.readInt16LE(this.pos); this.pos += 2; return v; }
      case 'q': { const v = b.readUInt16LE(this.pos); this.pos += 2; return v; }
      case 'x': { const v = b.readBigInt64LE(this.pos); this.pos += 8; return v; }
      case 't': { const v = b.readBigUInt64LE(this.pos); this.pos += 8; return v; }
      case 'd': { const v = b.readDoubleLE(this.pos); this.pos += 8; return v; }
      case 's': case 'o': {
        const len = b.readUInt32LE(this.pos); this.pos += 4;
        const s = b.toString('utf8', this.pos, this.pos + len); this.pos += len + 1;
        return s;
      }
      case 'g': { const len = b[this.pos++]; const s = b.toString('ascii', this.pos, this.pos + len); this.pos += len + 1; return s; }
      case 'v': { const sig = this.read('g') as string; return this.read(sig); }
      case '(': return splitSignature(type.slice(1, -1)).map((f) => this.read(f));
      case 'a': {
        const len = this.read('u') as number;
        const elem = type.slice(1);
        this.align(ALIGN[elem[0]]);
        const end = this.pos + len;
        if (elem[0] === '{') {
          const [kt, vt] = splitSignature(elem.slice(1, -1));
          const out: Record<string, Value> = {};
          while (this.pos < end) { this.align(8); const k = this.read(kt); out[String(k)] = this.read(vt); }
          return out;
        }
        const out: Value[] = [];
        while (this.pos < end) out.push(this.read(elem));
        return out;
      }
    }
    throw new Error(`Unsupported D-Bus type "${c}"`);
  }
}

function encode(serial: number, m: { type: number; path?: string; iface?: string; member?: string; destination?: string; signature?: string; body?: Value[] }): Buffer {
  const body = new Writer();
  const types = m.signature ? splitSignature(m.signature) : [];
  types.forEach((t, k) => body.write(t, m.body![k]));
  const fields: Value[] = [];
  if (m.path) fields.push([1, ['o', m.path]]);
  if (m.iface) fields.push([2, ['s', m.iface]]);
  if (m.member) fields.push([3, ['s', m.member]]);
  if (m.destination) fields.push([6, ['s', m.destination]]);
  if (m.signature) fields.push([8, ['g', m.signature]]);
  const head = new Writer();
  head.write('y', 'l'.charCodeAt(0));
  head.write('y', m.type);
  head.write('y', 0);
  head.write('y', 1);
  head.write('u', body.length);
  head.write('u', serial);
  head.write('a(yv)', fields);
  head.align(8);
  return Buffer.concat([head.bytes(), body.bytes()]);
}

/** Parses one complete message at the start of buf, or returns null when more bytes are needed */
function decode(buf: Buffer): { msg: Message; size: number } | null {
  if (buf.length < 16) return null;
  if (buf[0] !== 'l'.charCodeAt(0)) throw new Error('Big-endian D-Bus messages are not supported');
  const bodyLen = buf.readUInt32LE(4);
  const fieldsLen = buf.readUInt32LE(12);
  const headerEnd = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
  const size = headerEnd + bodyLen;
  if (buf.length < size) return null;
  const r = new Reader(buf, 12);
  const fields = r.read('a(yv)') as Value[][];
  const msg: Message = { type: buf[1], serial: buf.readUInt32LE(8), body: [] };
  for (const [code, value] of fields) {
    switch (code) {
      case 1: msg.path = value as string; break;
      case 2: msg.iface = value as string; break;
      case 3: msg.member = value as string; break;
      case 4: msg.errorName = value as string; break;
      case 5: msg.replySerial = value as number; break;
      case 7: msg.sender = value as string; break;
      case 8: msg.signature = value as string; break;
    }
  }
  if (msg.signature) {
    const body = new Reader(buf.subarray(headerEnd, size));
    msg.body = splitSignature(msg.signature).map((t) => body.read(t));
  }
  return { msg, size };
}

function sessionBusPath(): { path: string } {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS || '';
  for (const part of addr.split(';')) {
    if (!part.startsWith('unix:')) continue;
    const kv = Object.fromEntries(part.slice(5).split(',').map((p) => p.split('=') as [string, string]));
    if (kv.path) return { path: decodeURIComponent(kv.path) };
    if (kv.abstract) return { path: `\0${decodeURIComponent(kv.abstract)}` };
  }
  return { path: `/run/user/${os.userInfo().uid}/bus` };
}

export class SessionBus {
  private sock: net.Socket | null = null;
  private serial = 0;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, { resolve(m: Message): void; reject(e: Error): void }>();
  private listeners = new Set<(m: Message) => void>();
  private closeHandlers = new Set<() => void>();
  uniqueName = '';

  /** Connects, authenticates as this user and says Hello */
  async connect(): Promise<void> {
    const sock = net.createConnection(sessionBusPath());
    this.sock = sock;
    await new Promise<void>((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
    sock.write(Buffer.from([0]));
    sock.write(`AUTH EXTERNAL ${Buffer.from(String(os.userInfo().uid)).toString('hex')}\r\n`);
    const reply = await new Promise<string>((resolve, reject) => {
      let text = '';
      const onData = (d: Buffer) => {
        text += d.toString('ascii');
        if (text.includes('\r\n')) { sock.off('data', onData); resolve(text); }
      };
      sock.on('data', onData);
      sock.once('error', reject);
    });
    if (!reply.startsWith('OK')) throw new Error(`D-Bus authentication failed: ${reply.trim()}`);
    sock.write('BEGIN\r\n');
    sock.on('data', (d: Buffer) => this.onData(d));
    sock.on('error', () => {});
    sock.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('D-Bus connection closed'));
      this.pending.clear();
      this.sock = null;
      for (const h of this.closeHandlers) h();
    });
    const hello = await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'Hello' });
    this.uniqueName = hello.body[0] as string;
  }

  get connected(): boolean { return !!this.sock; }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const r = decode(this.buf);
      if (!r) return;
      this.buf = this.buf.subarray(r.size);
      const m = r.msg;
      if ((m.type === METHOD_RETURN || m.type === ERROR) && m.replySerial !== undefined) {
        const p = this.pending.get(m.replySerial);
        if (!p) continue;
        this.pending.delete(m.replySerial);
        if (m.type === ERROR) p.reject(new Error(`${m.errorName}: ${typeof m.body[0] === 'string' ? m.body[0] : ''}`));
        else p.resolve(m);
      } else if (m.type === SIGNAL) {
        for (const l of this.listeners) l(m);
      }
    }
  }

  call(m: { destination: string; path: string; iface: string; member: string; signature?: string; body?: Value[] }): Promise<Message> {
    if (!this.sock) return Promise.reject(new Error('D-Bus not connected'));
    const serial = ++this.serial;
    const data = encode(serial, { type: METHOD_CALL, ...m });
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { resolve, reject });
      this.sock!.write(data);
    });
  }

  /** Receives signals matching a bus match rule, e.g. "type='signal',interface='x'" */
  async addMatch(rule: string): Promise<void> {
    await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] });
  }

  onSignal(fn: (m: Message) => void): void { this.listeners.add(fn); }
  onClose(fn: () => void): void { this.closeHandlers.add(fn); }

  close(): void { this.sock?.destroy(); this.sock = null; }
}
