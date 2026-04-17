/**
 * Feedback service — collects system info, reads logs, uploads to Supabase.
 */

import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppState } from './state.js';
import { logger } from './logger.js';

export interface SystemInfo {
  appVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion: string;
  osVersion: string;
}

export interface FeedbackSubmission {
  type: 'bug' | 'feedback';
  title: string;
  description: string;
  includeLogs?: boolean;
  screenshotPaths?: string[];
}

export interface FeedbackResult {
  success: boolean;
  error?: string;
}

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}

export interface PickScreenshotsResult {
  files: PickedFile[];
  errors?: string[];
}

const MAX_LOG_LINES = 500;
const MAX_SCREENSHOTS = 5;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5 MB

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export class FeedbackService {
  getSystemInfo(): SystemInfo {
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron ?? 'unknown',
      osVersion: os.release(),
    };
  }

  /**
   * Open a native file picker for screenshot images.
   * Validates file sizes and enforces the per-report limit.
   */
  async pickScreenshots(currentCount: number): Promise<PickScreenshotsResult> {
    const remaining = MAX_SCREENSHOTS - currentCount;
    if (remaining <= 0) {
      return { files: [], errors: ['Maximum of 5 screenshots reached.'] };
    }

    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Attach Screenshots',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: IMAGE_EXTENSIONS },
      ],
    });

    if (canceled || filePaths.length === 0) {
      return { files: [] };
    }

    const selected = filePaths.slice(0, remaining);
    const files: PickedFile[] = [];
    const errors: string[] = [];

    for (const filePath of selected) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_SCREENSHOT_SIZE) {
          errors.push(`${path.basename(filePath)} exceeds 5 MB limit.`);
          continue;
        }
        files.push({
          path: filePath,
          name: path.basename(filePath),
          size: stat.size,
        });
      } catch {
        errors.push(`Could not read ${path.basename(filePath)}.`);
      }
    }

    if (filePaths.length > remaining) {
      errors.push(`Only ${remaining} more screenshot(s) allowed — extra files were skipped.`);
    }

    return { files, errors: errors.length > 0 ? errors : undefined };
  }

  /**
   * Read an image file and return a base64 data URL for thumbnail rendering.
   */
  readImagePreview(filePath: string): string | null {
    try {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
      };
      const mime = mimeMap[ext] ?? 'image/png';
      const buffer = fs.readFileSync(filePath);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  }

  async submit(submission: FeedbackSubmission): Promise<FeedbackResult> {
    const state = AppState.getInstance();
    const authState = await state.authService.getAuthState();

    if (!authState.isAuthenticated || !authState.user) {
      return { success: false, error: 'You must be signed in to submit feedback.' };
    }

    const supabase = state.authService.getSupabaseClient();
    const userId = authState.user.id;
    const userEmail = authState.user.email;
    const systemInfo = this.getSystemInfo();

    let logFilePath: string | null = null;

    // Upload logs if requested (bug reports only)
    if (submission.type === 'bug' && submission.includeLogs) {
      try {
        const logContent = this.readRecentLogs();
        if (logContent) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const storagePath = `${userId}/${timestamp}-logs.txt`;

          const { error: uploadError } = await supabase.storage
            .from('feedback-logs')
            .upload(storagePath, logContent, {
              contentType: 'text/plain',
              upsert: false,
            });

          if (uploadError) {
            console.warn('[feedback] Log upload failed:', uploadError.message);
          } else {
            logFilePath = storagePath;
          }
        }
      } catch (err) {
        console.warn('[feedback] Failed to read/upload logs:', err);
      }
    }

    // Upload screenshots if provided (bug reports only)
    let screenshotStoragePaths: string[] | null = null;

    if (submission.type === 'bug' && submission.screenshotPaths && submission.screenshotPaths.length > 0) {
      screenshotStoragePaths = [];
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      for (let i = 0; i < submission.screenshotPaths.length; i++) {
        const filePath = submission.screenshotPaths[i];
        try {
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mimeMap: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
          };
          const mime = mimeMap[ext] ?? 'application/octet-stream';
          const buffer = fs.readFileSync(filePath);
          const storagePath = `${userId}/${timestamp}-screenshot-${i}.${ext}`;

          const { error: uploadError } = await supabase.storage
            .from('feedback-logs')
            .upload(storagePath, buffer, {
              contentType: mime,
              upsert: false,
            });

          if (uploadError) {
            console.warn(`[feedback] Screenshot ${i} upload failed:`, uploadError.message);
          } else {
            screenshotStoragePaths.push(storagePath);
          }
        } catch (err) {
          console.warn(`[feedback] Failed to read/upload screenshot ${i}:`, err);
        }
      }

      if (screenshotStoragePaths.length === 0) {
        screenshotStoragePaths = null;
      }
    }

    // Insert feedback row
    const { error: insertError } = await supabase
      .from('feedback_submissions')
      .insert({
        user_id: userId,
        user_email: userEmail,
        type: submission.type,
        title: submission.title,
        description: submission.description,
        system_info: submission.type === 'bug' ? systemInfo : null,
        log_file_path: logFilePath,
        screenshot_paths: screenshotStoragePaths,
        app_version: systemInfo.appVersion,
        platform: systemInfo.platform,
      });

    if (insertError) {
      console.error('[feedback] Insert failed:', insertError.message);
      return { success: false, error: insertError.message };
    }

    return { success: true };
  }

  /**
   * Read the most recent log file, returning the last MAX_LOG_LINES lines.
   * Returns null in dev mode (no log files) or if no logs exist.
   */
  private readRecentLogs(): string | null {
    const logDir = logger.getLogDirectory();
    if (!logDir) return null;

    try {
      const files = fs.readdirSync(logDir)
        .filter(f => f.startsWith('conduit-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(logDir, f),
          mtime: fs.statSync(path.join(logDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) return null;

      const content = fs.readFileSync(files[0].path, 'utf-8');
      const lines = content.split('\n');

      if (lines.length > MAX_LOG_LINES) {
        return lines.slice(-MAX_LOG_LINES).join('\n');
      }

      return content;
    } catch (err) {
      console.warn('[feedback] Failed to read log files:', err);
      return null;
    }
  }
}

export const feedbackService = new FeedbackService();
