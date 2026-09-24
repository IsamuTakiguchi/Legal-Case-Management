/**
 * 会話の中の 1 通を開く画面の行き先。
 * 会話画面はそのメッセージまで動かして光らせる（`?message=` が無ければ最新・未読の先頭を出す）。
 */
export function messageLink(conversationId: number, messageId?: number | null): string {
  return messageId ? `/inbox/${conversationId}?message=${messageId}` : `/inbox/${conversationId}`;
}
