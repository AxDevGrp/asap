// Chatwoot inbox ID → product mapping
// Inbox IDs confirmed from Chatwoot API: 1=STRK, 2=Cashpile, 3=TheDailyPost

export const INBOX_PRODUCT_MAP: Record<number, string> = {
  1: 'strk',
  2: 'cashpile',
  3: 'dailypost',
};

export const PRODUCT_NAMES: Record<string, string> = {
  strk: 'STRK',
  cashpile: 'Cashpile',
  dailypost: 'The Daily Post',
};

export function getProductFromInbox(inboxId: number): string {
  return INBOX_PRODUCT_MAP[inboxId] ?? 'unknown';
}

export function getProductName(product: string): string {
  return PRODUCT_NAMES[product] ?? 'Unknown Product';
}
