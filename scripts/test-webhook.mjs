// Standalone test — mirrors exact webhook logic without Next.js
// Run with: node scripts/test-webhook.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env.local manually
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => l.split('=').map((v, i) => i === 0 ? v.trim() : l.slice(l.indexOf('=') + 1).trim()))
);

const supabase = createClient(
  env['NEXT_PUBLIC_SUPABASE_URL'],
  env['SUPABASE_SERVICE_ROLE_KEY']
);

// Simulated inbound payload
const data = {
  to: ['support@goasap.ai'],
  from: 'testcustomer@gmail.com',
  from_name: 'Test Customer',
  subject: 'Help! I cannot log in',
  text: 'Hi, I have been trying to log in for the past hour. Please help!',
  html: '<p>Hi, I have been trying to log in for the past hour. Please help!</p>',
};

console.log('=== Step 1: Resolve tenant by domain ===');
const targetDomain = data.to[0].split('@')[1];
console.log('Domain:', targetDomain);

const { data: tenant, error: tenantError } = await supabase
  .from('tenants')
  .select('*')
  .eq('domain', targetDomain)
  .single();

if (tenantError || !tenant) {
  console.error('TENANT ERROR:', tenantError?.message ?? 'not found');
  process.exit(1);
}
console.log('✅ Tenant found:', tenant.name, '|', tenant.id);

console.log('\n=== Step 2: Find or create conversation ===');
const { data: existing } = await supabase
  .from('conversations')
  .select('*')
  .eq('tenant_id', tenant.id)
  .eq('customer_email', data.from)
  .eq('status', 'open')
  .maybeSingle();

let conversation = existing;
if (existing) {
  console.log('✅ Existing conversation found:', existing.id);
} else {
  const { data: newConvo, error: convoError } = await supabase
    .from('conversations')
    .insert({
      tenant_id: tenant.id,
      customer_email: data.from,
      customer_name: data.from_name || null,
      subject: data.subject || '(No Subject)',
    })
    .select('*')
    .single();

  if (convoError || !newConvo) {
    console.error('CONVERSATION ERROR:', convoError?.message ?? 'unknown');
    process.exit(1);
  }
  conversation = newConvo;
  console.log('✅ New conversation created:', conversation.id);
}

console.log('\n=== Step 3: Log inbound message ===');
const { error: msgError } = await supabase
  .from('inbound_messages')
  .insert({
    conversation_id: conversation.id,
    tenant_id: tenant.id,
    from_email: data.from,
    subject: data.subject || '(No Subject)',
    body_text: data.text || '',
    body_html: data.html || null,
  });

if (msgError) {
  console.error('MESSAGE ERROR:', msgError.message);
  process.exit(1);
}
console.log('✅ Inbound message logged!');

console.log('\n=== Verification: Check what was created ===');
const { data: convos } = await supabase
  .from('conversations')
  .select('id, customer_email, subject, status')
  .eq('tenant_id', tenant.id);

const { data: msgs } = await supabase
  .from('inbound_messages')
  .select('id, from_email, subject, created_at')
  .eq('tenant_id', tenant.id);

console.log('Conversations:', JSON.stringify(convos, null, 2));
console.log('Messages:', JSON.stringify(msgs, null, 2));
console.log('\n🎉 ALL STEPS PASSED — engine is working!');
