// A system-wide shortcut through the desktop's GlobalShortcuts portal (GNOME 48+, KDE).
//
// On Wayland an app never sees keys typed into other apps, so the double-tap Right Shift
// hook can't work there. The portal is the sanctioned way: the desktop owns the key, asks
// the user once to allow it (they can change it in the system keyboard settings) and tells
// us when it is pressed. StickPilot runs as an X11 app on Linux (see main.ts), so Electron's
// own globalShortcut can't use the portal; this talks to it over D-Bus directly.

import { SessionBus, type Message, type Value } from './dbus';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const SHORTCUTS = 'org.freedesktop.portal.GlobalShortcuts';
const SHORTCUT_ID = 'open-remote';
/** XDG shortcut syntax; the user can bind something else when GNOME asks */
export const DEFAULT_TRIGGER = 'CTRL+ALT+r';
const DEFAULT_LABEL = 'Ctrl+Alt+R';
/** Must match the installed .desktop file (stickpilot.desktop) so the desktop knows the app */
const APP_ID = 'stickpilot';

/** True on a Linux Wayland session, where only the portal can provide a global shortcut */
export function portalShortcutWanted(): boolean {
  return process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
}

export class PortalShortcut {
  private bus: SessionBus | null = null;
  private session: string | null = null;
  private tokens = 0;
  private version = 0;
  /** How the desktop describes the bound keys, e.g. "Ctrl+Alt+R" */
  label = DEFAULT_LABEL;

  constructor(private onTrigger: () => void, private onLabel: (label: string) => void) {}

  get active(): boolean { return !!this.session && !!this.bus?.connected; }
  /** The portal can open the system dialog to change the keys (version 2+) */
  get configurable(): boolean { return this.active && this.version >= 2; }

  /** Creates the session and binds the shortcut; resolves with a message when it can't */
  async start(): Promise<string | null> {
    if (this.active) return null;
    const bus = new SessionBus();
    try {
      await bus.connect();
    } catch {
      return 'The system shortcut could not start: no session bus.';
    }
    this.bus = bus;
    bus.onClose(() => { if (this.bus === bus) { this.bus = null; this.session = null; } });
    try {
      this.version = await this.portalVersion();
      if (!this.version) { this.stop(); return 'This desktop does not offer system shortcuts to apps (no GlobalShortcuts portal).'; }
      // Tell the portal which app this is (apps not started from their .desktop file are otherwise unknown)
      await bus.call({ destination: PORTAL, path: PORTAL_PATH, iface: 'org.freedesktop.host.portal.Registry', member: 'Register', signature: 'sa{sv}', body: [APP_ID, {}] }).catch(() => {});
      await bus.addMatch(`type='signal',interface='org.freedesktop.portal.Request',member='Response'`);
      await bus.addMatch(`type='signal',interface='${SHORTCUTS}'`);
      bus.onSignal((m) => this.onSignal(m));

      const created = await this.request('CreateSession', 'a{sv}', [{ session_handle_token: ['s', this.token()] }]);
      if (created.code !== 0) { this.stop(); return 'The system shortcut could not start.'; }
      this.session = created.results.session_handle as string;

      const bound = await this.request('BindShortcuts', 'oa(sa{sv})sa{sv}', [
        this.session,
        [[SHORTCUT_ID, { description: ['s', 'Open the StickPilot mini remote'], preferred_trigger: ['s', DEFAULT_TRIGGER] }]],
        '',
      ]);
      if (bound.code !== 0) {
        this.stop();
        return bound.code === 1 ? 'The system shortcut was not allowed. Turn the option on again to choose a key.' : 'The system shortcut could not be set up.';
      }
      this.readLabel(bound.results.shortcuts);
      return null;
    } catch (e) {
      this.stop();
      return `The system shortcut could not start: ${(e as Error).message}`;
    }
  }

  /** Opens the desktop's dialog to change the keys */
  async configure(): Promise<void> {
    if (!this.configurable) return;
    await this.bus!.call({ destination: PORTAL, path: PORTAL_PATH, iface: SHORTCUTS, member: 'ConfigureShortcuts', signature: 'osa{sv}', body: [this.session!, '', {}] }).catch(() => {});
  }

  stop(): void {
    const bus = this.bus;
    this.bus = null;
    if (bus && this.session) {
      void bus.call({ destination: PORTAL, path: this.session, iface: 'org.freedesktop.portal.Session', member: 'Close' }).catch(() => {}).finally(() => bus.close());
    } else {
      bus?.close();
    }
    this.session = null;
  }

  private async portalVersion(): Promise<number> {
    const r = await this.bus!.call({
      destination: PORTAL, path: PORTAL_PATH, iface: 'org.freedesktop.DBus.Properties', member: 'Get',
      signature: 'ss', body: [SHORTCUTS, 'version'],
    }).catch(() => null);
    return r ? Number(r.body[0]) : 0;
  }

  private token(): string { return `stickpilot${process.pid}_${++this.tokens}`; }

  /**
   * Calls a portal method that answers through a Request object's Response signal.
   * The last argument of these methods is the options dictionary, which gets the handle token.
   */
  private request(member: string, signature: string, body: Value[]): Promise<{ code: number; results: Record<string, Value> }> {
    const bus = this.bus!;
    const token = this.token();
    const sender = bus.uniqueName.replace(/^:/, '').replace(/\./g, '_');
    const expected = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
    const args = [...body];
    const opts = (args.length && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) ? args.pop() : {}) as Record<string, Value>;
    args.push({ ...opts, handle_token: ['s', token] });
    return new Promise((resolve, reject) => {
      let path = expected;
      const onSignal = (m: Message) => {
        if (m.member !== 'Response' || m.path !== path) return;
        listeners.delete(onSignal);
        resolve({ code: m.body[0] as number, results: (m.body[1] ?? {}) as Record<string, Value> });
      };
      const listeners = this.responseListeners;
      listeners.add(onSignal);
      bus.call({ destination: PORTAL, path: PORTAL_PATH, iface: SHORTCUTS, member, signature, body: args })
        .then((reply) => { path = reply.body[0] as string; })
        .catch((e) => { listeners.delete(onSignal); reject(e); });
    });
  }

  private responseListeners = new Set<(m: Message) => void>();

  private onSignal(m: Message): void {
    if (m.member === 'Response') { for (const l of [...this.responseListeners]) l(m); return; }
    if (m.iface !== SHORTCUTS || m.body[0] !== this.session) return;
    if (m.member === 'Activated' && m.body[1] === SHORTCUT_ID) this.onTrigger();
    else if (m.member === 'ShortcutsChanged') this.readLabel(m.body[1]);
  }

  private readLabel(shortcuts: Value | undefined): void {
    if (!Array.isArray(shortcuts)) return;
    for (const s of shortcuts) {
      const [id, info] = s as [string, Record<string, Value>];
      if (id !== SHORTCUT_ID) continue;
      const desc = typeof info?.trigger_description === 'string' ? prettyTrigger(info.trigger_description) : '';
      this.label = desc || DEFAULT_LABEL;
      this.onLabel(this.label);
    }
  }
}

/** GNOME describes keys as "Press <Control><Alt>r": show them as "Ctrl+Alt+R" */
export function prettyTrigger(desc: string): string {
  const names: Record<string, string> = { control: 'Ctrl', primary: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super', logo: 'Super' };
  const text = desc.trim().replace(/^Press\s+/i, '');
  if (!/^(<[^>]+>)*[^<>]+$/.test(text)) return text; // not that format: show as given
  const mods = [...text.matchAll(/<([^>]+)>/g)].map((m) => names[m[1].toLowerCase()] ?? m[1]);
  const key = text.replace(/<[^>]+>/g, '');
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}
