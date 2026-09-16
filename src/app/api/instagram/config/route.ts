import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { data, error } = await supabase
      .from('instagram_config')
      .select('page_id, ig_user_id, ig_username, status, connected_at')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[instagram/config GET] fetch failed:', error);
      return NextResponse.json({ connected: false }, { status: 200 });
    }
    if (!data) {
      return NextResponse.json({ connected: false }, { status: 200 });
    }
    return NextResponse.json({ connected: data.status === 'connected', config: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = await request.json();
    const { page_id, ig_user_id, ig_username, page_access_token } = body;

    if (!page_id || !ig_user_id || !page_access_token) {
      return NextResponse.json(
        { error: 'page_id, ig_user_id e page_access_token são obrigatórios' },
        { status: 400 },
      );
    }

    // Verify the token actually works against this ig_user_id before
    // saving — catches a pasted Page token that doesn't have messaging
    // permission, or the wrong ig_user_id, up front rather than at the
    // first real webhook delivery.
    const verifyRes = await fetch(
      `https://graph.facebook.com/v21.0/${ig_user_id}?fields=id&access_token=${encodeURIComponent(page_access_token)}`,
    );
    if (!verifyRes.ok) {
      const errBody = await verifyRes.json().catch(() => ({}));
      return NextResponse.json(
        {
          error:
            errBody?.error?.message ??
            'Não foi possível verificar as credenciais com a Meta. Confira o ID da conta e o token.',
        },
        { status: 400 },
      );
    }

    // Reject if another account already claimed this ig_user_id —
    // mirrors the whatsapp_config phone_number_id check.
    const { data: claimed } = await supabaseAdmin()
      .from('instagram_config')
      .select('account_id')
      .eq('ig_user_id', ig_user_id)
      .neq('account_id', accountId)
      .maybeSingle();

    if (claimed) {
      return NextResponse.json(
        { error: 'Esta conta do Instagram já está vinculada a outra conta nesta instalação.' },
        { status: 409 },
      );
    }

    const { data: existing } = await supabase
      .from('instagram_config')
      .select('id, verify_token')
      .eq('account_id', accountId)
      .maybeSingle();

    const verifyToken = existing ? decrypt(existing.verify_token) : crypto.randomBytes(24).toString('hex');

    const row = {
      page_id,
      ig_user_id,
      ig_username: ig_username || null,
      page_access_token: encrypt(page_access_token),
      verify_token: encrypt(verifyToken),
      status: 'connected',
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error } = await supabase.from('instagram_config').update(row).eq('account_id', accountId);
      if (error) {
        console.error('[instagram/config POST] update failed:', error);
        return NextResponse.json({ error: 'Não foi possível atualizar a configuração' }, { status: 500 });
      }
    } else {
      const { error } = await supabase.from('instagram_config').insert({ account_id: accountId, ...row });
      if (error) {
        console.error('[instagram/config POST] insert failed:', error);
        return NextResponse.json({ error: 'Não foi possível salvar a configuração' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, verify_token: verifyToken });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { error } = await supabase.from('instagram_config').delete().eq('account_id', accountId);
    if (error) {
      console.error('[instagram/config DELETE] failed:', error);
      return NextResponse.json({ error: 'Não foi possível excluir a configuração' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
