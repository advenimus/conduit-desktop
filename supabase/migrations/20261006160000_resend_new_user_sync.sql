-- Adds each new user to the "Conduit Desktop Users" Resend segment.
-- The Resend key lives in Vault as `resend_contacts_api_key`, created outside this file.
-- Without that secret the sync quietly does nothing, so local and preview stacks are unaffected.

create or replace function public.sync_email_to_resend(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_email is null or p_email = '' then
    return;
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'resend_contacts_api_key';

  if v_key is null then
    return;
  end if;

  perform net.http_post(
    url := 'https://api.resend.com/contacts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object(
      'email', lower(p_email),
      'segments', jsonb_build_array(
        jsonb_build_object('id', '202ffb59-95bd-4448-af25-4e54fb6a9347')
      )
    )
  );
end;
$$;

create or replace function public.trg_sync_new_user_to_resend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = new.id;
  perform public.sync_email_to_resend(v_email);
  return new;
exception when others then
  -- A mailing-list hiccup must never block a signup.
  raise warning 'resend contact sync failed: %', sqlerrm;
  return new;
end;
$$;

revoke all on function public.sync_email_to_resend(text) from public, anon, authenticated;
revoke all on function public.trg_sync_new_user_to_resend() from public, anon, authenticated;

drop trigger if exists sync_new_user_to_resend on public.user_profiles;
create trigger sync_new_user_to_resend
  after insert on public.user_profiles
  for each row execute function public.trg_sync_new_user_to_resend();
