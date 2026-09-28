import type { ProfileSet } from '../shared/types';

/**
 * Measured on a Fire TV Stick 4K Max (AFTKRT, Fire OS 8, software-only H.264
 * encoder) with 60 fps video and home-screen scrolling. Qualifying rule: >=90% of
 * seconds within 2 fps of target and lag p95 <= 150 ms with no build-up.
 * 1408-1536 px lagged 0.5-1 s or dropped to ~15 fps on motion, hence the gap.
 * Software encoders on other devices are unlikely to be faster, so this set is
 * also the safe choice for them.
 */
export const SOFTWARE_ENCODER_PROFILES: ProfileSet = {
  id: 'software',
  measured: true,
  note: 'Measured on a Fire TV Stick 4K Max (software encoder).',
  defaultId: 'responsive',
  profiles: [
    { id: 'responsive', label: 'Responsive', description: '896p · 30 fps · lowest lag', fps: 30, size: 896, bitrate: 6_000_000 },
    { id: 'clear', label: 'Clear', description: '720p · 20 fps · more detail', fps: 20, size: 1280, bitrate: 6_000_000 },
    { id: 'native', label: 'Native', description: '1080p · 20 fps · for still images, lags on motion', fps: 20, size: 1920, bitrate: 6_000_000 },
  ],
};

/** Starting points for devices with a hardware encoder. Not measured yet. */
export const HARDWARE_ENCODER_PROFILES: ProfileSet = {
  id: 'hardware',
  measured: false,
  note: 'Hardware encoder detected. These settings are not measured on this device yet.',
  defaultId: 'smooth',
  profiles: [
    { id: 'smooth', label: 'Smooth', description: '720p · 60 fps', fps: 60, size: 1280, bitrate: 8_000_000 },
    { id: 'fullhd', label: 'Full HD', description: '1080p · 30 fps', fps: 30, size: 1920, bitrate: 8_000_000 },
    { id: 'fullhd60', label: 'Full HD 60', description: '1080p · 60 fps', fps: 60, size: 1920, bitrate: 12_000_000 },
  ],
};

export function profileSetFor(encoder: 'hardware' | 'software'): ProfileSet {
  return encoder === 'hardware' ? HARDWARE_ENCODER_PROFILES : SOFTWARE_ENCODER_PROFILES;
}
