-- Ksiapulo Tracker — część społecznościowa (Supabase / Postgres).
-- Uruchom całość w Supabase: SQL Editor → New query → wklej → Run. Można uruchamiać ponownie.
--
-- Zasada: klient tylko CZYTA tabele. Wszystko, co daje punkty albo zmienia cudze dane, idzie
-- przez funkcje (RPC) z kontrolą po stronie serwera, więc nie da się dopisać sobie punktów z konsoli.


-- ---------------------------------------------------------------- tabele

create table if not exists public.places (
  id text primary key,                 -- ten sam klucz co na stronie: "nazwa--miasto"
  name text not null,
  city text,
  lat double precision not null,
  lng double precision not null,
  approx boolean not null default false,
  category text,
  muala boolean not null default false,
  closed boolean not null default false,
  video_ids text[] not null default '{}',
  video_dates timestamptz[] not null default '{}'
);

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name text not null check (char_length(display_name) between 2 and 30),
  home_city text not null check (char_length(home_city) between 2 and 60),
  home_lat double precision not null,
  home_lng double precision not null,
  points int not null default 0,
  referred_by uuid references public.profiles(id) on delete set null,
  is_admin boolean not null default false,
  banned boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  place_id text not null references public.places on delete cascade,
  created_at timestamptz not null default now(),
  lat double precision not null,
  lng double precision not null,
  accuracy real,
  distance_m real,
  photo_path text not null,
  photo_hash text,
  status text not null default 'ok' check (status in ('ok', 'review', 'rejected')),
  flags text[] not null default '{}',
  ai_note text,
  unique (user_id, place_id)
);
create index if not exists checkins_created on public.checkins (created_at desc);
create index if not exists checkins_hash on public.checkins (photo_hash);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  place_id text not null references public.places on delete cascade,
  path text not null,
  poster_path text,
  caption text not null default '' check (char_length(caption) <= 300),
  duration real check (duration <= 61),
  status text not null default 'visible' check (status in ('visible', 'hidden', 'removed')),
  reports int not null default 0,
  ai_note text,
  created_at timestamptz not null default now()
);
create index if not exists videos_created on public.videos (created_at desc);

create table if not exists public.reports (
  video_id uuid references public.videos on delete cascade,
  user_id uuid references public.profiles on delete cascade,
  reason text not null default '' check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);

create table if not exists public.reactions (
  user_id uuid references public.profiles on delete cascade,
  kind text check (kind in ('checkin', 'video')),
  target uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, target)
);

create table if not exists public.follows (
  follower uuid references public.profiles on delete cascade,
  followee uuid references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);

-- Dziennik punktów: każda nagroda jest wpisem z unikalnym (kto, za co, czego dotyczy),
-- więc tej samej nagrody nie da się dostać dwa razy.
create table if not exists public.point_events (
  id bigserial primary key,
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null,
  ref text not null default '',
  points int not null,
  created_at timestamptz not null default now(),
  unique (user_id, kind, ref)
);
create index if not exists point_events_week on public.point_events (created_at);

-- ---------------------------------------------------------------- pomocnicze

create or replace function public.km(a_lat float8, a_lng float8, b_lat float8, b_lng float8)
returns float8 language sql immutable as $$
  select 2 * 6371 * asin(least(1, sqrt(power(sin(radians(b_lat - a_lat) / 2), 2)
    + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2))))
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_admin)
$$;

-- ---------------------------------------------------------------- odczyt (RLS)

alter table public.places enable row level security;
alter table public.profiles enable row level security;
alter table public.checkins enable row level security;
alter table public.videos enable row level security;
alter table public.reports enable row level security;
alter table public.reactions enable row level security;
alter table public.follows enable row level security;
alter table public.point_events enable row level security;

drop policy if exists "places czyta każdy" on public.places;
create policy "places czyta każdy" on public.places for select using (true);
drop policy if exists "profile czyta każdy" on public.profiles;
create policy "profile czyta każdy" on public.profiles for select using (true);
drop policy if exists "odhaczenia: widoczne ok, własne zawsze" on public.checkins;
create policy "odhaczenia: widoczne ok, własne zawsze" on public.checkins for select
  using (status = 'ok' or user_id = auth.uid() or public.is_admin());
drop policy if exists "filmiki: widoczne, własne zawsze" on public.videos;
create policy "filmiki: widoczne, własne zawsze" on public.videos for select
  using (status = 'visible' or user_id = auth.uid() or public.is_admin());
drop policy if exists "reakcje czyta każdy" on public.reactions;
create policy "reakcje czyta każdy" on public.reactions for select using (true);
drop policy if exists "obserwowanie czyta każdy" on public.follows;
create policy "obserwowanie czyta każdy" on public.follows for select using (true);
drop policy if exists "własne punkty" on public.point_events;
create policy "własne punkty" on public.point_events for select using (user_id = auth.uid());
drop policy if exists "zgłoszenia widzi admin" on public.reports;
create policy "zgłoszenia widzi admin" on public.reports for select using (public.is_admin());

-- ---------------------------------------------------------------- funkcje (RPC)

-- Lista "do odhaczenia" zależy tylko od miasta domowego: promień rośnie, aż w okolicy będzie
-- co najmniej 12 lokali. Ten sam algorytm jest w assets/social.js — muszą zostać zgodne.
create or replace function public.local_radius(p_lat float8, p_lng float8)
returns int language sql stable set search_path = public as $$
  select coalesce(
    (select r from unnest(array[15, 25, 40, 60, 90, 150]) r
      where (select count(*) from places where not closed and km(p_lat, p_lng, lat, lng) <= r) >= 12
      order by r limit 1),
    150)
$$;

-- Wewnętrzne: przyznaj punkty raz. Zwraca true, jeśli to nowa nagroda.
create or replace function public.award(p_user uuid, p_kind text, p_ref text, p_points int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into point_events (user_id, kind, ref, points) values (p_user, p_kind, p_ref, p_points)
  on conflict do nothing;
  if found then
    update profiles set points = points + p_points where id = p_user;
    return true;
  end if;
  return false;
end $$;

-- Wewnętrzne: sprawdź wszystkie odznaki i przyznaj nowe. Zwraca kody nowo zdobytych.
create or replace function public.evaluate_badges(p_user uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  got text[] := '{}';
  pr profiles;
  n int;
  r int;
  total int;
  done int;
  procedure_ok boolean;
begin
  select * into pr from profiles where id = p_user;
  if not found then return got; end if;

  select count(*) into n from checkins where user_id = p_user and status = 'ok';
  if n >= 1 then if award(p_user, 'odznaka', 'pierwszy_kes', 20) then got := array_append(got, 'pierwszy_kes'); end if; end if;
  if n >= 10 then if award(p_user, 'odznaka', 'dziesiatka', 60) then got := array_append(got, 'dziesiatka'); end if; end if;
  if n >= 50 then if award(p_user, 'odznaka', 'piecdziesiatka', 200) then got := array_append(got, 'piecdziesiatka'); end if; end if;

  select count(*) into n from checkins c join places p on p.id = c.place_id
    where c.user_id = p_user and c.status = 'ok' and p.category = 'kebab';
  if n >= 5 then if award(p_user, 'odznaka', 'kebabiarz', 40) then got := array_append(got, 'kebabiarz'); end if; end if;

  select count(*) into n from checkins c join places p on p.id = c.place_id
    where c.user_id = p_user and c.status = 'ok' and p.muala;
  if n >= 3 then if award(p_user, 'odznaka', 'lowca_muala', 60) then got := array_append(got, 'lowca_muala'); end if; end if;
  if n >= 10 then if award(p_user, 'odznaka', 'kolekcjoner_muala', 150) then got := array_append(got, 'kolekcjoner_muala'); end if; end if;

  select count(distinct p.city) into n from checkins c join places p on p.id = c.place_id
    where c.user_id = p_user and c.status = 'ok';
  if n >= 5 then if award(p_user, 'odznaka', 'podroznik', 80) then got := array_append(got, 'podroznik'); end if; end if;

  select coalesce(max(cnt), 0) into n from (
    select count(*) cnt from checkins where user_id = p_user and status = 'ok'
    group by (created_at at time zone 'Europe/Warsaw')::date) d;
  if n >= 3 then if award(p_user, 'odznaka', 'maraton', 50) then got := array_append(got, 'maraton'); end if; end if;

  if exists (select 1 from checkins where user_id = p_user and status = 'ok'
             and (extract(hour from created_at at time zone 'Europe/Warsaw') >= 22
                  or extract(hour from created_at at time zone 'Europe/Warsaw') < 4)) then
    if award(p_user, 'odznaka', 'nocny_glod', 20) then got := array_append(got, 'nocny_glod'); end if;
  end if;

  if exists (select 1 from checkins c join places p on p.id = c.place_id
             where c.user_id = p_user and c.status = 'ok'
             and exists (select 1 from unnest(p.video_dates) d where c.created_at between d and d + interval '7 days')) then
    if award(p_user, 'odznaka', 'swiezak', 40) then got := array_append(got, 'swiezak'); end if;
  end if;

  -- lista z okolicy domu
  r := local_radius(pr.home_lat, pr.home_lng);
  select count(*) into total from places where not closed and km(pr.home_lat, pr.home_lng, lat, lng) <= r;
  select count(*) into done from checkins c join places p on p.id = c.place_id
    where c.user_id = p_user and c.status = 'ok' and not p.closed and km(pr.home_lat, pr.home_lng, p.lat, p.lng) <= r;
  if total > 0 and done * 4 >= total then
    if award(p_user, 'odznaka', 'lokalny_25', 60) then got := array_append(got, 'lokalny_25'); end if;
  end if;
  if total > 0 and done >= total then
    if award(p_user, 'odznaka', 'lokalny_100', 250) then got := array_append(got, 'lokalny_100'); end if;
  end if;

  -- cała trasa jednego odcinka (co najmniej 3 lokale)
  procedure_ok := exists (
    select 1 from (
      select v, count(*) total, count(c.id) done
      from places p cross join unnest(p.video_ids) v
      left join checkins c on c.place_id = p.id and c.user_id = p_user and c.status = 'ok'
      group by v) e
    where e.total >= 3 and e.done = e.total);
  if procedure_ok then
    if award(p_user, 'odznaka', 'trasa_odcinka', 100) then got := array_append(got, 'trasa_odcinka'); end if;
  end if;

  if exists (select 1 from videos where user_id = p_user and status <> 'removed') then
    if award(p_user, 'odznaka', 'recenzent', 30) then got := array_append(got, 'recenzent'); end if;
  end if;
  if exists (select 1 from videos v where v.user_id = p_user and v.status = 'visible'
             and (select count(*) from reactions x where x.kind = 'video' and x.target = v.id) >= 10) then
    if award(p_user, 'odznaka', 'ulubieniec', 80) then got := array_append(got, 'ulubieniec'); end if;
  end if;
  if exists (select 1 from profiles f where f.referred_by = p_user
             and exists (select 1 from checkins c where c.user_id = f.id and c.status = 'ok')) then
    if award(p_user, 'odznaka', 'influencer', 50) then got := array_append(got, 'influencer'); end if;
  end if;

  return got;
end $$;

-- Wewnętrzne: punkty za zaakceptowane odhaczenie.
create or replace function public.grant_checkin(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  c checkins;
  p places;
  pr profiles;
  pts int := 0;
begin
  select * into c from checkins where id = p_id and status = 'ok';
  if not found then return json_build_object('points', 0, 'badges', '{}'::text[]); end if;
  select * into p from places where id = c.place_id;
  if award(c.user_id, 'odhaczenie', c.place_id, 10) then pts := pts + 10; end if;
  if p.muala then
    if award(c.user_id, 'muala', c.place_id, 15) then pts := pts + 15; end if;
  end if;
  if not exists (select 1 from checkins x where x.place_id = c.place_id and x.status = 'ok'
                 and x.id <> c.id and x.created_at < c.created_at) then
    if award(c.user_id, 'pionier', c.place_id, 10) then pts := pts + 10; end if;
  end if;
  if exists (select 1 from unnest(p.video_dates) d where c.created_at between d and d + interval '7 days') then
    if award(c.user_id, 'swiezy', c.place_id, 10) then pts := pts + 10; end if;
  end if;
  select * into pr from profiles where id = c.user_id;
  if pr.referred_by is not null then
    perform award(pr.referred_by, 'polecenie_aktywne', c.user_id::text, 40);
    perform evaluate_badges(pr.referred_by);
  end if;
  return json_build_object('points', pts, 'badges', evaluate_badges(c.user_id));
end $$;

create or replace function public.current_profile()
returns profiles language plpgsql stable security definer set search_path = public as $$
declare pr profiles;
begin
  if auth.uid() is null then raise exception 'Zaloguj się'; end if;
  select * into pr from profiles where id = auth.uid();
  if not found then raise exception 'Najpierw dokończ profil'; end if;
  if pr.banned then raise exception 'Konto zablokowane za łamanie zasad'; end if;
  return pr;
end $$;

-- Odhaczenie lokalu: GPS + zdjęcie zrobione na miejscu.
create or replace function public.check_in(p_place text, p_lat float8, p_lng float8, p_accuracy real,
                                           p_photo text, p_hash text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  pr profiles := current_profile();
  p places;
  last checkins;
  d float8;
  max_d float8;
  fl text[] := '{}';
  st text := 'ok';
  cid uuid;
  res json;
  hours float8;
begin
  select * into p from places where id = p_place;
  if not found then raise exception 'Nie ma takiego lokalu'; end if;
  if p.closed then raise exception 'Ten lokal jest zamknięty'; end if;
  if p_photo is null or split_part(p_photo, '/', 1) <> pr.id::text
     or not exists (select 1 from storage.objects where bucket_id = 'checkins' and name = p_photo) then
    raise exception 'Brak zdjęcia z lokalu';
  end if;

  d := km(p_lat, p_lng, p.lat, p.lng) * 1000;
  -- pinezka przybliżona stoi w środku miasta/dzielnicy, więc dopuszczamy większą odległość
  max_d := case when p.approx then 4000 else 250 + least(coalesce(p_accuracy, 0), 150) end;
  if d > max_d then
    raise exception 'Jesteś za daleko od lokalu (% m). Odhaczyć można tylko na miejscu.', round(d);
  end if;

  if coalesce(p_accuracy, 9999) > 300 then fl := array_append(fl, 'slaby_gps'); end if;
  select * into last from checkins where user_id = pr.id order by created_at desc limit 1;
  if found then
    hours := greatest(extract(epoch from now() - last.created_at) / 3600, 0.02);
    if km(last.lat, last.lng, p_lat, p_lng) / hours > 250 then fl := array_append(fl, 'niemozliwa_predkosc'); end if;
  end if;
  if (select count(*) from checkins where user_id = pr.id and created_at > now() - interval '24 hours') >= 10 then
    fl := array_append(fl, 'za_duzo_dziennie');
  end if;
  if p_hash is not null and exists (select 1 from checkins where photo_hash = p_hash) then
    fl := array_append(fl, 'powtorzone_zdjecie');
  end if;
  if array_length(fl, 1) > 0 then st := 'review'; end if;

  insert into checkins (user_id, place_id, lat, lng, accuracy, distance_m, photo_path, photo_hash, status, flags)
  values (pr.id, p_place, p_lat, p_lng, p_accuracy, d, p_photo, p_hash, st, fl)
  on conflict (user_id, place_id) do nothing
  returning id into cid;
  if cid is null then raise exception 'Ten lokal masz już odhaczony'; end if;

  if st = 'ok' then res := grant_checkin(cid); else res := json_build_object('points', 0, 'badges', '{}'::text[]); end if;
  return json_build_object('id', cid, 'status', st, 'flags', fl, 'distance', round(d),
                           'points', res->'points', 'badges', res->'badges');
end $$;

-- Filmik z opinią — tylko o lokalu, który masz odhaczony.
create or replace function public.post_video(p_place text, p_path text, p_poster text, p_caption text, p_duration real)
returns json language plpgsql security definer set search_path = public as $$
declare
  pr profiles := current_profile();
  vid uuid;
  pts int := 0;
begin
  if not exists (select 1 from checkins where user_id = pr.id and place_id = p_place and status <> 'rejected') then
    raise exception 'Najpierw odhacz ten lokal — opinię dodasz po wizycie';
  end if;
  if split_part(p_path, '/', 1) <> pr.id::text
     or not exists (select 1 from storage.objects where bucket_id = 'videos' and name = p_path) then
    raise exception 'Filmik nie dotarł, spróbuj jeszcze raz';
  end if;
  if (select count(*) from videos where user_id = pr.id and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'Limit: 5 filmików na dobę';
  end if;
  insert into videos (user_id, place_id, path, poster_path, caption, duration)
  values (pr.id, p_place, p_path, p_poster, left(coalesce(p_caption, ''), 300), p_duration)
  returning id into vid;
  if award(pr.id, 'opinia', p_place, 25) then pts := 25; end if;
  return json_build_object('id', vid, 'points', pts, 'badges', evaluate_badges(pr.id));
end $$;

-- Reakcja "MUALA" na odhaczenie albo filmik (jak kudosy). Autor dostaje punkty, z limitem.
create or replace function public.react(p_kind text, p_target uuid, p_on boolean)
returns int language plpgsql security definer set search_path = public as $$
declare
  pr profiles := current_profile();
  owner uuid;
begin
  if p_kind = 'video' then
    select user_id into owner from videos where id = p_target and status = 'visible';
  elsif p_kind = 'checkin' then
    select user_id into owner from checkins where id = p_target and status = 'ok';
  end if;
  if owner is null then raise exception 'Nie ma takiego wpisu'; end if;

  if p_on then
    insert into reactions (user_id, kind, target) values (pr.id, p_kind, p_target) on conflict do nothing;
    if found and owner <> pr.id then
      if p_kind = 'video' and (select count(*) from point_events where user_id = owner and kind = 'reakcja'
                               and ref like p_target::text || ':%') < 25 then
        perform award(owner, 'reakcja', p_target::text || ':' || pr.id::text, 2);
        perform evaluate_badges(owner);
      elsif p_kind = 'checkin' and (select count(*) from point_events where user_id = owner and kind = 'kudos'
                                    and ref like p_target::text || ':%') < 20 then
        perform award(owner, 'kudos', p_target::text || ':' || pr.id::text, 1);
      end if;
    end if;
  else
    delete from reactions where user_id = pr.id and kind = p_kind and target = p_target;
  end if;
  return (select count(*) from reactions where kind = p_kind and target = p_target);
end $$;

-- Zgłoszenie filmiku. Po 3 zgłoszeniach filmik znika do decyzji admina.
create or replace function public.report_video(p_video uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare pr profiles := current_profile();
begin
  insert into reports (video_id, user_id, reason) values (p_video, pr.id, left(coalesce(p_reason, ''), 200))
  on conflict do nothing;
  if found then
    update videos set reports = reports + 1,
      status = case when reports + 1 >= 3 and status = 'visible' then 'hidden' else status end
    where id = p_video;
  end if;
end $$;

create or replace function public.create_profile(p_username text, p_display text, p_city text,
                                                 p_lat float8, p_lng float8, p_ref text default null)
returns profiles language plpgsql security definer set search_path = public as $$
declare
  pr profiles;
  ref_id uuid;
begin
  if auth.uid() is null then raise exception 'Zaloguj się'; end if;
  if exists (select 1 from profiles where id = auth.uid()) then raise exception 'Profil już istnieje'; end if;
  if exists (select 1 from profiles where username = lower(p_username)) then raise exception 'Ta nazwa jest zajęta'; end if;
  select id into ref_id from profiles where username = lower(p_ref) and not banned;
  insert into profiles (id, username, display_name, home_city, home_lat, home_lng, referred_by)
  values (auth.uid(), lower(p_username), p_display, p_city, p_lat, p_lng, ref_id)
  returning * into pr;
  if ref_id is not null then perform award(ref_id, 'polecenie', pr.id::text, 20); end if;
  return pr;
end $$;

create or replace function public.update_profile(p_display text, p_city text, p_lat float8, p_lng float8)
returns profiles language plpgsql security definer set search_path = public as $$
declare pr profiles := current_profile();
begin
  update profiles set display_name = p_display, home_city = p_city, home_lat = p_lat, home_lng = p_lng
  where id = pr.id returning * into pr;
  perform evaluate_badges(pr.id);
  return pr;
end $$;

create or replace function public.follow(p_user uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare pr profiles := current_profile();
begin
  if p_on then
    insert into follows (follower, followee) values (pr.id, p_user) on conflict do nothing;
  else
    delete from follows where follower = pr.id and followee = p_user;
  end if;
end $$;

-- Ranking: p_scope = all | city | friends, p_period = all | week
create or replace function public.leaderboard(p_scope text default 'all', p_period text default 'all', p_limit int default 50)
returns table (user_id uuid, username text, display_name text, home_city text, points int, place int)
language sql stable security definer set search_path = public as $$
  with me as (select * from profiles where id = auth.uid()),
  base as (
    select pr.id, pr.username, pr.display_name, pr.home_city,
      case when p_period = 'week'
        then coalesce((select sum(e.points) from point_events e where e.user_id = pr.id and e.created_at > now() - interval '7 days'), 0)
        else pr.points end::int as pts
    from profiles pr
    where not pr.banned
      and (p_scope = 'all'
        or (p_scope = 'city' and pr.home_city = (select home_city from me))
        or (p_scope = 'friends' and (pr.id = auth.uid() or pr.id in (select followee from follows where follower = auth.uid()))))
  )
  select id, username, display_name, home_city, pts, (rank() over (order by pts desc))::int
  from base where pts > 0 or id = auth.uid()
  order by pts desc, username
  limit least(p_limit, 100)
$$;

-- Aktywność jak na Stravie: odhaczenia i filmiki. p_scope = all | city | friends
create or replace function public.feed(p_scope text default 'all', p_before timestamptz default now(), p_limit int default 20)
returns table (kind text, id uuid, created_at timestamptz, user_id uuid, username text, display_name text,
               place_id text, place_name text, place_city text, media_path text, poster_path text,
               caption text, reactions int, mine boolean)
language sql stable security definer set search_path = public as $$
  with me as (select * from profiles where id = auth.uid()),
  items as (
    select 'checkin'::text kind, c.id, c.created_at, c.user_id, c.place_id, c.photo_path media, null::text poster, ''::text caption
    from checkins c where c.status = 'ok' and c.created_at < p_before
    union all
    select 'video', v.id, v.created_at, v.user_id, v.place_id, v.path, v.poster_path, v.caption
    from videos v where v.status = 'visible' and v.created_at < p_before
  )
  select i.kind, i.id, i.created_at, i.user_id, pr.username, pr.display_name, i.place_id, p.name, p.city,
    i.media, i.poster, i.caption,
    (select count(*) from reactions x where x.kind = i.kind and x.target = i.id)::int,
    exists (select 1 from reactions x where x.kind = i.kind and x.target = i.id and x.user_id = auth.uid())
  from items i
  join profiles pr on pr.id = i.user_id and not pr.banned
  join places p on p.id = i.place_id
  where p_scope = 'all'
     or (p_scope = 'city' and pr.home_city = (select home_city from me))
     or (p_scope = 'friends' and (i.user_id = auth.uid() or i.user_id in (select followee from follows where follower = auth.uid())))
  order by i.created_at desc
  limit least(p_limit, 50)
$$;

-- Publiczny profil: punkty, odznaki, odhaczone lokale, obserwujący.
create or replace function public.profile_stats(p_username text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', pr.id, 'username', pr.username, 'display_name', pr.display_name, 'home_city', pr.home_city,
    'home_lat', pr.home_lat, 'home_lng', pr.home_lng,
    'points', pr.points, 'created_at', pr.created_at, 'is_admin', pr.is_admin,
    'badges', coalesce((select json_agg(json_build_object('code', e.ref, 'at', e.created_at) order by e.created_at)
                        from point_events e where e.user_id = pr.id and e.kind = 'odznaka'), '[]'),
    'places', coalesce((select json_agg(c.place_id) from checkins c where c.user_id = pr.id and c.status = 'ok'), '[]'),
    'videos', (select count(*) from videos v where v.user_id = pr.id and v.status = 'visible'),
    'week', coalesce((select sum(e.points) from point_events e where e.user_id = pr.id and e.created_at > now() - interval '7 days'), 0),
    'followers', (select count(*) from follows f where f.followee = pr.id),
    'following', (select count(*) from follows f where f.follower = pr.id),
    'am_following', exists (select 1 from follows f where f.follower = auth.uid() and f.followee = pr.id),
    'referrals', (select count(*) from profiles x where x.referred_by = pr.id)
  )
  from profiles pr where pr.username = lower(p_username) and not pr.banned
$$;

-- Usunięcie konta (RODO). Pliki w Storage klient usuwa wcześniej sam.
create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Zaloguj się'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- ---------------------------------------------------------------- admin

create or replace function public.require_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Tylko dla admina'; end if;
end $$;

create or replace function public.admin_queue()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return json_build_object(
    'checkins', coalesce((select json_agg(row_to_json(q) order by q.created_at desc) from (
      select c.id, c.created_at, c.photo_path, c.flags, c.distance_m, c.accuracy, c.ai_note,
             pr.username, pr.display_name, p.name place_name, p.city place_city
      from checkins c join profiles pr on pr.id = c.user_id join places p on p.id = c.place_id
      where c.status = 'review' limit 100) q), '[]'),
    'videos', coalesce((select json_agg(row_to_json(q) order by q.reports desc, q.created_at desc) from (
      select v.id, v.created_at, v.path, v.poster_path, v.caption, v.status, v.reports, v.ai_note,
             pr.username, pr.display_name, p.name place_name, p.city place_city,
             (select json_agg(r.reason) from reports r where r.video_id = v.id) reasons
      from videos v join profiles pr on pr.id = v.user_id join places p on p.id = v.place_id
      where v.status = 'hidden' or (v.status = 'visible' and (v.reports > 0 or v.ai_note is not null))
      limit 100) q), '[]'));
end $$;

create or replace function public.admin_checkin(p_id uuid, p_ok boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update checkins set status = case when p_ok then 'ok' else 'rejected' end where id = p_id and status = 'review';
  if p_ok then perform grant_checkin(p_id); end if;
end $$;

create or replace function public.admin_video(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update videos set status = p_status, reports = case when p_status = 'visible' then 0 else reports end where id = p_id;
  if p_status = 'visible' then delete from reports where video_id = p_id; end if;
end $$;

create or replace function public.admin_ban(p_username text, p_ban boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update profiles set banned = p_ban where username = lower(p_username) and not is_admin;
  if p_ban then
    update videos set status = 'removed' where user_id = (select id from profiles where username = lower(p_username));
  end if;
end $$;

-- Wgranie lokali z panelu admina (ta sama treść co scripts/sync-places.mjs, bez klucza service_role).
-- Lokali nigdy nie usuwamy — skasowanie zabrałoby ludziom odhaczenia i punkty.
create or replace function public.admin_sync_places(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform require_admin();
  insert into places (id, name, city, lat, lng, approx, category, muala, closed, video_ids, video_dates)
  select x.id, x.name, x.city, x.lat, x.lng, coalesce(x.approx, false), x.category, coalesce(x.muala, false),
         coalesce(x.closed, false), coalesce(x.video_ids, '{}'), coalesce(x.video_dates, '{}')
  from jsonb_to_recordset(p_rows) as x(id text, name text, city text, lat float8, lng float8, approx boolean,
       category text, muala boolean, closed boolean, video_ids text[], video_dates timestamptz[])
  on conflict (id) do update set name = excluded.name, city = excluded.city, lat = excluded.lat, lng = excluded.lng,
    approx = excluded.approx, category = excluded.category, muala = excluded.muala, closed = excluded.closed,
    video_ids = excluded.video_ids, video_dates = excluded.video_dates;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- moderacja AI (supabase/functions/moderate)

-- Podejrzane zdjęcie: odhaczenie wraca do sprawdzenia, a punkty za nie są cofane do decyzji admina.
create or replace function public.ai_flag_checkin(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare
  c checkins;
  lost int;
begin
  update checkins set status = 'review', flags = array_append(flags, 'ai'), ai_note = left(p_note, 300)
  where id = p_id and status = 'ok'
  returning * into c;
  if not found then
    update checkins set ai_note = left(p_note, 300) where id = p_id;
    return;
  end if;
  with gone as (
    delete from point_events
    where user_id = c.user_id and ref = c.place_id and kind in ('odhaczenie', 'muala', 'pionier', 'swiezy')
    returning points)
  select coalesce(sum(points), 0) into lost from gone;
  update profiles set points = points - lost where id = c.user_id;
end $$;

create or replace function public.ai_flag_video(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update videos set status = case when status = 'visible' then 'hidden' else status end, ai_note = left(p_note, 300)
  where id = p_id;
end $$;

-- ---------------------------------------------------------------- uprawnienia

revoke all on function public.ai_flag_checkin(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_flag_video(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_flag_checkin(uuid, text) to service_role;
grant execute on function public.ai_flag_video(uuid, text) to service_role;

-- Funkcje wewnętrzne nie mogą być wołane z przeglądarki
revoke all on function public.award(uuid, text, text, int) from public, anon, authenticated;
revoke all on function public.evaluate_badges(uuid) from public, anon, authenticated;
revoke all on function public.grant_checkin(uuid) from public, anon, authenticated;
revoke all on function public.current_profile() from public, anon;
revoke all on function public.require_admin() from public, anon;

revoke all on function public.check_in(text, float8, float8, real, text, text) from anon;
revoke all on function public.post_video(text, text, text, text, real) from anon;
revoke all on function public.react(text, uuid, boolean) from anon;
revoke all on function public.report_video(uuid, text) from anon;
revoke all on function public.create_profile(text, text, text, float8, float8, text) from anon;
revoke all on function public.update_profile(text, text, float8, float8) from anon;
revoke all on function public.follow(uuid, boolean) from anon;
revoke all on function public.delete_account() from anon;
revoke all on function public.admin_sync_places(jsonb) from anon;

-- ---------------------------------------------------------------- pliki (Storage)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('checkins', 'checkins', true, 5242880, array['image/jpeg', 'image/webp']),
  ('videos', 'videos', true, 62914560, array['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "ksiapulo: wgrywanie do własnego folderu" on storage.objects;
create policy "ksiapulo: wgrywanie do własnego folderu" on storage.objects for insert to authenticated
  with check (bucket_id in ('checkins', 'videos') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "ksiapulo: usuwanie własnych lub przez admina" on storage.objects;
create policy "ksiapulo: usuwanie własnych lub przez admina" on storage.objects for delete to authenticated
  using (bucket_id in ('checkins', 'videos') and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
drop policy if exists "ksiapulo: lista własnych plików" on storage.objects;
create policy "ksiapulo: lista własnych plików" on storage.objects for select to authenticated
  using (bucket_id in ('checkins', 'videos') and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------- story z lokali i oceny widzów

-- Ocena widza: tylko po zweryfikowanym odhaczeniu (GPS + zdjęcie), jedna na lokal, można ją zmienić.
create table if not exists public.opinions (
  user_id uuid not null references public.profiles on delete cascade,
  place_id text not null references public.places on delete cascade,
  verdict text not null check (verdict in ('muala', 'plus', 'srednio', 'minus')),
  body text not null default '' check (char_length(body) <= 400),
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, place_id)
);
create index if not exists opinions_place on public.opinions (place_id);
alter table public.opinions enable row level security;
drop policy if exists "oceny: widoczne, własne zawsze" on public.opinions;
create policy "oceny: widoczne, własne zawsze" on public.opinions for select
  using (status = 'visible' or user_id = auth.uid() or public.is_admin());

create or replace function public.post_opinion(p_place text, p_verdict text, p_body text)
returns json language plpgsql security definer set search_path = public as $$
declare
  pr profiles := current_profile();
  pts int := 0;
begin
  if not exists (select 1 from checkins where user_id = pr.id and place_id = p_place and status = 'ok') then
    raise exception 'Ocenić możesz tylko lokal, który masz odhaczony na miejscu';
  end if;
  insert into opinions (user_id, place_id, verdict, body)
  values (pr.id, p_place, p_verdict, left(coalesce(p_body, ''), 400))
  on conflict (user_id, place_id) do update
    set verdict = excluded.verdict, body = excluded.body, updated_at = now(), status = 'visible';
  if award(pr.id, 'ocena', p_place, 10) then pts := 10; end if;
  return json_build_object('points', pts);
end $$;

-- Wszystko, co społeczność zostawiła w lokalu: licznik ocen, opinie, moja ocena.
create or replace function public.place_community(p_place text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'counts', coalesce((select json_object_agg(v, n) from (
        select o.verdict v, count(*) n from opinions o join profiles pr on pr.id = o.user_id and not pr.banned
        where o.place_id = p_place and o.status = 'visible' group by o.verdict) c), '{}'),
    'visits', (select count(*) from checkins c where c.place_id = p_place and c.status = 'ok'),
    'opinions', coalesce((select json_agg(row_to_json(q)) from (
        select o.user_id, o.verdict, o.body, o.updated_at, pr.username, pr.display_name
        from opinions o join profiles pr on pr.id = o.user_id and not pr.banned
        where o.place_id = p_place and o.status = 'visible'
        order by o.updated_at desc limit 40) q), '[]'),
    'mine', (select json_build_object('verdict', o.verdict, 'body', o.body) from opinions o
             where o.place_id = p_place and o.user_id = auth.uid()),
    'can_rate', exists (select 1 from checkins c where c.place_id = p_place and c.user_id = auth.uid() and c.status = 'ok')
  )
$$;

-- Story = zdjęcie z odhaczenia albo filmik z opinią z ostatnich p_hours godzin.
create or replace function public.stories(p_place text default null, p_hours int default 72)
returns table (kind text, id uuid, created_at timestamptz, username text, display_name text,
               place_id text, place_name text, place_city text, media_path text, poster_path text, caption text)
language sql stable security definer set search_path = public as $$
  with items as (
    select 'checkin'::text kind, c.id, c.created_at, c.user_id, c.place_id, c.photo_path media, null::text poster, ''::text caption
    from checkins c where c.status = 'ok' and c.created_at > now() - make_interval(hours => least(p_hours, 168))
    union all
    select 'video', v.id, v.created_at, v.user_id, v.place_id, v.path, v.poster_path, v.caption
    from videos v where v.status = 'visible' and v.created_at > now() - make_interval(hours => least(p_hours, 168))
  )
  select i.kind, i.id, i.created_at, pr.username, pr.display_name, i.place_id, p.name, p.city, i.media, i.poster, i.caption
  from items i
  join profiles pr on pr.id = i.user_id and not pr.banned
  join places p on p.id = i.place_id
  where p_place is null or i.place_id = p_place
  order by i.created_at desc
  limit 200
$$;

create or replace function public.admin_opinion(p_user uuid, p_place text, p_hide boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update opinions set status = case when p_hide then 'hidden' else 'visible' end where user_id = p_user and place_id = p_place;
end $$;

revoke all on function public.post_opinion(text, text, text) from anon;
revoke all on function public.admin_opinion(uuid, text, boolean) from anon;
