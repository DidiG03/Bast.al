/**
 * The server's time, as near as the page can tell: a device whose clock runs
 * fast or slow would say a notice from two minutes ago is five minutes old.
 * Each answer from the API carries its own time (the Date header, to the
 * second); the median gap over the last few answers is applied to this
 * device's clock. Off by a second or so, never by the device's own error.
 */
const samples: number[] = [];
let offset = 0;

/** Notes the time an API answer gave (its Date header). */
export function noteServerTime(header: string | null) {
  if (!header) return;
  const server = Date.parse(header);
  if (Number.isNaN(server)) return;
  // The header is cut to the second: the answer was sent half a second later on average.
  samples.push(server + 500 - Date.now());
  if (samples.length > 7) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Within a couple of seconds the device is as good as the header: left alone.
  offset = Math.abs(median) > 2_000 ? median : 0;
}

/** Now, by the server's clock (ms). */
export function serverNow(): number {
  return Date.now() + offset;
}
