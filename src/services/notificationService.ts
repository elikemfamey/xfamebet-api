import { supabase } from '../config/supabase';
import { NotificationType } from '../types';
import { getIO } from '../socket';

export class NotificationService {
  static async send(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>
  ) {
    const { data: notification } = await supabase.from('notifications').insert({
      user_id: userId, type, title, message, data,
    }).select().single();

    // Push via Socket.IO
    try {
      const io = getIO();
      io.to(`user:${userId}`).emit('notification', notification);
    } catch {}

    return notification;
  }

  static async markRead(userId: string, notificationId: string) {
    await supabase.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('user_id', userId);
  }

  static async markAllRead(userId: string) {
    await supabase.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null);
  }

  static async getUnread(userId: string) {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .limit(50);
    return data ?? [];
  }
}
