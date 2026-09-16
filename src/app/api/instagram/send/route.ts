import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { sendInstagramMessage, InstagramSendError } from '@/lib/instagram/send-message';

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`instagram-send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { conversation_id, content_type, content_text, media_url, reply_to_message_id } = body;

    if (!conversation_id || !content_type) {
      return NextResponse.json(
        { error: 'conversation_id e content_type são obrigatórios' },
        { status: 400 },
      );
    }

    try {
      const result = await sendInstagramMessage(supabase, accountId, {
        conversationId: conversation_id,
        contentType: content_type,
        contentText: content_text,
        mediaUrl: media_url,
        replyToMessageId: reply_to_message_id,
      });
      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        ig_message_id: result.igMessageId,
      });
    } catch (err) {
      if (err instanceof InstagramSendError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in Instagram send POST:', error);
    return toErrorResponse(error);
  }
}
