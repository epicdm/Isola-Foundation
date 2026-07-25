"use client";

import { MessageSquare, Phone } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ChannelIcon } from "./channel-icon";
import { Customer360Panel } from "./customer-360-panel";
import { HermesPanel } from "./hermes-panel";
import type { ConversationDetail } from "./types";

export function ContactSidebar({
  detail,
  onCopyToComposer,
}: {
  detail: ConversationDetail;
  onCopyToComposer: (text: string) => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 border-b p-3">
        <div className="flex items-center gap-2.5">
          <Avatar className="size-10">
            <AvatarFallback className="bg-primary/10 text-sm font-semibold text-primary">
              {detail.summary.initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{detail.summary.contactName}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Phone className="size-3" />
              {detail.contactPhone}
            </p>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ChannelIcon channel={detail.summary.channel} className="size-3.5" />
            {detail.summary.channel === "whatsapp"
              ? "WhatsApp"
              : detail.summary.channel === "voice"
                ? "Voice"
                : "Web widget"}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="size-3.5" />
            {detail.conversationHistoryCount} past conversations
          </span>
        </div>
      </div>

      <Tabs defaultValue="360" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b px-3 pt-2">
          <TabsList className="h-8 w-full">
            <TabsTrigger value="360" className="flex-1 text-xs">
              Customer 360
            </TabsTrigger>
            <TabsTrigger value="hermes" className="flex-1 text-xs">
              Hermes assist
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="360" className="mt-0 min-h-0 flex-1">
          <ScrollArea className="h-full">
            <Customer360Panel data={detail.customer360} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="hermes" className="mt-0 min-h-0 flex-1">
          <ScrollArea className="h-full">
            <HermesPanel data={detail.hermes} onCopyToComposer={onCopyToComposer} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
