/**
 * Production logging service
 * Captures console output to rotating log files in user data directory
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const MAX_LOG_AGE_MS = 3 * 24 * 60 * 60 * 1000; // Delete logs older than 3 days
const LOG_FILE_PREFIX = 'conduit-';

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

class Logger {
  private logPath: string = '';
  private currentLogFile: string = '';
  private writeStream: fs.WriteStream | null = null;
  private originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };

  /**
   * Initialize logger for production builds
   * Returns log file path on success, null if disabled (dev mode)
   */
  public async init(): Promise<string | null> {
    // Only enable in production
    if (!app.isPackaged) {
      return null;
    }

    try {
      // Get platform-specific log directory
      // macOS: ~/Library/Logs/{app name}
      // Windows: %USERPROFILE%\AppData\Roaming\{app name}\logs
      // Linux: ~/.config/{app name}/logs
      this.logPath = app.getPath('logs');

      // Ensure log directory exists
      if (!fs.existsSync(this.logPath)) {
        fs.mkdirSync(this.logPath, { recursive: true });
      }

      // Rotate old logs
      await this.rotateLogFiles();

      // Create new log file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFileName = `${LOG_FILE_PREFIX}${timestamp}.log`;
      this.currentLogFile = path.join(this.logPath, logFileName);

      // Create write stream
      this.writeStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });

      // Write session start marker
      this.writeLog('INFO', '='.repeat(80));
      this.writeLog('INFO', `Conduit v${app.getVersion()} - Session started`);
      this.writeLog('INFO', `Platform: ${process.platform} ${process.arch}`);
      this.writeLog('INFO', `Node: ${process.version}`);
      this.writeLog('INFO', `Electron: ${process.versions.electron}`);
      this.writeLog('INFO', '='.repeat(80));

      // Intercept console methods
      this.interceptConsole();

      return this.currentLogFile;
    } catch (err) {
      // If logging setup fails, log to original console but don't crash
      this.originalConsole.error('[Logger] Failed to initialize:', err);
      return null;
    }
  }

  /**
   * Delete log files older than MAX_LOG_AGE_MS
   */
  private async rotateLogFiles(): Promise<void> {
    try {
      const files = fs.readdirSync(this.logPath);
      const now = Date.now();

      const logFiles = files
        .filter((f) => f.startsWith(LOG_FILE_PREFIX) && f.endsWith('.log'))
        .map((f) => ({
          name: f,
          path: path.join(this.logPath, f),
          mtime: fs.statSync(path.join(this.logPath, f)).mtime.getTime(),
        }));

      for (const file of logFiles) {
        if (now - file.mtime > MAX_LOG_AGE_MS) {
          try {
            fs.unlinkSync(file.path);
          } catch (err) {
            this.originalConsole.error(`[Logger] Failed to delete old log: ${file.name}`, err);
          }
        }
      }
    } catch (err) {
      this.originalConsole.error('[Logger] Failed to rotate logs:', err);
    }
  }

  /**
   * Intercept console methods to write to log file
   */
  private interceptConsole(): void {
    console.log = (...args: unknown[]) => {
      this.writeLog('LOG', this.formatArgs(args));
      this.originalConsole.log(...args);
    };

    console.error = (...args: unknown[]) => {
      this.writeLog('ERROR', this.formatArgs(args));
      this.originalConsole.error(...args);
    };

    console.warn = (...args: unknown[]) => {
      this.writeLog('WARN', this.formatArgs(args));
      this.originalConsole.warn(...args);
    };

    console.info = (...args: unknown[]) => {
      this.writeLog('INFO', this.formatArgs(args));
      this.originalConsole.info(...args);
    };

    console.debug = (...args: unknown[]) => {
      this.writeLog('DEBUG', this.formatArgs(args));
      this.originalConsole.debug(...args);
    };
  }

  /**
   * Format console arguments to string
   */
  private formatArgs(args: unknown[]): string {
    return args
      .map((arg) => {
        if (typeof arg === 'string') {
          return arg;
        }
        if (arg instanceof Error) {
          return `${arg.message}\n${arg.stack}`;
        }
        return util.inspect(arg, { depth: 3, colors: false });
      })
      .join(' ');
  }

  /**
   * Write log entry to file
   */
  private writeLog(level: string, message: string): void {
    if (!this.writeStream) {
      return;
    }

    const timestamp = new Date().toISOString();
    const entry: LogEntry = { timestamp, level, message };
    const line = `[${entry.timestamp}] [${entry.level.padEnd(5)}] ${entry.message}\n`;

    try {
      this.writeStream.write(line);
    } catch (err) {
      // If write fails, don't crash - just log to original console
      this.originalConsole.error('[Logger] Failed to write log:', err);
    }
  }

  /**
   * Get current log file path
   */
  public getLogPath(): string {
    return this.currentLogFile;
  }

  /**
   * Get log directory path
   */
  public getLogDirectory(): string {
    return this.logPath;
  }

  /**
   * Close logger and write session end marker
   */
  public close(): void {
    if (!this.writeStream) {
      return;
    }

    this.writeLog('INFO', '='.repeat(80));
    this.writeLog('INFO', 'Session ended');
    this.writeLog('INFO', '='.repeat(80));

    this.writeStream.end();
    this.writeStream = null;
  }
}

// Singleton instance
export const logger = new Logger();
