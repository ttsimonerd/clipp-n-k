export function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatDate(dateString: string) {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  }).format(date);
}

/**
 * Normalize an admin-supplied brand color into the "H S% L%" CSS variable
 * format used by the app theme (--primary / --ring). Accepts:
 *   - "#RRGGBB" / "#RGB" hex
 *   - "H S% L%" space-separated HSL (as already stored in the DB default)
 * Returns null when the value can't be parsed, so callers fall back to the
 * default theme color.
 */
export function parseBrandColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  const hexMatch = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(trimmed);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) {
      return `0 0% ${Math.round(l * 100)}%`;
    }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
  }

  const hslMatch = /^(\d{1,3})\s+(\d{1,3})%\s+(\d{1,3})%$/.exec(trimmed);
  if (hslMatch) {
    return `${Number(hslMatch[1])} ${Number(hslMatch[2])}% ${Number(hslMatch[3])}%`;
  }

  return null;
}