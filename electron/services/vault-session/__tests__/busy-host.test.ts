// @vitest-environment node
// The busy report sent with every heartbeat (spec 6.2 p_busy): open sessions plus running
// commands, and CLI agent plus MCP jobs. A source that throws counts as 0 and is logged.
import { describe, expect, it } from 'vitest';
import { createBusyHost, type BusySources } from '../host-electron.js';
import { MemoryLogger } from '../../sync/__tests__/host-fakes.js';

function sources(over: Partial<BusySources> = {}): BusySources {
  return {
    terminals: () => 1,
    rdp: () => 2,
    vnc: () => 0,
    web: () => 1,
    commands: () => 3,
    agentJobs: () => 2,
    mcpJobs: () => 1,
    ...over,
  };
}

describe('busy report', () => {
  it('counts running commands as sessions and agent plus MCP work as jobs', () => {
    const report = createBusyHost(sources(), new MemoryLogger()).busy();
    expect(report).toEqual({ sessions: 7, jobs: 3 });
  });

  it('a failing or nonsense source counts as 0 and is logged', () => {
    const logger = new MemoryLogger();
    const report = createBusyHost(
      sources({
        commands: () => {
          throw new Error('executor gone');
        },
        mcpJobs: () => Number.NaN,
      }),
      logger,
    ).busy();
    expect(report).toEqual({ sessions: 4, jobs: 2 });
    expect(logger.messages('warn').some((m) => m.includes('busy count unavailable'))).toBe(true);
  });
});
