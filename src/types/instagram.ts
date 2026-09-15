export type InstagramConnectionStatus = 'connected' | 'disconnected';

export interface InstagramConfig {
  id: string;
  account_id: string;
  page_id: string;
  ig_user_id: string;
  ig_username?: string | null;
  status: InstagramConnectionStatus;
  connected_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstagramContact {
  id: string;
  account_id: string;
  igsid: string;
  username?: string | null;
  name?: string | null;
  profile_pic_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstagramConversation {
  id: string;
  account_id: string;
  contact_id: string;
  last_message_text?: string | null;
  last_message_at?: string | null;
  last_customer_message_at?: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact?: InstagramContact;
}

export type InstagramSenderType = 'customer' | 'agent';
export type InstagramContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'share'
  | 'story_mention'
  | 'story_reply'
  | 'unsupported';
export type InstagramMessageStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export interface InstagramMessage {
  id: string;
  conversation_id: string;
  sender_type: InstagramSenderType;
  sender_id?: string | null;
  content_type: InstagramContentType;
  content_text?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  ig_message_id?: string | null;
  reply_to_message_id?: string | null;
  status: InstagramMessageStatus;
  error_message?: string | null;
  created_at: string;
}
