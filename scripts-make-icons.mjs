// Icon generator (TR-10): green LED button on LED-black, alarm-clock vibe.
import sharp from 'sharp';

const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#050807"/>
  <circle cx="256" cy="256" r="${170 - pad}" fill="#16a34a"/>
  <circle cx="256" cy="256" r="${170 - pad}" fill="url(#g)"/>
  <defs>
    <radialGradient id="g" cx="0.35" cy="0.3" r="1">
      <stop offset="0" stop-color="#4ade80"/>
      <stop offset="0.6" stop-color="#22c55e"/>
      <stop offset="1" stop-color="#15803d"/>
    </radialGradient>
  </defs>
  <text x="256" y="300" font-family="monospace" font-size="150" font-weight="bold"
        text-anchor="middle" fill="#052e12">TR</text>
</svg>`;

const jobs = [
  ['public/icons/icon-192.png', 192, 0],
  ['public/icons/icon-512.png', 512, 0],
  ['public/icons/icon-maskable-512.png', 512, 40],
  ['public/icons/apple-touch-icon.png', 180, 0]
];
for (const [out, size, pad] of jobs) {
  await sharp(Buffer.from(svg(pad))).resize(size, size).png().toFile(out);
  console.log('wrote', out);
}
