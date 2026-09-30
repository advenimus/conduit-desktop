// @vitest-environment node
// EngineManager.runningTurns: a chat session counts as a running AI task only while a turn is in
// flight, so an open but idle chat does not show "1 AI task" to the user's other devices.
import { describe, expect, it } from 'vitest';
import { EngineManager } from '../engine-manager.js';
import type { ChatEngine, ChatEngineSession } from '../engine.js';

function gatedEngine() {
  const gates: (() => void)[] = [];
  const session: ChatEngineSession = { id: 's1', engineType: 'claude-code', createdAt: '2026-09-26T00:00:00Z' };
  const engine = {
    engineType: 'claude-code',
    listSessions: () => [session],
    sendMessage: () => new Promise<void>((resolve) => gates.push(resolve)),
  } as unknown as ChatEngine;
  return { engine, finishTurn: () => gates.shift()?.() };
}

describe('EngineManager.runningTurns', () => {
  it('counts a session only while its turn runs', async () => {
    const em = new EngineManager();
    const { engine, finishTurn } = gatedEngine();
    em.register(engine);
    expect(em.listAllSessions()).toHaveLength(1);
    expect(em.runningTurns()).toBe(0);
    const turn = em.sendMessage('claude-code', 's1', 'hello', () => undefined);
    expect(em.runningTurns()).toBe(1);
    finishTurn();
    await turn;
    expect(em.runningTurns()).toBe(0);
  });

  it('a failed turn is no longer running', async () => {
    const em = new EngineManager();
    em.register({
      engineType: 'claude-code',
      listSessions: () => [],
      sendMessage: async () => {
        throw new Error('CLI crashed');
      },
    } as unknown as ChatEngine);
    await expect(em.sendMessage('claude-code', 's1', 'hello', () => undefined)).rejects.toThrow('CLI crashed');
    expect(em.runningTurns()).toBe(0);
  });
});
