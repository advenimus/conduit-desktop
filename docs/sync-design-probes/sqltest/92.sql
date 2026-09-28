
create or replace function public.guard_user_profile_columns() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.tier_id is distinct from old.tier_id
    or new.is_team_member is distinct from old.is_team_member
    or new.subscription_status is distinct from old.subscription_status
    or new.subscription_period_end is distinct from old.subscription_period_end
    or new.cancel_at_period_end is distinct from old.cancel_at_period_end
    or new.trial_ends_at is distinct from old.trial_ends_at
    or new.has_used_trial is distinct from old.has_used_trial
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or (new.stripe_customer_id is distinct from old.stripe_customer_id and old.stripe_customer_id is not null)
    or new.abuse_score is distinct from old.abuse_score
    or new.is_suspended is distinct from old.is_suspended
    or new.suspended_reason is distinct from old.suspended_reason
    or new.registration_ip is distinct from old.registration_ip
    or new.registration_fingerprint is distinct from old.registration_fingerprint) then
    raise exception 'protected column' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_user_profile_columns on public.user_profiles;
create trigger trg_guard_user_profile_columns before update on public.user_profiles
  for each row execute function public.guard_user_profile_columns();
