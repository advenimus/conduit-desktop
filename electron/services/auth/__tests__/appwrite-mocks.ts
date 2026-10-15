import { vi } from 'vitest';

/** node-appwrite stand-in: a chainable Client and an Account whose calls each test sets. */
export const account = {
  get: vi.fn(async (): Promise<Record<string, unknown>> => {
    throw new Error('not set');
  }),
  getSession: vi.fn(async () => ({ expire: '2099-01-01T00:00:00.000Z' })),
  deleteSession: vi.fn(async () => ({})),
};

export class AppwriteException extends Error {
  constructor(message: string, readonly code: number, readonly type: string) {
    super(message);
  }
}

export const nodeAppwrite = () => ({
  Client: class {
    setEndpoint() {
      return this;
    }
    setProject() {
      return this;
    }
    setSession() {
      return this;
    }
  },
  Account: class {
    constructor() {
      return account;
    }
  },
  Functions: class {
    async createExecution() {
      return { responseStatusCode: 500, responseBody: '{"data":null,"error":{"code":"XX000","message":"no server in unit tests","details":null,"hint":null}}' };
    }
  },
  ExecutionMethod: { POST: 'POST' },
  AppwriteException,
});

export const envConfig = () => ({
  getEnvConfig: () => ({ appwriteEndpoint: 'http://localhost:8085/v1', appwriteProjectId: 'conduit-dev', websiteUrl: 'http://localhost:3000', environment: 'preview' }),
  getDataDir: () => '/nonexistent',
  isLocalBackend: () => true,
});
