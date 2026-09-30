\set ON_ERROR_STOP on
set request.jwt.sub = 'aaaaaaaa-0000-0000-0000-000000000000';
\set V '11111111-0000-0000-0000-000000000000'
\set MAC '22222222-0000-0000-0000-000000000000'
\set IPH '33333333-0000-0000-0000-000000000000'
-- 1. Mac acquires, releases, then a late heartbeat arrives: must be lost/released, not reactivated
select (vault_session_acquire(:'V',:'MAC','44444444-0000-0000-0000-000000000001','MacBook','macos','0.19','Vault.conduit',null,'icloud/Vaults',false)->>'lease_id') as lease \gset mac_
select vault_session_release(:'V',:'MAC',:'mac_lease','{"1":[1,0]}'::jsonb,false);
select 'late heartbeat' t, vault_session_heartbeat(:'V',:'MAC',:'mac_lease',true)->>'status' s, (select status from personal_vault_sessions where device_id=:'MAC') row_status;
-- 2. iPhone acquires: granted because Mac released
select 'iphone acquire' t, vault_session_acquire(:'V',:'IPH','44444444-0000-0000-0000-000000000002','iPhone','ios','1.1','Vault.conduit',null,'icloud/Vaults',false)->>'granted' g;
-- 3. Mac re-acquires without takeover: denied (Free)
select 'mac acquire' t, vault_session_acquire(:'V',:'MAC','44444444-0000-0000-0000-000000000003','MacBook','macos','0.19','Vault.conduit',null,'icloud/Vaults',false)->>'granted' g;
-- 4. Mac takes over: iPhone displaced
select (vault_session_acquire(:'V',:'MAC','44444444-0000-0000-0000-000000000003','MacBook','macos','0.19','Vault.conduit',null,'icloud/Vaults',true)->>'lease_id') as lease \gset mac2_
select 'iphone status' t, status, displaced_reason from personal_vault_sessions where device_id=:'IPH';
-- 5. A clone of the Mac (same device id, other nonce) acquires: supersedes; old lease heartbeat -> lost/superseded
select (vault_session_acquire(:'V',:'MAC','44444444-0000-0000-0000-000000000009','MacBook','macos','0.19','Vault.conduit',null,'icloud/Vaults',false)->>'lease_id') as lease \gset clone_
select 'old mac heartbeat' t, vault_session_heartbeat(:'V',:'MAC',:'mac2_lease',true)->>'reason' r;
select 'clone heartbeat' t, vault_session_heartbeat(:'V',:'MAC',:'clone_lease',true,'{"sessions":2}'::jsonb)->>'status' s;
-- 6. Pro with two devices, then downgrade: busy device kept
update user_profiles set tier_id='00000000-0000-0000-0000-0000000000a0';
select (vault_session_acquire(:'V',:'IPH','44444444-0000-0000-0000-000000000005','iPhone','ios','1.1','Vault.conduit',null,'icloud/Vaults',false)->>'lease_id') as lease \gset iph2_
select 'pro both active' t, count(*) from personal_vault_sessions where status='active';
update user_profiles set tier_id='00000000-0000-0000-0000-00000000000f';
select 'downgrade: iphone hb' t, vault_session_heartbeat(:'V',:'IPH',:'iph2_lease',true)::text;
select 'after downgrade' t, device_name, status, displaced_reason from personal_vault_sessions order by device_name;
-- 7. Abandon and peek
select vault_session_abandon(:'V',:'MAC',:'IPH');
select 'abandoned' t, abandoned_at is not null from personal_vault_sessions where device_id=:'IPH';
select 'peek' t, vault_session_peek(:'V',:'IPH')::text;
-- 8. Oversize busy json is rejected as an error (client treats as unconfirmed)
\set ON_ERROR_STOP off
select vault_session_heartbeat(:'V',:'MAC',:'clone_lease',true, jsonb_build_object('sessions', repeat('x',400)));
\set ON_ERROR_STOP off
-- 9. Guard trigger: authenticated cannot change tier_id; display_name still works
set role authenticated;
grant update on public.user_profiles to authenticated;
