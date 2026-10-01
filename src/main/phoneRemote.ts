// Phone remote: a small web page this computer serves on the local network, so a phone
// on the same Wi-Fi can be the TV's remote. The phone talks to StickPilot over HTTP;
// StickPilot talks to the TV as usual. Nothing to install on the phone, and it works
// the same on iPhone and Android.
//
// Every URL carries a random token (in the QR code), so other people on the network
// can't use it without the link. "New link" replaces the token. Only on when enabled.

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import qrcode from 'qrcode-generator';
import type { AppInfo, PhoneRemoteInfo, PhoneState } from '../shared/types';

export interface PhoneHooks {
  state(): PhoneState;
  key(code: number, action: 0 | 1, repeat: number): void;
  tap(code: number): void;
  type(text: string): void;
  backspace(): void;
  quickSettings(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  apps(): Promise<AppInfo[]>;
  launch(pkg: string): Promise<boolean>;
  /** A cached logo for the app (banner or icon), or null */
  artFile(pkg: string): string | null;
  /** The address phones should use to reach this computer */
  address(): Promise<string | null>;
  changed(info: PhoneRemoteInfo): void;
}

export interface PhoneFiles {
  /** Folder holding phone.html, phone.js, phone.css and logo.png */
  pageDir: string;
  /** Large app icon, for the phone's home screen */
  touchIcon: string;
}

const FIRST_PORT = 47170;
const PORT_TRIES = 10;
/** A held key whose release never arrives (phone locked, Wi-Fi gone) is released after this */
const HELD_KEY_LIMIT_MS = 1500;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

export const newToken = () => crypto.randomBytes(12).toString('base64url');

/** The QR code as an SVG path in the current text color */
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  const size = n + 8; // quiet zone of 4 modules
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export class PhoneRemote {
  private server: http.Server | null = null;
  private port = 0;
  private host: string | null = null;
  private clients = new Set<http.ServerResponse>();
  private held = new Map<number, NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private hooks: PhoneHooks, private files: PhoneFiles, private token: () => string) {}

  get running(): boolean {
    return !!this.server;
  }

  async info(): Promise<PhoneRemoteInfo> {
    if (!this.server) return { enabled: false, url: null, qr: null, phones: 0 };
    this.host = (await this.hooks.address()) ?? this.host;
    const url = this.host ? `http://${this.host}:${this.port}/r/${this.token()}/` : null;
    return { enabled: true, url, qr: url ? qrSvg(url) : null, phones: this.clients.size };
  }

  async start(): Promise<void> {
    if (this.server) return;
    for (let i = 0; i < PORT_TRIES; i++) {
      const server = http.createServer((req, res) => { void this.handle(req, res); });
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(FIRST_PORT + i, '0.0.0.0', () => resolve(true));
      });
      if (ok) {
        this.server = server;
        this.port = FIRST_PORT + i;
        break;
      }
    }
    if (!this.server) throw new Error(`No free port between ${FIRST_PORT} and ${FIRST_PORT + PORT_TRIES - 1}.`);
    // Keeps idle connections (and the phone's live status) open through routers and sleep
    this.heartbeat = setInterval(() => { for (const c of this.clients) c.write(': ping\n\n'); }, 20000);
    await this.announce();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.releaseAll();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const server = this.server;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.announce();
  }

  /** Disconnects the phones using the old link (after a new token) */
  dropClients(): void {
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.releaseAll();
  }

  /** The TV or the session changed: refresh every phone */
  notify(): void {
    if (!this.clients.size) return;
    const data = `data: ${JSON.stringify(this.hooks.state())}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  private async announce(): Promise<void> {
    this.hooks.changed(await this.info());
  }

  private releaseAll(): void {
    for (const [code, timer] of this.held) { clearTimeout(timer); this.hooks.key(code, 1, 0); }
    this.held.clear();
  }

  private holdKey(code: number, action: 0 | 1, repeat: number): void {
    const timer = this.held.get(code);
    if (timer) clearTimeout(timer);
    if (action === 1) {
      this.held.delete(code);
    } else {
      this.held.set(code, setTimeout(() => { this.held.delete(code); this.hooks.key(code, 1, 0); }, HELD_KEY_LIMIT_MS));
    }
    this.hooks.key(code, action, repeat);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://phone');
    const m = /^\/r\/([\w-]+)(\/.*)?$/.exec(url.pathname);
    const token = this.token();
    const given = Buffer.from(m?.[1] ?? '');
    if (!m || given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(
        'This link no longer works. Scan the QR code in StickPilot again (Phone remote).');
      return;
    }
    const route = m[2] ?? '';
    if (route === '') { res.writeHead(301, { Location: `/r/${token}/` }).end(); return; }

    try {
      if (req.method === 'GET') await this.get(route, res);
      else if (req.method === 'POST') await this.post(route, await readJson(req), res);
      else res.writeHead(405).end();
    } catch (e) {
      json(res, { ok: false, message: (e as Error).message }, 500);
    }
  }

  private async get(route: string, res: http.ServerResponse): Promise<void> {
    const page: Record<string, string> = {
      '/': 'phone.html', '/phone.js': 'phone.js', '/phone.css': 'phone.css', '/logo.png': 'logo.png',
    };
    if (page[route]) { sendFile(res, path.join(this.files.pageDir, page[route])); return; }
    if (route === '/icon.png') { sendFile(res, this.files.touchIcon); return; }
    if (route === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': TYPES['.webmanifest'] }).end(JSON.stringify({
        name: 'StickPilot remote', short_name: 'StickPilot', start_url: './', scope: './', display: 'standalone',
        background_color: '#0f1012', theme_color: '#0f1012', icons: [{ src: 'icon.png', sizes: '512x512', type: 'image/png' }],
      }));
      return;
    }
    if (route === '/api/state') { json(res, this.hooks.state()); return; }
    if (route === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 2000\ndata: ${JSON.stringify(this.hooks.state())}\n\n`);
      this.clients.add(res);
      res.on('close', () => { this.clients.delete(res); void this.announce(); });
      void this.announce();
      return;
    }
    if (route === '/api/apps') { json(res, await this.hooks.apps()); return; }
    const art = /^\/art\/([\w.]+)$/.exec(route);
    if (art) {
      const file = this.hooks.artFile(art[1]);
      if (file) sendFile(res, file, 'max-age=86400');
      else res.writeHead(404).end();
      return;
    }
    res.writeHead(404).end();
  }

  private async post(route: string, body: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    const code = Number(body.code);
    switch (route) {
      case '/api/key':
        if (!Number.isInteger(code)) throw new Error('Missing key code.');
        this.holdKey(code, body.action === 'up' ? 1 : 0, Number(body.repeat) || 0);
        break;
      case '/api/tap':
        if (!Number.isInteger(code)) throw new Error('Missing key code.');
        this.hooks.tap(code);
        break;
      case '/api/text':
        if (typeof body.text === 'string' && body.text) this.hooks.type(body.text.slice(0, 2000));
        break;
      case '/api/backspace': this.hooks.backspace(); break;
      case '/api/quick-settings': await this.hooks.quickSettings(); break;
      case '/api/connect': await this.hooks.connect(); break;
      case '/api/disconnect': this.releaseAll(); await this.hooks.disconnect(); break;
      case '/api/launch':
        if (typeof body.pkg !== 'string') throw new Error('Missing app.');
        json(res, { ok: await this.hooks.launch(body.pkg) });
        return;
      default: res.writeHead(404).end(); return;
    }
    json(res, { ok: true });
  }
}

function json(res: http.ServerResponse, value: unknown, status = 200): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
}

function sendFile(res: http.ServerResponse, file: string, cache = 'no-cache'): void {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache }).end(data);
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('Too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const v = text ? JSON.parse(text) : {};
        resolve(v && typeof v === 'object' ? v : {});
      } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

