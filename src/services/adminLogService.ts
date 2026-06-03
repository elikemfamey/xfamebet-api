import { supabase } from '../config/supabase';

export class AdminLogService {
  static async log(
    adminId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: Record<string, unknown>
  ) {
    await supabase.from('admin_logs').insert({
      admin_id: adminId, action, entity_type: entityType, entity_id: entityId, metadata,
    });
  }
}
