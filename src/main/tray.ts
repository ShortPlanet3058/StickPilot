// Menu-bar (macOS) / tray (Windows, Linux) icon with a small popover remote,
// and optional media-key shortcuts for the device.

import { BrowserWindow, globalShortcut, Menu, nativeImage, screen, systemPreferences, Tray } from 'electron';
import { trayIconPngs } from './trayIcon';

const POPUP = { width: 288, height: 488 };

export interface TrayHooks {
  /** Icon file for Windows / Linux (full color); null on macOS, which gets a drawn template glyph */
  icon: string | null;
  preload: string;
  page: string;
  showMain(): void;
  quit(): void;
  /** Sends a key press (down + up) to the connected device; false when nothing is connected */
  tap(keycode: number): boolean;
  mediaKeysEnabled(): boolean;
  setMediaKeys(on: boolean): void;
  doubleShiftEnabled(): boolean;
  setDoubleShift(on: boolean): void;
  stayInMenuBar(): boolean;
  setStayInMenuBar(on: boolean): void;
}

const MEDIA_KEYS: [string, number][] = [
  ['MediaPlayPause', 85],
  ['MediaNextTrack', 90], // fast forward
  ['MediaPreviousTrack', 89], // rewind
];

export class TrayRemote {
  private tray: Tray | null = null;
  popup: BrowserWindow | null = null;
  private mediaKeysOn = false;
  private hiddenAt = 0;

  constructor(private hooks: TrayHooks) {}

  create(): void {
    let image: Electron.NativeImage;
    if (this.hooks.icon) {
      // Windows picks the right size from the .ico; a dark/light-only glyph would vanish on one taskbar color
      image = nativeImage.createFromPath(this.hooks.icon);
      if (!this.hooks.icon.endsWith('.ico')) image = image.resize({ width: 22, height: 22, quality: 'best' });
    } else {
      const { x1, x2 } = trayIconPngs();
      image = nativeImage.createEmpty();
      image.addRepresentation({ scaleFactor: 1, buffer: x1 });
      image.addRepresentation({ scaleFactor: 2, buffer: x2 });
      image.setTemplateImage(true);
    }
    this.tray = new Tray(image);
    this.tray.setToolTip('StickPilot');
    this.tray.on('click', () => this.toggle());
    this.tray.on('right-click', () => this.tray?.popUpContextMenu(this.menu()));
    // Linux app indicators only show a menu, so the menu also opens the popover
    if (process.platform === 'linux') this.tray.setContextMenu(this.menu());

    this.popup = new BrowserWindow({
      ...POPUP,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#17181b',
      webPreferences: { preload: this.hooks.preload, contextIsolation: true, sandbox: true },
    });
    this.popup.loadFile(this.hooks.page);
    this.popup.on('blur', () => { this.hiddenAt = Date.now(); this.popup?.hide(); });
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: 'Show mini remote', click: () => this.show() },
      { label: 'Open StickPilot', click: () => this.hooks.showMain() },
      { type: 'separator' },
      {
        label: 'Use media keys for the TV',
        type: 'checkbox',
        checked: this.hooks.mediaKeysEnabled(),
        click: (item) => this.hooks.setMediaKeys(item.checked),
      },
      {
        label: 'Double-tap Right Shift opens this remote',
        type: 'checkbox',
        checked: this.hooks.doubleShiftEnabled(),
        click: (item) => this.hooks.setDoubleShift(item.checked),
      },
      {
        label: process.platform === 'darwin' ? 'Keep running in the menu bar when closed' : 'Keep running in the notification area when closed',
        type: 'checkbox',
        checked: this.hooks.stayInMenuBar(),
        click: (item) => this.hooks.setStayInMenuBar(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit StickPilot', accelerator: 'CommandOrControl+Q', click: () => this.hooks.quit() },
    ]);
  }

  toggle(): void {
    if (this.popup?.isVisible()) this.popup.hide();
    // Clicking the icon while the remote is open first blurs it (which hides it): that click means close
    else if (Date.now() - this.hiddenAt > 300) this.show();
  }

  /** A one-off notification from the tray icon (Windows balloon) */
  hint(title: string, content: string): void {
    if (process.platform === 'win32') this.tray?.displayBalloon({ title, content, iconType: 'info' });
  }

  show(): void {
    if (!this.tray || !this.popup) return;
    let b = this.tray.getBounds();
    // Some Linux trays don't report where the icon is: open by the pointer instead
    if (!b.width) { const p = screen.getCursorScreenPoint(); b = { x: p.x, y: p.y, width: 1, height: 1 }; }
    const area = screen.getDisplayMatching(b).workArea;
    // Below the icon on macOS (menu bar on top); above it for bottom taskbars. Kept on screen
    // for taskbars on the left or right too.
    const below = b.y < area.y + area.height / 2;
    const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), hi));
    const x = clamp(b.x + b.width / 2 - POPUP.width / 2, area.x + 8, area.x + area.width - POPUP.width - 8);
    const y = clamp(below ? b.y + b.height + 4 : b.y - POPUP.height - 4, area.y, area.y + area.height - POPUP.height);
    this.popup.setPosition(x, y);
    this.popup.show();
    this.popup.focus();
  }

  /**
   * Media keys are global: while registered, other apps (Music, Spotify) don't get them.
   * macOS only delivers them to apps allowed under Privacy & Security → Accessibility.
   * Returns a message when the keys can't be used, so the UI can explain why.
   */
  updateMediaKeys(active: boolean): string | null {
    const want = active && this.hooks.mediaKeysEnabled();
    if (want === this.mediaKeysOn) return null;
    for (const [accel] of MEDIA_KEYS) globalShortcut.unregister(accel);
    this.mediaKeysOn = false;
    if (!want) return null;
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return 'To use the media keys, StickPilot needs Accessibility access (System Settings → Privacy & Security → Accessibility), then turn the option on again.';
    }
    const ok = MEDIA_KEYS.every(([accel, code]) => globalShortcut.register(accel, () => { this.hooks.tap(code); }));
    this.mediaKeysOn = ok;
    return ok ? null : 'Another app is already using the media keys.';
  }

  destroy(): void {
    for (const [accel] of MEDIA_KEYS) globalShortcut.unregister(accel);
    this.popup?.destroy();
    this.tray?.destroy();
  }
}
