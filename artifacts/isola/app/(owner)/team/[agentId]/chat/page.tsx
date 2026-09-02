import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { getSession } from '@/lib/session';
import { requireWorkspaceAccess } from '@/lib/workspace/authz';
import { resolveStaffChatEligibility } from '@/lib/workspace/staff-agent-chat';
import { WorkspaceAccessDenied } from '@/components/workspace/access-denied';
import { StaffAgentChat } from '@/components/workspace/staff-agent-chat';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const revalidate = 0;

/**
 * S1 — GET /team/[agentId]/chat.
 *
 * An agent that is not eligible for staff chat (inactive, wrong runtime, no
 * Clawith binding, or not on the FOUNDATION_STAFF_CHAT_AGENT_IDS allowlist)
 * still resolves to a real page — it renders the truthful `blocked` state
 * rather than a 404, matching the POST route's own distinction between
 * "this agent doesn't belong to you" (404) and "this agent exists but chat
 * isn't available for it" (a safe state).
 */
export default async function StaffAgentChatPage({ params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session) redirect('/');

  const guard = await requireWorkspaceAccess(session, 'manager');
  if (!guard.ok) return <WorkspaceAccessDenied message={guard.error} />;

  const { agentId } = await params;
  const eligibility = await resolveStaffChatEligibility(session.effectiveTenantId, agentId);

  if (!eligibility.eligible && eligibility.reason === 'agent_not_found') {
    notFound();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Button asChild size="sm" variant="ghost" className="-ml-2 w-fit text-muted-foreground">
          <Link href={`/team/${agentId}`}>
            <ArrowLeft className="size-3.5" /> Back to assistant
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          Chat with {eligibility.eligible ? eligibility.agent.name : 'assistant'}
        </h1>
      </div>

      {eligibility.eligible ? (
        <StaffAgentChat agentId={agentId} agentName={eligibility.agent.name} />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <ShieldAlert className="size-8 text-muted-foreground" />
            <div className="font-medium">This assistant isn&apos;t available for staff chat right now.</div>
            <p className="max-w-prose text-sm text-muted-foreground">
              Ask a workspace owner to enable chat for this assistant if you need it.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
