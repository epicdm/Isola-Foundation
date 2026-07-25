import { MessagesSquare } from "lucide-react";

import { ChatwootIconRail } from "@/components/preview-chatwoot/icon-rail";
import { ConversationList } from "@/components/preview-chatwoot/conversation-list";

export default function ChatwootConversationListPage() {
  return (
    <div className="flex h-full min-h-0 flex-1">
      <ChatwootIconRail />

      <div className="flex w-full flex-col md:w-80 md:shrink-0 md:border-r">
        <ConversationList />
      </div>

      <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground md:flex">
        <MessagesSquare className="size-8 opacity-40" />
        <p className="text-sm">Select a conversation to view the thread, contact panel, and Hermes assist.</p>
      </div>
    </div>
  );
}
