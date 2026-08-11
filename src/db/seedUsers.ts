import 'dotenv/config';
import { supabase } from '../config/supabase';
import { hashPassword } from '../utils/crypto';

const USERS = [
  { label: 'Super admin', password: 'Admin@123456', username: 'superadmin', email: 'admin@xfamebet.com', phone: '+233200000001', country: 'GH', referral_code: 'ADMIN001', role: 'super_admin' },
  { label: 'Fraud analyst', password: 'Analyst@123456', username: 'fraud_analyst1', email: 'fraud@xfamebet.com', phone: '+233200000002', country: 'GH', referral_code: 'FRAUD001', role: 'fraud_analyst' },
  { label: 'Ghana test user', password: 'User@123456', username: 'testuser1', email: 'user@xfamebet.com', phone: '+233200000003', country: 'GH', referral_code: 'USER001', role: 'user' },
  { label: 'Nigeria test user', password: 'Nigeria@123456', username: 'ng_test_user', email: 'nigeria.test@xfamebet.com', phone: '+2348012345678', country: 'NG', referral_code: 'NGTEST01', role: 'user' },
] as const;

async function seedUsers() {
  for (const user of USERS) {
    const password_hash = await hashPassword(user.password);
    const { label, password: _password, ...record } = user;
    const { error } = await supabase.from('users').upsert({
      ...record, password_hash, kyc_status: 'approved', account_status: 'active', email_verified: true, phone_verified: true,
    }, { onConflict: 'email' });
    if (error) throw new Error(`${label}: ${error.message}`);
    console.log(`Seeded ${label}: ${user.email}`);
  }
}

seedUsers().catch((error) => { console.error(error); process.exitCode = 1; });
