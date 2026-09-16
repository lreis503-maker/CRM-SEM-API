import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Lazy, shared service-role client for WhatsApp provider operations.
// Mirrors src/lib/flows/admin-client.ts — same shape so anyone reading
// either file picks up the convention immediately.
//
// Required here (rather than the caller's RLS-scoped client) because
// `whatsapp_config_secrets` deliberately has no browser policies: the
// encrypted UAZAPI instance token must be unreachable from a session.
let _adminClient: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}
