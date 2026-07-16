import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getSession } from '@/lib/session';
import { getWorkQueueItemDetail } from '@/lib/workspace-item-detail';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkspaceAssistPanel } from '@/components/workspace-assist-panel';
import { WorkspaceApproveButton } from '@/components/workspace-approve-button';

export const revalidate = 0;

export default async function WorkspaceItemPage({
  params,
}: {
  params: Promise<{ type: string; id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/');

  const { type, id } = await params;

  // Conversation items already have a full thread view — send those there
  // instead of duplicating it under /workspace.
  if (type === 'conversation') redirect(`/inbox/${id}`);

  const item = await getWorkQueueItemDetail(session, type, id);
  if (!item) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/workspace" className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Workspace
        </Link>
        <h1 className="text-lg font-semibold tracking-tight">{item.title}</h1>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {item.fields.map((f) => (
              <div key={f.label} className="grid grid-cols-3 gap-3 text-sm">
                <div className="text-muted-foreground">{f.label}</div>
                <div className="col-span-2 whitespace-pre-wrap">{f.value}</div>
              </div>
            ))}

            {item.approval &&
              (session.isAdmin ? (
                <WorkspaceApproveButton
                  tenantId={session.effectiveTenantId}
                  action={item.approval.action}
                  requestId={item.approval.requestId}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Approving requires an admin — ask an admin on your team to approve this request.
                </p>
              ))}
          </CardContent>
        </Card>

        <WorkspaceAssistPanel type={item.type} id={item.id} />
      </div>
    </div>
  );
}
