import { supabase } from '../config/supabase';

export const GLOBAL_PLATFORM_CONTROLS_ID = '00000000-0000-0000-0000-000000000001';
export const WITHDRAWAL_REQUIREMENT_MIGRATION_REQUIRED = 'WITHDRAWAL_REQUIREMENT_MIGRATION_REQUIRED';

export type WithdrawalDepositRequirementControl = {
  enabled: boolean;
  updated_by: string | null;
  updated_at: string;
};

function isMissingControlSchema(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (
    error.code === '42P01'
    || error.code === 'PGRST205'
    || error.message?.includes("Could not find the table 'public.platform_controls'")
    || error.message?.includes('relation "platform_controls" does not exist')
    || error.message?.includes('withdrawal_deposit_requirement_enabled')
  ));
}

export async function getWithdrawalDepositRequirement(): Promise<WithdrawalDepositRequirementControl> {
  const { data, error } = await supabase
    .from('platform_controls')
    .select('withdrawal_deposit_requirement_enabled, updated_by, updated_at')
    .eq('id', GLOBAL_PLATFORM_CONTROLS_ID)
    .single();

  if (error || !data) {
    if (!error || isMissingControlSchema(error)) {
      return { enabled: true, updated_by: null, updated_at: '' };
    }
    throw new Error(error.message);
  }

  const control: WithdrawalDepositRequirementControl = {
    enabled: Boolean(data.withdrawal_deposit_requirement_enabled),
    updated_by: data.updated_by ?? null,
    updated_at: data.updated_at,
  };
  return control;
}

export async function setWithdrawalDepositRequirement(input: {
  enabled: boolean;
  adminId: string;
}): Promise<WithdrawalDepositRequirementControl> {
  const next: WithdrawalDepositRequirementControl = {
    enabled: input.enabled,
    updated_by: input.adminId,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('platform_controls')
    .upsert({
      id: GLOBAL_PLATFORM_CONTROLS_ID,
      withdrawal_deposit_requirement_enabled: input.enabled,
      updated_by: input.adminId,
      updated_at: next.updated_at,
    }, { onConflict: 'id' })
    .select('withdrawal_deposit_requirement_enabled, updated_by, updated_at')
    .single();

  if (error) {
    if (isMissingControlSchema(error)) throw new Error(WITHDRAWAL_REQUIREMENT_MIGRATION_REQUIRED);
    throw new Error(error.message);
  }
  const stored: WithdrawalDepositRequirementControl = data ? {
    enabled: Boolean(data.withdrawal_deposit_requirement_enabled),
    updated_by: data.updated_by ?? null,
    updated_at: data.updated_at,
  } : next;

  return stored;
}
