export interface ChatwootSender {
  id: number;
  name: string;
  email: string;
  type: 'user' | 'contact';
}

export interface ChatwootConversation {
  id: number;
  inbox_id: number;
  status: 'open' | 'resolved' | 'pending';
  agent_last_seen_at: string | null;
  contact_last_seen_at: string | null;
  timestamp: number;
}

export interface ChatwootMessage {
  id: number;
  content: string;
  message_type: 'incoming' | 'outgoing';
  created_at: string;
  private: boolean;
  sender: ChatwootSender;
  conversation: ChatwootConversation;
}

export interface ChatwootWebhookPayload {
  event: 'conversation_created' | 'conversation_status_changed' | 'message_created';
  id: number;
  inbox_id: number;
  contact: {
    id: number;
    name: string;
    email: string;
    phone_number: string | null;
  };
  conversation: ChatwootConversation;
  messages?: ChatwootMessage[];
}

export interface TriageResult {
  product: string;
  type: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  summary: string;
}
