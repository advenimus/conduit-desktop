/**
 * IPC handlers for bug reports and feedback submissions.
 */

import { ipcMain } from 'electron';
import { feedbackService, type FeedbackSubmission } from '../services/feedback.js';

export function registerFeedbackHandlers(): void {
  ipcMain.handle('feedback_get_system_info', () => {
    return feedbackService.getSystemInfo();
  });

  ipcMain.handle('feedback_submit', async (_e, args) => {
    const submission = args as FeedbackSubmission;
    return feedbackService.submit(submission);
  });

  ipcMain.handle('feedback_pick_screenshots', async (_e, args) => {
    const { currentCount } = args as { currentCount: number };
    return feedbackService.pickScreenshots(currentCount);
  });

  ipcMain.handle('feedback_read_image_preview', (_e, args) => {
    const { filePath } = args as { filePath: string };
    return feedbackService.readImagePreview(filePath);
  });
}
