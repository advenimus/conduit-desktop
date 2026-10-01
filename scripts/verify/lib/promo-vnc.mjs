// A minimal local VNC (RFB 3.8, no auth, raw encoding) server that serves one still frame: the mock Ubuntu
// desktop the promo film shows inside Conduit's VNC tab. Only the remote screen is mocked; the Conduit
// window around it is the real app.

import net from 'node:net';
import sharp from 'sharp';

const WIDTH = 1528;
const HEIGHT = 1008;

const ICONS = [
  ['#3584e4', 'F'], ['#e66100', 'T'], ['#2ec27e', 'S'], ['#9141ac', 'C'], ['#f6d32d', 'N'], ['#c01c28', 'M'],
];

function desktopSvg() {
  const dock = ICONS.map(([color, letter], i) => {
    const y = 90 + i * 76;
    return `<rect x="14" y="${y}" width="56" height="56" rx="14" fill="${color}"/>`
      + `<text x="42" y="${y + 38}" font-family="Ubuntu, Helvetica, Arial" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text>`;
  }).join('');
  const lines = [
    ['#8ae234', 'ops@build-01', '#729fcf', ':~$ ', '#ffffff', 'uptime'],
    ['#ffffff', ' 09:41:07 up 12 days,  3:02,  1 user,  load average: 0.18, 0.22, 0.19', '', '', '', ''],
    ['#8ae234', 'ops@build-01', '#729fcf', ':~$ ', '#ffffff', 'df -h / | tail -1'],
    ['#ffffff', '/dev/sda2       118G   41G   71G  37% /', '', '', '', ''],
    ['#8ae234', 'ops@build-01', '#729fcf', ':~$ ', '#ffffff', ''],
  ];
  const term = lines.map((l, i) => {
    const y = 320 + i * 30;
    return `<text x="452" y="${y}" font-family="Ubuntu Mono, Menlo, monospace" font-size="21"><tspan fill="${l[0]}">${l[1]}</tspan><tspan fill="${l[2]}">${l[3]}</tspan><tspan fill="${l[4]}">${l[5]}</tspan></text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2c001e"/><stop offset="0.55" stop-color="#77216f"/><stop offset="1" stop-color="#e95420"/>
      </linearGradient>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#wall)"/>
    <circle cx="1250" cy="760" r="420" fill="#e95420" opacity="0.25"/>
    <rect width="${WIDTH}" height="34" fill="#000"/>
    <text x="20" y="23" font-family="Ubuntu, Helvetica, Arial" font-size="17" fill="#fff">Activities</text>
    <text x="${WIDTH / 2}" y="23" font-family="Ubuntu, Helvetica, Arial" font-size="17" fill="#fff" text-anchor="middle">Oct 1  09:41</text>
    <rect x="0" y="34" width="84" height="${HEIGHT - 34}" fill="#000" opacity="0.55"/>
    ${dock}
    <rect x="420" y="230" width="900" height="460" rx="12" fill="#300a24"/>
    <rect x="420" y="230" width="900" height="44" rx="12" fill="#3d3846"/>
    <rect x="420" y="262" width="900" height="12" fill="#3d3846"/>
    <text x="870" y="258" font-family="Ubuntu, Helvetica, Arial" font-size="17" fill="#ddd" text-anchor="middle">ops@build-01: ~</text>
    ${term}
  </svg>`;
}

async function desktopRgba() {
  const { data } = await sharp(Buffer.from(desktopSvg())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data;
}

function encodePixels(rgba, fmt) {
  const bytes = fmt.bpp / 8;
  const out = Buffer.alloc(WIDTH * HEIGHT * bytes);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += bytes) {
    const r = Math.round((rgba[i] * fmt.redMax) / 255);
    const g = Math.round((rgba[i + 1] * fmt.greenMax) / 255);
    const b = Math.round((rgba[i + 2] * fmt.blueMax) / 255);
    const px = ((r << fmt.redShift) | (g << fmt.greenShift) | (b << fmt.blueShift)) >>> 0;
    if (bytes === 4) {
      if (fmt.bigEndian) out.writeUInt32BE(px, o);
      else out.writeUInt32LE(px, o);
    } else if (bytes === 2) {
      if (fmt.bigEndian) out.writeUInt16BE(px & 0xffff, o);
      else out.writeUInt16LE(px & 0xffff, o);
    }
    else out[o] = px & 0xff;
  }
  return out;
}

function readFormat(buf, at) {
  return {
    bpp: buf[at], bigEndian: buf[at + 2] !== 0,
    redMax: buf.readUInt16BE(at + 4), greenMax: buf.readUInt16BE(at + 6), blueMax: buf.readUInt16BE(at + 8),
    redShift: buf[at + 10], greenShift: buf[at + 11], blueShift: buf[at + 12],
  };
}

const SERVER_FORMAT = { bpp: 32, bigEndian: false, redMax: 255, greenMax: 255, blueMax: 255, redShift: 16, greenShift: 8, blueShift: 0 };

function handle(socket, rgba) {
  let stage = 'version';
  let fmt = SERVER_FORMAT;
  let sent = false;
  let buf = Buffer.alloc(0);
  const sendFrame = () => {
    const header = Buffer.alloc(16);
    header[0] = 0;
    header.writeUInt16BE(1, 2);
    header.writeUInt16BE(WIDTH, 8);
    header.writeUInt16BE(HEIGHT, 10);
    header.writeInt32BE(0, 12);
    socket.write(Buffer.concat([header, encodePixels(rgba, fmt)]));
    sent = true;
  };
  socket.write('RFB 003.008\n');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (stage === 'version') {
        if (buf.length < 12) return;
        buf = buf.subarray(12);
        socket.write(Buffer.from([1, 1]));
        stage = 'security';
      } else if (stage === 'security') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        socket.write(Buffer.from([0, 0, 0, 0]));
        stage = 'init';
      } else if (stage === 'init') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        const name = Buffer.from('build-01');
        const init = Buffer.alloc(24);
        init.writeUInt16BE(WIDTH, 0);
        init.writeUInt16BE(HEIGHT, 2);
        init[4] = 32; init[5] = 24; init[6] = 0; init[7] = 1;
        init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
        init[14] = 16; init[15] = 8; init[16] = 0;
        init.writeUInt32BE(name.length, 20);
        socket.write(Buffer.concat([init, name]));
        stage = 'normal';
      } else {
        if (buf.length < 1) return;
        const type = buf[0];
        let need;
        if (type === 0) need = 20;
        else if (type === 2) need = buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity;
        else if (type === 3) need = 10;
        else if (type === 4) need = 8;
        else if (type === 5) need = 6;
        else if (type === 6) need = buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity;
        else need = buf.length; // unknown message: drop what we have
        if (buf.length < need) return;
        if (type === 0) fmt = readFormat(buf, 4);
        if (type === 3 && (buf[1] === 0 || !sent)) sendFrame();
        buf = buf.subarray(need);
      }
    }
  });
}

/** Starts the mock desktop server on a free localhost port; stopped by the run's cleanup. Returns {port}. */
export async function startMockVnc(run) {
  const rgba = await desktopRgba();
  const server = net.createServer((socket) => handle(socket, rgba));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  run.onCleanup('stop the mock VNC desktop', () => new Promise((resolve) => server.close(() => resolve())));
  return { port: server.address().port };
}
