export function formatBytes(
  bytes: number,
  k: 1024 | 1000,
  round: boolean = false
): string {
  if (bytes === 0) return '0 B';
  const sizes =
    k === 1024
      ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  let value = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  if (round) {
    value = Math.round(value);
  }
  return value + ' ' + sizes[i];
}

export function formatSmartBytes(bytes: number, k: 1024 | 1000): string {
  if (bytes === 0) return '0 B';
  const sizes =
    k === 1024
      ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const rawValue = bytes / Math.pow(k, i);
  const integerPart = Math.floor(rawValue);

  let value: number;
  let formattedValue: string;

  if (integerPart >= 100) {
    value = Math.round(rawValue);
    formattedValue = value.toString();
  } else if (integerPart >= 10) {
    value = parseFloat(rawValue.toFixed(1));
    formattedValue = value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
  } else {
    value = parseFloat(rawValue.toFixed(2));
    formattedValue = value.toString();
  }

  return formattedValue + ' ' + sizes[i];
}

export function formatBitrate(bitrate: number, round: boolean = false): string {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return '0 bps';
  const k = 1000;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.min(
    sizes.length - 1,
    Math.max(0, Math.floor(Math.log(bitrate) / Math.log(k)))
  );
  let value = bitrate / Math.pow(k, i);
  value = round ? Math.round(value) : parseFloat(value.toFixed(2));
  return `${value} ${sizes[i]}`;
}

export function formatSmartBitrate(bitrate: number): string {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return '0 bps';
  const k = 1000;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.min(
    sizes.length - 1,
    Math.max(0, Math.floor(Math.log(bitrate) / Math.log(k)))
  );
  const rawValue = bitrate / Math.pow(k, i);
  const integerPart = Math.floor(rawValue);

  let value: number;
  let formattedValue: string;
  if (integerPart >= 100) {
    value = Math.round(rawValue);
    formattedValue = value.toString();
  } else if (integerPart >= 10) {
    value = parseFloat(rawValue.toFixed(1));
    formattedValue = value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
  } else {
    value = parseFloat(rawValue.toFixed(2));
    formattedValue = value.toString();
  }
  return `${formattedValue} ${sizes[i]}`;
}

export function formatDuration(durationInMs: number): string {
  const seconds = Math.floor(durationInMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const formattedSeconds = seconds % 60;
  const formattedMinutes = minutes % 60;

  if (hours > 0) {
    return `${hours}h:${formattedMinutes}m:${formattedSeconds}s`;
  } else if (formattedSeconds > 0) {
    return `${formattedMinutes}m:${formattedSeconds}s`;
  } else {
    return `${formattedMinutes}m`;
  }
}

/**
 * Renders a `%`-token pattern.
 *
 * `[...]` marks an optional group: it is dropped when every token inside it
 * resolved to zero, which is what lets a single pattern hide an empty unit
 * (e.g. `[%-Hh ]%-Mm` drops the hours for a sub-hour duration).
 *
 * `%%`, `%[` and `%]` emit literals. Unrecognised tokens are emitted verbatim
 * so typos are visible in the output rather than silently swallowed.
 */
function renderPattern(
  pattern: string,
  resolve: (token: string) => { text: string; zero?: boolean } | undefined
): string {
  const stack = [{ text: '', zero: true, sawToken: false }];
  const closeGroup = () => {
    const group = stack.pop()!;
    const parent = stack[stack.length - 1];
    // an all-zero group is only dropped if it actually contained a token,
    // otherwise `[ - ]` style literal-only groups would vanish
    if (!group.sawToken || !group.zero) {
      parent.text += group.text;
      parent.sawToken ||= group.sawToken;
      if (!group.zero) parent.zero = false;
    }
  };

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const top = stack[stack.length - 1];

    if (char === '%') {
      const next = pattern[i + 1];
      if (next === undefined) {
        top.text += '%';
        break;
      }
      if (next === '%' || next === '[' || next === ']') {
        top.text += next;
        i += 1;
        continue;
      }
      const token = next === '-' ? pattern.slice(i + 1, i + 3) : next;
      const resolved = resolve(token);
      if (resolved === undefined) {
        top.text += `%${token}`;
      } else {
        top.text += resolved.text;
        top.sawToken = true;
        if (!resolved.zero) top.zero = false;
      }
      i += token.length;
      continue;
    }

    if (char === '[') {
      stack.push({ text: '', zero: true, sawToken: false });
      continue;
    }
    if (char === ']' && stack.length > 1) {
      closeGroup();
      continue;
    }
    top.text += char;
  }

  while (stack.length > 1) closeGroup(); // tolerate unclosed groups
  return stack[0].text;
}

const DURATION_UNITS = ['H', 'M', 'S'] as const;

/**
 * This function exists to handle differing units between stream.duration and metadata.runtime
 * One is stored in milliseconds, the other in minutes. This function will normalise both to milliseconds.
 *
 * @param duration duration in either milliseconds or minutes
 */
export function normaliseDuration(duration: number): number {
  if (duration < 0) {
    return 0;
  }
  if (duration < 1000) {
    return duration * 60 * 1000; // convert minutes to milliseconds
  }
  return duration; // already in milliseconds
}

/**
 * @param durationInMs - duration in milliseconds
 * @param pattern - `%H` `%M` `%S` (zero padded) or `%-H` `%-M` `%-S` (bare)
 * @returns e.g. `'%H:%M:%S'` -> "01:23:45", `'[%-Hh ]%-Mm'` -> "1h 23m" / "45m"
 */
export function formatDurationPattern(
  durationInMs: number,
  pattern: string
): string {
  // the largest unit present in the pattern carries the overflow, so `%-Mm`
  // alone reads as total minutes ("83m") rather than truncating to "23m"
  const units = new Set<string>();
  renderPattern(pattern, (token) => {
    const unit = token.startsWith('-') ? token.slice(1) : token;
    if (!DURATION_UNITS.includes(unit as (typeof DURATION_UNITS)[number])) {
      return undefined;
    }
    units.add(unit);
    return { text: '' };
  });

  const totalSeconds = Math.max(0, Math.floor(durationInMs / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const values: Record<string, number> = {
    H: Math.floor(totalSeconds / 3600),
    M: units.has('H') ? totalMinutes % 60 : totalMinutes,
    S: units.has('H') || units.has('M') ? totalSeconds % 60 : totalSeconds,
  };

  return renderPattern(pattern, (token) => {
    const padded = !token.startsWith('-');
    const value = values[padded ? token : token.slice(1)];
    if (value === undefined) return undefined;
    return {
      text: padded ? String(value).padStart(2, '0') : String(value),
      zero: value === 0,
    };
  });
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function ordinalise(day: number): string {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * @param value - an ISO-ish date, e.g. "2023-07-04" (any time part is ignored)
 * @param pattern - `%Y` `%y` `%m` `%-m` `%d` `%-d` `%o` `%B` `%b` `%A` `%a`
 * @returns e.g. `'%B %o, %Y'` -> "July 4th, 2023". Unparseable input is
 *          returned unchanged so a bad date never becomes a bogus one.
 */
export function formatDatePattern(value: string, pattern: string): string {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
  if (!parts) return value;

  // built and read in UTC throughout: these are date-only values, and local
  // getters would shift them a day either side of midnight
  const [year, month, day] = [
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
  ];
  const date = new Date(Date.UTC(year, month, day));
  // Date.UTC rolls overflow forward (month 13 -> next January), which would
  // turn a nonsense date into a confident wrong one, so require a round-trip
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return value;
  }

  const tokens: Record<string, string> = {
    Y: String(year),
    y: String(year % 100).padStart(2, '0'),
    m: String(month + 1).padStart(2, '0'),
    '-m': String(month + 1),
    d: String(day).padStart(2, '0'),
    '-d': String(day),
    o: ordinalise(day),
    B: MONTH_NAMES[month],
    b: MONTH_NAMES[month].slice(0, 3),
    A: DAY_NAMES[date.getUTCDay()],
    a: DAY_NAMES[date.getUTCDay()].slice(0, 3),
  };

  return renderPattern(pattern, (token) =>
    tokens[token] !== undefined ? { text: tokens[token] } : undefined
  );
}

/**
 *
 * @param hours - number of hours
 * @returns formatted string in days or hours e.g. "23h", "1d", "1023d"
 */
export function formatHours(hours: number): string {
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function makeSmall(code: string): string {
  return code
    .split('')
    .map((char) => SMALL_CAPS_MAP[char.toUpperCase()] || char)
    .join('');
}

const SMALL_CAPS_MAP: Record<string, string> = {
  A: 'ᴀ', // U+1D00
  B: 'ʙ', // U+0299
  C: 'ᴄ', // U+1D04
  D: 'ᴅ', // U+1D05
  E: 'ᴇ', // U+1D07
  F: 'ғ', // U+0493
  G: 'ɢ', // U+0262
  H: 'ʜ', // U+029C
  I: 'ɪ', // U+026A
  J: 'ᴊ', // U+1D0A
  K: 'ᴋ', // U+1D0B
  L: 'ʟ', // U+029F
  M: 'ᴍ', // U+1D0D
  N: 'ɴ', // U+0274
  O: 'ᴏ', // U+1D0F
  P: 'ᴘ', // U+1D18
  Q: 'ǫ', // U+01EB
  R: 'ʀ', // U+0280
  S: 'ꜱ', // U+A731
  T: 'ᴛ', // U+1D1B
  U: 'ᴜ', // U+1D1C
  V: 'ᴠ', // U+1D20
  W: 'ᴡ', // U+1D21
  // There is no widely supported small-cap X; fall back to "x".
  X: 'x',
  Y: 'ʏ', // U+028F
  Z: 'ᴢ', // U+1D22
};
