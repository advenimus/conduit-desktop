grant usage on schema public to authenticated;
grant select, update on public.user_profiles to authenticated;
set role authenticated;
update public.user_profiles set display_name = 'Chris' where id = 'aaaaaaaa-0000-0000-0000-000000000000';
update public.user_profiles set tier_id = '00000000-0000-0000-0000-0000000000a0' where id = 'aaaaaaaa-0000-0000-0000-000000000000';
update public.user_profiles set stripe_customer_id = 'cus_1' where id = 'aaaaaaaa-0000-0000-0000-000000000000';
update public.user_profiles set stripe_customer_id = 'cus_2' where id = 'aaaaaaaa-0000-0000-0000-000000000000';
reset role;
select display_name, stripe_customer_id, tier_id from public.user_profiles;
