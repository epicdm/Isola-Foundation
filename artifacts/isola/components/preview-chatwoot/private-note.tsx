"use client";

import { Lock } from "lucide-react";

import type { ConversationDetail } from "./types";

export function PrivateNote({ note }: { note: ConversationDetail["privateNote"] }) {
  const [before, after] = note.text.split(note.mention);

  return (
    <div className="border-t bg-warning/5 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
        <Lock className="size-3" />
        Private note — not sent to customer
      </div>
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
        <p className="mb-1 text-xs font-medium text-muted-foreground">{note.author}</p>
        <p>
          {before}
          <span className="rounded bg-warning/30 px-1 font-medium text-amber-800 dark:text-amber-300">
            {note.mention}
          </span>
          {after}
        </p>
      </div>
    </div>
  );
}
