-- Rollback of 20260929150100_app_config_min_version. Run the 20260929150200 rollback first: the
-- lease RPCs of that migration call these functions.

drop function if exists public.app_config_int(text, int);
drop function if exists public.app_version_ok(text, text);
drop function if exists public.app_any_min_set();
drop function if exists public.app_min_version(text);
drop function if exists public.app_platform_group(text);
drop function if exists public.version_parts(text);
drop table if exists public.app_config;
