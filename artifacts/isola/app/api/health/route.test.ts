import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const ORIGINAL = process.env.DEPLOY_SHA;

beforeEach(() => {
  delete process.env.DEPLOY_SHA;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DEPLOY_SHA;
  else process.env.DEPLOY_SHA = ORIGINAL;
});

describe('GET /api/health', () => {
  it('reports the deployed commit when DEPLOY_SHA is set', async () => {
    process.env.DEPLOY_SHA = 'b59b8f0cf82a09e0baa6962d93ffea33a4082f48';

    const body = await (await GET()).json();

    expect(body).toEqual({ status: 'ok', sha: 'b59b8f0cf82a09e0baa6962d93ffea33a4082f48' });
  });

  it('reports null rather than a fabricated value when DEPLOY_SHA is absent', async () => {
    const body = await (await GET()).json();

    expect(body).toEqual({ status: 'ok', sha: null });
  });
});
