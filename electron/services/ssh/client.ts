/**
 * SSH client implementation via ssh2.
 *
 * Port of crates/conduit-ssh/src/client.rs and auth.rs
 */

import { Client, ClientChannel } from 'ssh2';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { resolveHostname } from '../dns-resolver.js';
import { withLocalNetworkHint } from '../local-network.js';

// ── Config & Auth types ──────────────────────────────────────────────

export interface SshAuthPassword {
  type: 'password';
  username: string;
  password: string;
}

export interface SshAuthPublicKey {
  type: 'public_key';
  username: string;
  keyPath?: string;      // File path to key (e.g., ~/.ssh/id_rsa)
  keyContent?: string;   // Inline PEM key content from vault
  passphrase?: string;
}

export type SshAuth = SshAuthPassword | SshAuthPublicKey;

export interface SshConfig {
  host: string;
  port?: number;        // default 22
  cols?: number;        // default 80
  rows?: number;        // default 24
  auth: SshAuth;
  timeoutMs?: number;   // default 30 000
  keepaliveMs?: number; // default 60 000
}

// ── SshSession ───────────────────────────────────────────────────────

/**
 * Represents a connected SSH session with an interactive shell.
 *
 * Events:
 *  - 'data'  (data: Buffer)   — data received from the remote shell
 *  - 'close' ()               — session closed
 *  - 'error' (err: Error)     — non-fatal error
 */
export class SshSession extends EventEmitter {
  private client: Client;
  private channel: ClientChannel | null = null;
  private _connected = false;

  constructor(private config: SshConfig) {
    super();
    this.client = new Client();

    // Prevent uncaught EventEmitter errors from crashing the process.
    // Consumers should attach their own 'error' listener for logging.
    this.on('error', () => {});
  }

  /** Establish the SSH connection, authenticate, request PTY + shell. */
  async connect(): Promise<void> {
    const cfg = this.config;
    const port = cfg.port ?? 22;
    const timeoutMs = cfg.timeoutMs ?? 30_000;
    const keepaliveMs = cfg.keepaliveMs ?? 60_000;

    const resolvedHost = await resolveHostname(cfg.host);

    return new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        this.openShell().then(resolve).catch(reject);
      };

      const onError = (err: Error) => {
        cleanup();
        withLocalNetworkHint(err, resolvedHost)
          .then(reject)
          .catch(() => reject(err));
      };

      const cleanup = () => {
        this.client.removeListener('ready', onReady);
        this.client.removeListener('error', onError);
      };

      this.client.once('ready', onReady);
      this.client.once('error', onError);

      // Listen for close after connection
      this.client.on('close', () => {
        this._connected = false;
        this.channel = null;
        this.emit('close');
      });

      this.client.on('error', (err) => {
        this.emit('error', err);
      });

      const connectOpts: Record<string, unknown> = {
        host: resolvedHost,
        port,
        readyTimeout: timeoutMs,
        keepaliveInterval: keepaliveMs,
      };

      if (cfg.auth.type === 'password') {
        connectOpts.username = cfg.auth.username;
        connectOpts.password = cfg.auth.password;
        // Some SSH servers (notably VMware ESXi, and many network/appliance
        // SSH daemons) only advertise `keyboard-interactive` and do NOT offer
        // the plain `password` auth method. The OpenSSH CLI transparently
        // satisfies the password prompt over keyboard-interactive, which is
        // why `ssh user@host` works while ssh2 reports "All configured
        // authentication methods failed". ssh2 only attempts
        // keyboard-interactive when `tryKeyboard` is set, so enable it and
        // answer the prompts with the same password below.
        connectOpts.tryKeyboard = true;

        const password = cfg.auth.password;
        this.client.on(
          'keyboard-interactive',
          (_name, _instructions, _lang, prompts, finish) => {
            // Reply with the password for every prompt the server sends.
            // ESXi sends a single hidden "Password:" prompt; mapping over
            // `prompts` also handles servers that issue more than one.
            finish(prompts.map(() => password));
          },
        );
      } else {
        connectOpts.username = cfg.auth.username;
        if (cfg.auth.keyContent) {
          // Normalize CRLF→LF — Windows clipboard may inject \r\n
          connectOpts.privateKey = cfg.auth.keyContent.replace(/\r\n/g, '\n');
        } else if (cfg.auth.keyPath) {
          connectOpts.privateKey = fs.readFileSync(cfg.auth.keyPath);
        }
        if (cfg.auth.passphrase) {
          connectOpts.passphrase = cfg.auth.passphrase;
        }
      }

      // Accept all host keys (mirrors Rust impl TODO for host key verification)
      connectOpts.hostVerifier = () => true;

      this.client.connect(connectOpts as Parameters<Client['connect']>[0]);
    });
  }

  /** Request a PTY + interactive shell on the SSH channel. */
  private openShell(): Promise<void> {
    const cols = this.config.cols ?? 80;
    const rows = this.config.rows ?? 24;

    return new Promise((resolve, reject) => {
      this.client.shell(
        { term: 'xterm-256color', cols, rows },
        (err, channel) => {
          if (err) return reject(err);

          this.channel = channel;
          this._connected = true;

          channel.on('data', (data: Buffer) => {
            this.emit('data', data);
          });

          channel.stderr.on('data', (data: Buffer) => {
            this.emit('data', data);
          });

          channel.on('close', () => {
            this._connected = false;
            this.channel = null;
            this.emit('close');
          });

          resolve();
        },
      );
    });
  }

  /** Write data to the remote shell. */
  write(data: Buffer | Uint8Array): void {
    if (!this.channel) throw new Error('SSH channel not open');
    this.channel.write(data);
  }

  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void {
    if (this.channel) {
      this.channel.setWindow(rows, cols, rows * 16, cols * 8);
    }
  }

  /** Close the SSH session. */
  close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this._connected = false;
    this.client.end();
  }

  get connected(): boolean {
    return this._connected;
  }
}
