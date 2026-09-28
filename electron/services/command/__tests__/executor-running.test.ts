// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({}));

const { CommandExecutor } = await import('../executor.js');

function exited(session: { once(event: 'exit', cb: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => session.once('exit', resolve));
}

describe.skipIf(process.platform === 'win32')('CommandExecutor.runningCount', () => {
  it('counts only commands that have not finished', async () => {
    const executor = new CommandExecutor();
    expect(executor.runningCount()).toBe(0);
    executor.execute('long', { command: 'sleep 30', runAsMode: 'current' });
    const quick = executor.execute('quick', { command: 'true', runAsMode: 'current' });
    expect(executor.runningCount()).toBe(2);
    await exited(quick);
    expect(executor.runningCount()).toBe(1);
    executor.closeAll();
    expect(executor.runningCount()).toBe(0);
  });
});
