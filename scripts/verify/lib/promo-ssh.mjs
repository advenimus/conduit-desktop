// A tiny local SSH server for the promo footage: it accepts any login and shows a scripted shell, so a
// "web-01" tab connects for real and carries believable output without touching any real machine.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ESC = '\x1b[';
const GREEN = `${ESC}1;32m`;
const BLUE = `${ESC}1;34m`;
const RESET = `${ESC}0m`;

/** The prompt of a shell: user@host:~$ in the usual colors. */
export const prompt = (user, host) => `${GREEN}${user}@${host}${RESET}:${BLUE}~${RESET}$ `;

/** A shell history: [{cmd, out}] typed one after the other, each followed by a fresh prompt. */
export function renderSession({ user, host, motd = '', history = [] }) {
  const lines = [motd];
  for (const { cmd, out } of history) lines.push(`${prompt(user, host)}${cmd}\r\n${out}`);
  return `${lines.filter(Boolean).join('\r\n')}${history.length > 0 || motd ? '\r\n' : ''}${prompt(user, host)}`;
}

/**
 * Starts the server on 127.0.0.1 with a free port. `session` is {host, motd, history, typing}; the user name
 * comes from the login. Typed characters are echoed, Enter answers with a new prompt. Returns {port, close}.
 */
export async function startMockSsh(run, { host, motd, history, typing = '' }) {
  const { Server, utils } = require('ssh2');
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let user = 'deploy';
    client.on('authentication', (ctx) => {
      user = ctx.username || user;
      ctx.accept();
    });
    client.on('error', () => {});
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty());
        session.on('window-change', (acceptResize) => acceptResize?.());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          const shown = renderSession({ user, host, motd, history });
          // Split off the last prompt: it is written later, with a half-typed command after it.
          const cut = shown.lastIndexOf(prompt(user, host));
          stream.write(shown.slice(0, cut));
          const lastLine = `${shown.slice(cut)}${typing}`;
          setTimeout(() => stream.write(lastLine), 600);
          stream.on('data', (data) => {
            for (const ch of String(data)) {
              // Ctrl+L redraws the current line (the harness uses it after a tab switch).
              if (ch === '\x0c') stream.write(`\r\x1b[2K${lastLine}`);
              else if (ch === '\r') stream.write(`\r\n${prompt(user, host)}`);
              else if (ch === '\x7f') stream.write('\b \b');
              else stream.write(ch);
            }
          });
        });
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = run.onCleanup(`stop mock ssh ${host}`, () => new Promise((resolve) => server.close(() => resolve())));
  return { port: server.address().port, close };
}
