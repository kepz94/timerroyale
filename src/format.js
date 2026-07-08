// Shared display formatting (TR-18): deviations are always expressed in
// seconds ("0.1s", "0.25s"), never milliseconds.
export const fmtS = (ms) => (ms / 1000).toFixed(1);

/** Player's stopped time in seconds with hundredths (TR-26): 6790 -> "6.79" */
export const fmtS2 = (ms) => (ms / 1000).toFixed(2);

/** Deviation in seconds, up to 2 decimals, trailing zeros trimmed: 100->0.1, 250->0.25, 1000->1 */
export function fmtOff(ms) {
  return (Math.round(ms / 10) / 100).toFixed(2).replace(/\.?0+$/, '');
}
