export interface TriageResult {
  product: string;
  type: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  summary: string;
  suggested_reply: string;
}
