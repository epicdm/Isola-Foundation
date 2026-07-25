import { ShieldAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Shown to an authenticated user of this workspace who lacks the role.
 *
 * Deliberately says nothing about what the view contains — it confirms only
 * that access is role-based and names who to ask.
 */
export function WorkspaceAccessDenied({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Not available for your role</h1>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
          <ShieldAlert className="size-8 text-muted-foreground" />
          <div className="font-medium">{message}</div>
          <p className="max-w-prose text-sm text-muted-foreground">
            Ask a workspace owner to grant you access if you need it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
