import { ConversationView } from "@/components/preview-chatwoot/conversation-view";
import { getConversationDetail } from "@/components/preview-chatwoot/mock-data";

export default async function ChatwootConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  // getConversationDetail falls back to the first mock conversation for any
  // unrecognized id, so this route always renders in the preview.
  const detail = getConversationDetail(conversationId);

  return <ConversationView detail={detail} />;
}
