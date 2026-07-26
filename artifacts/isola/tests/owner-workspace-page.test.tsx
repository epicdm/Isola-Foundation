import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Owner Workspace page contract. The recomposition swapped bespoke cards for the
// composite layer; the existing queue behaviour (scope, rank, counts, table)
// must be byte-for-byte unchanged in meaning.

const { getSessionMock, getWorkQueueMock, redirectMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getWorkQueueMock: vi.fn(),
  redirectMock: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/workspace-queue', () => ({ getWorkQueue: getWorkQueueMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/components/workspace-queue-table', () => ({
  WorkspaceQueueTable: ({ data }: { data: unknown[] }) => <div data-rows={data.length}>QUEUE_TABLE</div>,
}));

import WorkspacePage from '../app/(owner)/workspace/page';

function session() {
  return { effectiveTenantId: 'tenant-under-test', effectiveTenant: { business_name: 'Acme Ltd' }, user: { agent_took_over: false } };
}

function queue(overrides: Record<string, unknown> = {}) {
  getWorkQueueMock.mockResolvedValue({
    rank: 'owner',
    scope: 'all',
    counts: { odoo_task: 4, conversation: 3, voicemail: 2, approval: 1 },
    items: [{ id: 'i1', type: 'odoo_task' }],
    ...overrides,
  });
}

async function render() {
  return renderToStaticMarkup(await WorkspacePage());
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(session());
});

describe('Workspace — authorization boundary', () => {
  it('redirects an unauthenticated visitor and never builds a queue', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(WorkspacePage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/');
    expect(getWorkQueueMock).not.toHaveBeenCalled();
  });

  it('builds the queue from the session, so scope stays server-resolved', async () => {
    queue();
    await render();
    expect(getWorkQueueMock).toHaveBeenCalledWith(session());
  });
});

describe('Workspace — queue behaviour is unchanged', () => {
  it('renders the four existing counts', async () => {
    queue();
    const html = await render();
    expect(html).toContain('Tasks');
    expect(html).toContain('Conversations');
    expect(html).toContain('Voicemail');
    expect(html).toContain('Approvals');
    expect(html).toContain('>4<');
    expect(html).toContain('>3<');
    expect(html).toContain('>2<');
    expect(html).toContain('>1<');
  });

  it('renders a zero count rather than hiding the metric', async () => {
    queue({ counts: { odoo_task: 0, conversation: 0, voicemail: 0, approval: 0 } });
    const html = await render();
    expect(html).toContain('>0<');
  });

  it('hands populated items to the existing queue table untouched', async () => {
    queue();
    const html = await render();
    expect(html).toContain('QUEUE_TABLE');
    expect(html).toContain('data-rows="1"');
  });

  it('shows the tenant-wide vs your-items scope, and the rank', async () => {
    queue();
    expect(await render()).toContain('tenant-wide');
    queue({ scope: 'own', rank: 'manager' });
    const html = await render();
    expect(html).toContain('your items');
    expect(html).toContain('manager');
  });

  it('keeps the explanatory subtitle', async () => {
    queue();
    const html = await render();
    expect(html).toContain('Your open items across tasks, inbox, voicemail, and approvals.');
  });
});

describe('Workspace — empty state', () => {
  it('renders the composite empty state when the queue is clear', async () => {
    queue({ items: [] });
    const html = await render();
    expect(html).toContain('Your queue is clear');
    expect(html).toContain('New tasks, conversations, voicemail, and approvals will show up here.');
    expect(html).not.toContain('QUEUE_TABLE');
  });

  it('does not render the empty state once items exist', async () => {
    queue();
    const html = await render();
    expect(html).not.toContain('Your queue is clear');
  });
});
