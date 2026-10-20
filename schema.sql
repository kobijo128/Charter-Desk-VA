-- =====================================================================
-- Charter Desk VA — database schema and game rules for Supabase
-- Run this whole file once in the Supabase SQL editor.
-- All money and reputation changes happen inside these functions, so
-- pilots cannot edit their own balances from the browser.
-- =====================================================================

-- ---------- settings ----------
create table if not exists public.va_settings (
  id            int primary key default 1 check (id = 1),
  va_name       text not null default 'Altus Virtual',
  timezone      text not null default 'Europe/London',
  start_cash    int  not null default 60000,
  start_type    text not null default 'E55P',
  start_home    text not null default 'EGJJ',
  market_base   int  not null default 14,
  auto_accept   boolean not null default true,
  last_spawn    timestamptz not null default now() - interval '1 hour',
  last_maint    timestamptz not null default now() - interval '1 hour'
);
insert into public.va_settings default values on conflict do nothing;

-- ---------- reference data ----------
create table if not exists public.airports (
  icao    text primary key check (icao ~ '^[A-Z0-9]{3,4}$'),
  name    text not null,
  city    text not null,
  country text not null default '',
  lat     float8 not null,
  lon     float8 not null,
  tags    text[] not null default '{}',
  active  boolean not null default true
);

create table if not exists public.aircraft_types (
  code      text primary key,
  name      text not null,
  cls       text not null,
  seats     int  not null,
  range_nm  int  not null,
  ktas      int  not null,
  burn      int  not null,          -- lb per hour
  rate      int  not null,          -- charter rate, $ per block hour
  price     int  not null,          -- lease deposit in the shop
  ceil      int  not null,          -- service ceiling, flight level
  sim_match text[] not null default '{}'  -- words the sim aircraft title must contain
);

create table if not exists public.clients (
  name   text primary key,
  pax_lo int not null, pax_hi int not null,
  bud_lo numeric not null, bud_hi numeric not null,
  cat    text not null check (cat in ('biz','leisure','urgent'))
);

-- ---------- pilots and their companies ----------
create table if not exists public.pilots (
  id           uuid primary key references auth.users on delete cascade,
  callsign     text not null unique check (callsign ~ '^[A-Z0-9]{3,8}$'),
  name         text not null,
  company      text not null,
  prefix       text not null check (prefix ~ '^[A-Z]{3}$'),
  home         text not null references public.airports,
  cash         bigint not null,
  rep          numeric(6,2) not null default 50,
  slots        int not null default 2,
  upgrades     jsonb not null default '{"sales":0,"broker":0,"fast":0,"crew":0,"pr":0,"empty":0}',
  is_admin     boolean not null default false,
  next_call_at timestamptz,
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table if not exists public.pilot_keys (
  pilot_id    uuid primary key references public.pilots on delete cascade,
  tracker_key text not null unique
);

create table if not exists public.fleet (
  id         uuid primary key default gen_random_uuid(),
  pilot_id   uuid not null references public.pilots on delete cascade,
  type_code  text not null references public.aircraft_types,
  reg        text not null unique,
  loc        text not null references public.airports,
  hours      numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- market ----------
create table if not exists public.requests (
  id          bigint generated always as identity primary key,
  from_icao   text not null references public.airports,
  to_icao     text not null references public.airports,
  dist        int  not null,
  pax         int  not null,
  client      text not null,
  cat         text not null,
  npc         int  not null,               -- outside operators quoting
  player_bids int  not null default 0,     -- VA pilots quoting
  dep_at      timestamptz not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  decide_at   timestamptz,
  status      text not null default 'open' check (status in ('open','deciding','awarded','unawarded','expired')),
  winner      uuid references public.pilots on delete set null
);
create index if not exists requests_status on public.requests(status, expires_at);

-- hidden from pilots: the client's real budget
create table if not exists public.request_secrets (
  request_id bigint primary key references public.requests on delete cascade,
  budget_mul numeric not null
);

create table if not exists public.bids (
  id          bigint generated always as identity primary key,
  request_id  bigint not null references public.requests on delete cascade,
  pilot_id    uuid not null references public.pilots on delete cascade,
  aircraft_id uuid not null references public.fleet on delete cascade,
  amount      int not null,
  basis       numeric not null,     -- charter rate x block time for this aircraft
  repo_nm     int not null,
  placed_at   timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending','won','lost')),
  note        text,
  notified    boolean not null default false,
  unique (request_id, pilot_id)
);

create table if not exists public.calls (
  id          bigint generated always as identity primary key,
  pilot_id    uuid not null references public.pilots on delete cascade,
  caller      text not null,
  client      text not null,
  line        int  not null,
  from_icao   text not null references public.airports,
  to_icao     text not null references public.airports,
  dist        int not null,
  pax         int not null,
  dep_at      timestamptz not null,
  offer       int not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  status      text not null default 'ringing' check (status in ('ringing','accepted','declined','missed'))
);

-- ---------- trips (bookings) and flight reports ----------
create table if not exists public.trips (
  id          bigint generated always as identity primary key,
  pilot_id    uuid not null references public.pilots on delete cascade,
  aircraft_id uuid references public.fleet on delete set null,
  kind        text not null check (kind in ('charter','ferry')),
  flt         text not null,
  from_icao   text not null references public.airports,
  to_icao     text not null references public.airports,
  dist        int not null,
  pax         int not null default 0,
  client      text,
  caller      text,
  dep_at      timestamptz,
  price       int not null default 0,
  source      text not null default 'bid' check (source in ('bid','call','ferry')),
  seq         int not null default 0,
  status      text not null default 'booked'
              check (status in ('booked','flying','filed','accepted','rejected','cancelled','outsourced')),
  started_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists trips_ac on public.trips(aircraft_id, status, seq);

create table if not exists public.pireps (
  id             bigint generated always as identity primary key,
  trip_id        bigint not null unique references public.trips on delete cascade,
  pilot_id       uuid not null references public.pilots on delete cascade,
  aircraft_id    uuid references public.fleet on delete set null,
  sim            text,
  aircraft_title text,
  tracker_ver    text,
  block_off      timestamptz not null,
  takeoff        timestamptz,
  landing        timestamptz,
  block_on       timestamptz not null,
  block_h        numeric(6,2) not null,
  air_h          numeric(6,2),
  fuel_used_lb   numeric,
  landing_fpm    int,
  landing_g      numeric(4,2),
  bounces        int not null default 0,
  arr_icao       text,
  dist_flown     int,
  checks         jsonb not null default '{}',
  path           jsonb not null default '[]',
  status         text not null default 'pending' check (status in ('pending','accepted','rejected')),
  revenue        int, cost int, tip int, net int, rep_delta numeric(5,2),
  review_note    text,
  created_at     timestamptz not null default now()
);

create table if not exists public.positions (
  pilot_id   uuid primary key references public.pilots on delete cascade,
  trip_id    bigint references public.trips on delete cascade,
  lat float8, lon float8, alt int, gs int, hdg int, phase text,
  updated_at timestamptz not null default now()
);

create table if not exists public.ledger (
  id       bigint generated always as identity primary key,
  pilot_id uuid not null references public.pilots on delete cascade,
  at       timestamptz not null default now(),
  text     text not null,
  amount   bigint not null default 0
);
create index if not exists ledger_pilot on public.ledger(pilot_id, at desc);

-- =====================================================================
-- helpers (internal)
-- =====================================================================
create or replace function public.nm(lat1 float8, lon1 float8, lat2 float8, lon2 float8)
returns int language sql immutable as $$
  select round(2*3440.065*asin(least(1, sqrt(
    power(sin(radians(lat2-lat1)/2),2) +
    cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lon2-lon1)/2),2)))))::int
$$;

create or replace function public.ap_nm(a text, b text)
returns int language sql stable as $$
  select public.nm(x.lat,x.lon,y.lat,y.lon) from public.airports x, public.airports y where x.icao=a and y.icao=b
$$;

create or replace function public.block_h(p_ktas int, p_dist int)
returns numeric language sql immutable as $$
  select case when p_dist <= 0 then 0 else p_dist::numeric / p_ktas + 0.33 end
$$;

create or replace function public.op_rate(p_rate int, p_upg jsonb)
returns numeric language sql immutable as $$
  select p_rate * 0.55 * (1 - 0.05 * coalesce((p_upg->>'crew')::int,0))
$$;

create or replace function public.ap_weight(p_tags text[], p_hour int, p_month int)
returns float8 language plpgsql immutable as $$
declare w float8 := 1;
begin
  if 'biz' = any(p_tags) then w := w * case when p_hour between 5 and 11 then 3 when p_hour < 17 then 1.6 else 0.8 end; end if;
  if 'leisure' = any(p_tags) then w := w * case when p_hour >= 15 or p_hour < 2 then 2.6 when p_hour >= 11 then 1.7 else 0.9 end; end if;
  if 'ski' = any(p_tags) then w := w * case when p_month >= 12 or p_month <= 3 then 3 else 0.35 end; end if;
  if 'long' = any(p_tags) then w := w * 0.5; end if;
  return greatest(w, 0.01);
end $$;

-- where an aircraft will be once its queued trips are flown
create or replace function public.future_loc(p_ac uuid)
returns text language sql stable as $$
  select coalesce(
    (select to_icao from public.trips where aircraft_id = p_ac and status in ('booked','flying') order by seq desc limit 1),
    (select loc from public.fleet where id = p_ac))
$$;

create or replace function public.new_reg()
returns text language plpgsql volatile as $$
declare r text; letters text := 'ABCDEFGHJKLMNPRSTUVWXYZ';
begin
  loop
    r := 'G-' || (select string_agg(substr(letters, 1 + floor(random()*23)::int, 1), '') from generate_series(1,4));
    exit when not exists (select 1 from public.fleet where reg = r);
  end loop;
  return r;
end $$;

create or replace function public.flt_no(p_pilot uuid, p_ferry boolean)
returns text language sql volatile as $$
  select prefix || ' ' || (100 + floor(random()*890)::int)::text || case when p_ferry then 'P' else '' end
  from public.pilots where id = p_pilot
$$;

create or replace function public.add_ledger(p_pilot uuid, p_text text, p_amount bigint)
returns void language sql as $$
  insert into public.ledger(pilot_id, text, amount) values (p_pilot, p_text, p_amount)
$$;

-- pick a plausible charter route, optionally near an airport and within an aircraft's limits
do $$ begin
  if not exists (select 1 from pg_type where typname = 'route_pick') then
    create type public.route_pick as (from_icao text, to_icao text, dist int, pax int, client text, cat text, budget_mul numeric, dep_at timestamptz);
  end if;
end $$;

create or replace function public.gen_route(p_near text, p_max_nm int, p_max_pax int)
returns public.route_pick language plpgsql volatile as $$
declare
  r public.route_pick; f public.airports; t public.airports; c public.clients;
  tz text; h int; m int; lead numeric;
begin
  select timezone into tz from public.va_settings;
  h := extract(hour from now() at time zone tz);
  m := extract(month from now() at time zone tz);
  for i in 1..60 loop
    f := null;
    if p_near is not null and random() < 0.75 then
      if random() < 0.35 then
        select * into f from public.airports where icao = p_near;
      else
        select a.* into f from public.airports a, public.airports n
         where n.icao = p_near and a.icao <> p_near and a.active
           and public.nm(a.lat,a.lon,n.lat,n.lon) < 650
         order by random() limit 1;
      end if;
    end if;
    if f.icao is null then
      select * into f from public.airports where active order by -ln(random())/public.ap_weight(tags,h,m) limit 1;
    end if;
    select * into t from public.airports where active and icao <> f.icao
     order by -ln(random())/public.ap_weight(tags,h,m) limit 1;
    if t.icao is null then return null; end if;
    r.dist := public.nm(f.lat,f.lon,t.lat,t.lon);
    continue when r.dist < 90;
    continue when p_max_nm is not null and r.dist > p_max_nm;
    continue when p_max_nm is null and r.dist > 4000 and random() < 0.6;
    select * into c from public.clients order by random() limit 1;
    r.pax := c.pax_lo + floor(random()*(c.pax_hi - c.pax_lo + 1))::int;
    if p_max_pax is not null then r.pax := least(r.pax, p_max_pax); end if;
    r.from_icao := f.icao; r.to_icao := t.icao; r.client := c.name; r.cat := c.cat;
    r.budget_mul := c.bud_lo + random()*(c.bud_hi - c.bud_lo);
    lead := case when c.cat = 'urgent' then 1.5 + random()*3.5 else 3 + random()*31 end;
    r.dep_at := to_timestamp(ceil(extract(epoch from now() + lead * interval '1 hour') / 900) * 900);
    return r;
  end loop;
  return null;
end $$;

create or replace function public.spawn_request(p_near text, p_max_nm int, p_max_pax int)
returns bigint language plpgsql volatile as $$
declare r public.route_pick; rid bigint;
begin
  r := public.gen_route(p_near, p_max_nm, p_max_pax);
  if r.from_icao is null then return null; end if;
  insert into public.requests(from_icao,to_icao,dist,pax,client,cat,npc,dep_at,expires_at)
  values (r.from_icao, r.to_icao, r.dist, r.pax, r.client, r.cat, 2 + floor(random()*5)::int, r.dep_at,
          least(now() + (14 + random()*36) * interval '1 minute', r.dep_at - interval '1 hour'))
  returning id into rid;
  insert into public.request_secrets(request_id, budget_mul) values (rid, r.budget_mul);
  return rid;
end $$;

-- re-plan positioning legs for one aircraft after its queue changes
create or replace function public.rebuild_ferries(p_ac uuid)
returns void language plpgsql as $$
declare loc text; n int := 0; t record; ac public.fleet;
begin
  select * into ac from public.fleet where id = p_ac;
  loc := ac.loc;
  delete from public.trips where aircraft_id = p_ac and kind = 'ferry' and status = 'booked';
  for t in select * from public.trips where aircraft_id = p_ac and status in ('flying','booked') order by seq, id loop
    if t.status = 'flying' then
      n := n + 1; update public.trips set seq = n where id = t.id; loc := t.to_icao; continue;
    end if;
    if t.from_icao <> loc then
      n := n + 1;
      insert into public.trips(pilot_id, aircraft_id, kind, flt, from_icao, to_icao, dist, source, seq, dep_at)
      values (ac.pilot_id, p_ac, 'ferry', public.flt_no(ac.pilot_id, true), loc, t.from_icao,
              public.ap_nm(loc, t.from_icao), 'ferry', n, t.dep_at - interval '2 hours');
    end if;
    n := n + 1; update public.trips set seq = n where id = t.id; loc := t.to_icao;
  end loop;
end $$;

create or replace function public.book_trip(p_pilot uuid, p_ac uuid, p_from text, p_to text, p_dist int, p_pax int,
  p_client text, p_caller text, p_dep timestamptz, p_price int, p_source text)
returns bigint language plpgsql as $$
declare tid bigint;
begin
  insert into public.trips(pilot_id, aircraft_id, kind, flt, from_icao, to_icao, dist, pax, client, caller, dep_at, price, source, seq)
  values (p_pilot, p_ac, 'charter', public.flt_no(p_pilot, false), p_from, p_to, p_dist, p_pax, p_client, p_caller, p_dep, p_price, p_source, 1000000)
  returning id into tid;
  perform public.rebuild_ferries(p_ac);
  return tid;
end $$;

create or replace function public.schedule_call(p_pilot uuid)
returns void language sql as $$
  update public.pilots
     set next_call_at = now() + ((200 + random()*180) * (1 - 0.22*coalesce((upgrades->>'sales')::int,0)) * (1.25 - rep/200)) * interval '1 second'
   where id = p_pilot
$$;

-- broker decides a request: VA pilots compete with each other and outside operators
create or replace function public.resolve_request(p_req bigint)
returns void language plpgsql as $$
declare
  rq public.requests; bm numeric; b record; best_id bigint; best_eff numeric := 1e9;
  npc_min numeric := 1e9; eff numeric; budget numeric; rate int; win_pilot text;
begin
  select * into rq from public.requests where id = p_req for update;
  select budget_mul into bm from public.request_secrets where request_id = p_req;
  for i in 1..rq.npc loop
    npc_min := least(npc_min, 0.92 + random()*0.30 + random()*0.22);
  end loop;
  for b in select bd.*, p.rep, p.upgrades, ty.rate, ty.ktas from public.bids bd
             join public.pilots p on p.id = bd.pilot_id
             join public.fleet f on f.id = bd.aircraft_id
             join public.aircraft_types ty on ty.code = f.type_code
            where bd.request_id = p_req and bd.status = 'pending' loop
    budget := b.basis * bm * (1 + (b.rep - 50)/600) + 0.55 * b.rate * public.block_h(b.ktas, b.repo_nm) * 0.6;
    if b.amount > budget then
      update public.bids set status = 'lost', note = 'Over the client''s budget.' where id = b.id;
      continue;
    end if;
    eff := b.amount / b.basis / (1 + (b.rep - 50)/400) * (1 - 0.03 * coalesce((b.upgrades->>'broker')::int,0));
    if eff < best_eff then best_eff := eff; best_id := b.id; end if;
  end loop;

  if best_id is not null and best_eff < npc_min then
    select bd.*, p.callsign into b from public.bids bd join public.pilots p on p.id = bd.pilot_id where bd.id = best_id;
    update public.bids set status = 'won', note = 'Client accepted your quote.' where id = best_id;
    update public.requests set status = 'awarded', winner = b.pilot_id where id = p_req;
    perform public.book_trip(b.pilot_id, b.aircraft_id, rq.from_icao, rq.to_icao, rq.dist, rq.pax, rq.client, null, rq.dep_at, b.amount, 'bid');
    perform public.add_ledger(b.pilot_id, format('Won %s–%s for %s at $%s', rq.from_icao, rq.to_icao, rq.client, to_char(b.amount,'FM999,999,999')), 0);
    update public.bids set status = 'lost', note = format('%s won with a better quote.', b.callsign)
     where request_id = p_req and status = 'pending';
  else
    update public.requests set status = 'unawarded' where id = p_req;
    for b in select * from public.bids where request_id = p_req and status = 'pending' loop
      update public.bids set status = 'lost',
        note = format('Another operator won at about $%s.', to_char(round(npc_min * b.basis / 100) * 100, 'FM999,999,999'))
       where id = b.id;
    end loop;
  end if;
end $$;

-- shared upkeep: decide bids, expire old work, keep the board stocked
create or replace function public.maintain()
returns void language plpgsql as $$
declare s public.va_settings; rq record; tgt int; open_n int; active_n int; near text; tr record; h int; gap interval;
begin
  if not pg_try_advisory_xact_lock(424242) then return; end if;
  select * into s from public.va_settings;

  for rq in select id from public.requests where status = 'deciding' and decide_at <= now() loop
    perform public.resolve_request(rq.id);
  end loop;

  update public.requests set status = 'expired' where status = 'open' and expires_at < now();
  delete from public.requests where status in ('expired','unawarded','awarded') and created_at < now() - interval '2 days';
  delete from public.positions where updated_at < now() - interval '10 minutes';

  -- bookings never flown: the client books someone else 48h after the planned departure
  for tr in select * from public.trips where kind = 'charter' and status = 'booked' and dep_at < now() - interval '48 hours' loop
    update public.trips set status = 'cancelled' where id = tr.id;
    update public.pilots set rep = greatest(0, rep - 3) where id = tr.pilot_id;
    perform public.add_ledger(tr.pilot_id, format('%s %s–%s lapsed unflown; client rebooked elsewhere', tr.flt, tr.from_icao, tr.to_icao), 0);
    perform public.rebuild_ferries(tr.aircraft_id);
  end loop;

  select count(*) into active_n from public.pilots where last_seen > now() - interval '15 minutes';
  tgt := least(45, s.market_base + 3 * active_n);
  select count(*) into open_n from public.requests where status in ('open','deciding');
  h := extract(hour from now() at time zone s.timezone);
  gap := case when h < 6 then interval '60 seconds' else interval '18 seconds' end;

  if open_n < tgt and (now() - s.last_spawn > gap or open_n < tgt / 2) then
    for i in 1..greatest(1, least(tgt - open_n, case when open_n < tgt/2 then tgt - open_n else 1 end)) loop
      near := null;
      if random() < 0.55 then
        select public.future_loc(f.id) into near from public.fleet f join public.pilots p on p.id = f.pilot_id
         where p.last_seen > now() - interval '15 minutes' order by random() limit 1;
      end if;
      perform public.spawn_request(near, null, null);
    end loop;
    update public.va_settings set last_spawn = now();
  end if;
  update public.va_settings set last_maint = now();
end $$;

-- money and reputation for a finished flight
create or replace function public.settle(p_pirep bigint)
returns void language plpgsql as $$
declare
  pr public.pireps; tr public.trips; p public.pilots; ty public.aircraft_types;
  op numeric; v_cost numeric; v_rev int; v_tip int := 0; v_rep numeric := 0; est numeric; note text := '';
begin
  select * into pr from public.pireps where id = p_pirep for update;
  select * into tr from public.trips where id = pr.trip_id;
  select * into p from public.pilots where id = pr.pilot_id for update;
  select ty2.* into ty from public.fleet f join public.aircraft_types ty2 on ty2.code = f.type_code where f.id = tr.aircraft_id;
  op := public.op_rate(ty.rate, p.upgrades) * pr.block_h;

  if tr.kind = 'ferry' then
    v_rev := 0;
    v_cost := op * (1 - 0.25 * coalesce((p.upgrades->>'empty')::int,0));
    if pr.landing_fpm > 600 then v_cost := v_cost + ty.rate * 2; v_rep := -2; note := 'Hard-landing inspection. '; end if;
  else
    v_rev := tr.price; v_cost := op; v_rep := 1;
    if pr.landing_fpm is not null then
      if pr.landing_fpm <= 150 then v_tip := round(tr.price * 0.05); v_rep := 3; note := 'Butter landing, client tipped 5%. ';
      elsif pr.landing_fpm <= 300 then v_rep := 1.5;
      elsif pr.landing_fpm <= 500 then v_rep := -1; note := 'Firm landing. ';
      else v_rep := -4; v_cost := v_cost + ty.rate * 2; note := 'Hard landing: complaint and inspection. ';
      end if;
    end if;
    if pr.bounces > 0 then v_rep := v_rep - 0.5 * pr.bounces; end if;
    if tr.dep_at is not null and abs(extract(epoch from pr.block_off - tr.dep_at)) <= 1800 then
      v_rep := v_rep + 1; v_tip := v_tip + round(tr.price * 0.03); note := note || 'On time. ';
    end if;
    est := public.block_h(ty.ktas, tr.dist);
    if pr.block_h > est * 1.3 + 0.25 then v_rep := v_rep - 2; note := note || 'Well over the quoted time. '; end if;
  end if;
  if v_rep > 0 then v_rep := v_rep * (1 + 0.25 * coalesce((p.upgrades->>'pr')::int,0)); end if;

  update public.pireps set status = 'accepted', revenue = v_rev + v_tip, cost = round(v_cost), tip = v_tip,
         net = v_rev + v_tip - round(v_cost), rep_delta = v_rep,
         review_note = coalesce(nullif(review_note,''), trim(note))
   where id = p_pirep;
  update public.pilots set cash = cash + v_rev + v_tip - round(v_cost), rep = least(100, greatest(0, rep + v_rep)) where id = p.id;
  update public.fleet set hours = hours + pr.block_h where id = tr.aircraft_id;
  update public.trips set status = 'accepted' where id = tr.id;
  perform public.add_ledger(p.id, format('%s %s–%s: revenue $%s, operating cost $%s', tr.flt, tr.from_icao, tr.to_icao,
          to_char(v_rev + v_tip,'FM999,999,990'), to_char(round(v_cost),'FM999,999,990')), (v_rev + v_tip - round(v_cost))::bigint);
end $$;

-- =====================================================================
-- pilot-facing functions (called from the web app)
-- =====================================================================
create or replace function public.me() returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null or not exists (select 1 from public.pilots where id = u) then
    raise exception 'Set up your pilot profile first.' using errcode = 'P0001';
  end if;
  return u;
end $$;

create or replace function public.ensure_pilot(p_callsign text, p_name text, p_company text, p_prefix text, p_home text)
returns uuid language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s public.va_settings; first_pilot boolean; ac uuid;
begin
  if u is null then raise exception 'Sign in first.'; end if;
  if exists (select 1 from pilots where id = u) then return u; end if;
  select * into s from va_settings;
  p_callsign := upper(trim(p_callsign)); p_prefix := upper(trim(p_prefix));
  if p_callsign !~ '^[A-Z0-9]{3,8}$' then raise exception 'Callsign must be 3–8 letters or numbers.'; end if;
  if p_prefix !~ '^[A-Z]{3}$' then raise exception 'Flight number prefix must be 3 letters.'; end if;
  if exists (select 1 from pilots where callsign = p_callsign) then raise exception 'That callsign is taken.'; end if;
  if not exists (select 1 from airports where icao = upper(p_home) and active) then p_home := s.start_home; end if;
  first_pilot := not exists (select 1 from pilots);
  insert into pilots(id, callsign, name, company, prefix, home, cash, is_admin, next_call_at)
  values (u, p_callsign, trim(p_name), trim(p_company), p_prefix, upper(p_home), s.start_cash, first_pilot, now() + interval '45 seconds');
  insert into pilot_keys(pilot_id, tracker_key) values (u, replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''));
  insert into fleet(pilot_id, type_code, reg, loc) values (u, s.start_type, new_reg(), upper(p_home)) returning id into ac;
  perform add_ledger(u, format('%s founded at %s', trim(p_company), upper(p_home)), s.start_cash);
  return u;
end $$;

-- called every few seconds by the web app; returns news for this pilot
create or replace function public.poll()
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid := me(); p pilots; c record; ac record; r route_pick; fair numeric; ev jsonb;
begin
  update pilots set last_seen = now() where id = u returning * into p;
  perform maintain();

  for c in select * from calls where pilot_id = u and status = 'ringing' and expires_at < now() loop
    update calls set status = 'missed' where id = c.id;
    perform schedule_call(u);
  end loop;

  if not exists (select 1 from calls where pilot_id = u and status = 'ringing') and p.next_call_at <= now() then
    select f.id, f.type_code, t.* into ac from fleet f join aircraft_types t on t.code = f.type_code
     where f.pilot_id = u order by random() limit 1;
    if ac.id is not null then
      r := gen_route(future_loc(ac.id), floor(ac.range_nm*0.9)::int, ac.seats);
      if r.from_icao is not null then
        fair := ac.rate * block_h(ac.ktas, r.dist)
              + 0.55 * ac.rate * block_h(ac.ktas, coalesce(nullif(ap_nm(future_loc(ac.id), r.from_icao),0),0));
        insert into calls(pilot_id, caller, client, line, from_icao, to_icao, dist, pax, dep_at, offer, expires_at)
        values (u,
          (array['Helen Marchetti','Rupert Ashdown','Camille Duret','Tomás Iglesias','Priya Raman','Oskar Lindqvist','Fiona Kerrigan',
                 'Marcus Delacroix','Ines Vallart','Jonah Whitcombe','Sofia Brandt','Laurent Pichon','Ade Okafor','Greta Hollis'])[1+floor(random()*14)::int],
          r.client, floor(random()*4)::int, r.from_icao, r.to_icao, r.dist, r.pax, r.dep_at,
          (round(fair * (1.15 + random()*0.30) / 500) * 500)::int, now() + interval '90 seconds');
      end if;
    end if;
    perform schedule_call(u);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('won', b.status = 'won', 'route', rq.from_icao || ' → ' || rq.to_icao,
           'amount', b.amount, 'note', b.note, 'client', rq.client) order by b.id), '[]')
    into ev
    from bids b join requests rq on rq.id = b.request_id
   where b.pilot_id = u and b.status <> 'pending' and not b.notified;
  update bids set notified = true where pilot_id = u and status <> 'pending' and not notified;
  return jsonb_build_object('events', ev, 'now', now());
end $$;

create or replace function public.place_bid(p_request bigint, p_aircraft uuid, p_amount int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare u uuid := me(); p pilots; rq requests; f fleet; ty aircraft_types; loc text; repo int; basis numeric; wait int;
begin
  select * into p from pilots where id = u;
  select * into rq from requests where id = p_request for update;
  if rq.id is null or rq.status not in ('open','deciding') then raise exception 'That request has closed.'; end if;
  if rq.decide_at is not null and rq.decide_at <= now() then raise exception 'The broker is already deciding.'; end if;
  select * into f from fleet where id = p_aircraft and pilot_id = u;
  if f.id is null then raise exception 'That aircraft is not in your fleet.'; end if;
  select * into ty from aircraft_types where code = f.type_code;
  if rq.pax > ty.seats then raise exception 'Not enough seats.'; end if;
  if rq.dist > ty.range_nm * 0.92 then raise exception 'Beyond this aircraft''s range.'; end if;
  wait := (array[30,22,15,10])[1 + least(3, coalesce((p.upgrades->>'fast')::int,0))];
  if rq.decide_at is null and rq.expires_at < now() + wait * interval '1 second' then raise exception 'That request is closing too soon to quote.'; end if;
  loc := future_loc(f.id);
  repo := case when loc = rq.from_icao then 0 else ap_nm(loc, rq.from_icao) end;
  basis := ty.rate * block_h(ty.ktas, rq.dist);
  if p_amount < 100 or p_amount > basis * 10 then raise exception 'Enter a realistic price.'; end if;
  insert into bids(request_id, pilot_id, aircraft_id, amount, basis, repo_nm) values (p_request, u, f.id, p_amount, basis, repo);
  update requests set player_bids = player_bids + 1,
         decide_at = coalesce(decide_at, now() + wait * interval '1 second'), status = 'deciding'
   where id = p_request returning decide_at into rq.decide_at;
  return rq.decide_at;
exception when unique_violation then raise exception 'You already quoted on this request.';
end $$;

create or replace function public.accept_call(p_call bigint, p_aircraft uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare u uuid := me(); c calls; f fleet; ty aircraft_types; tid bigint;
begin
  select * into c from calls where id = p_call and pilot_id = u for update;
  if c.id is null or c.status <> 'ringing' or c.expires_at < now() then raise exception 'The caller has hung up.'; end if;
  select * into f from fleet where id = p_aircraft and pilot_id = u;
  select * into ty from aircraft_types where code = f.type_code;
  if f.id is null or c.pax > ty.seats or c.dist > ty.range_nm * 0.92 then raise exception 'That aircraft can''t fly this job.'; end if;
  update calls set status = 'accepted' where id = c.id;
  tid := book_trip(u, f.id, c.from_icao, c.to_icao, c.dist, c.pax, c.client, c.caller, c.dep_at, c.offer, 'call');
  perform add_ledger(u, format('Phone booking from %s: %s–%s for $%s', c.caller, c.from_icao, c.to_icao, to_char(c.offer,'FM999,999,999')), 0);
  perform schedule_call(u);
  return tid;
end $$;

create or replace function public.decline_call(p_call bigint)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := me();
begin
  update calls set status = 'declined' where id = p_call and pilot_id = u and status = 'ringing';
  perform schedule_call(u);
end $$;

create or replace function public.cancel_trip(p_trip bigint)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := me(); t trips; fee int;
begin
  select * into t from trips where id = p_trip and pilot_id = u for update;
  if t.id is null or t.status <> 'booked' or t.kind <> 'charter' then raise exception 'Only booked charters can be cancelled.'; end if;
  fee := round(t.price * 0.2);
  update trips set status = 'cancelled' where id = t.id;
  update pilots set cash = cash - fee, rep = greatest(0, rep - 5) where id = u;
  perform add_ledger(u, format('Cancelled %s %s–%s', t.flt, t.from_icao, t.to_icao), -fee);
  perform rebuild_ferries(t.aircraft_id);
end $$;

-- pay another crew to position the aircraft instead of flying the ferry yourself
create or replace function public.outsource_ferry(p_trip bigint)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := me(); t trips; p pilots; ty aircraft_types; cost int;
begin
  select * into t from trips where id = p_trip and pilot_id = u for update;
  if t.id is null or t.kind <> 'ferry' or t.status <> 'booked' then raise exception 'That positioning leg can''t be outsourced.'; end if;
  if exists (select 1 from trips where aircraft_id = t.aircraft_id and status in ('booked','flying') and seq < t.seq) then
    raise exception 'Fly or clear the earlier trips for this aircraft first.';
  end if;
  select * into p from pilots where id = u;
  select ty2.* into ty from fleet f join aircraft_types ty2 on ty2.code = f.type_code where f.id = t.aircraft_id;
  cost := round(op_rate(ty.rate, p.upgrades) * block_h(ty.ktas, t.dist) * 1.5);
  update trips set status = 'outsourced' where id = t.id;
  update fleet set loc = t.to_icao, hours = hours + block_h(ty.ktas, t.dist) where id = t.aircraft_id;
  update pilots set cash = cash - cost where id = u;
  perform add_ledger(u, format('Contract crew positioned aircraft %s–%s', t.from_icao, t.to_icao), -cost);
end $$;

create or replace function public.buy_aircraft(p_type text)
returns uuid language plpgsql security definer set search_path = public as $$
declare u uuid := me(); p pilots; ty aircraft_types; v_id uuid;
begin
  select * into p from pilots where id = u for update;
  select * into ty from aircraft_types where code = p_type;
  if ty.code is null then raise exception 'Unknown aircraft type.'; end if;
  if (select count(*) from fleet where pilot_id = u) >= p.slots then raise exception 'Buy another fleet slot first.'; end if;
  if p.cash < ty.price then raise exception 'Not enough money.'; end if;
  update pilots set cash = cash - ty.price where id = u;
  insert into fleet(pilot_id, type_code, reg, loc) values (u, ty.code, new_reg(), p.home) returning fleet.id into v_id;
  perform add_ledger(u, format('%s added to the fleet', ty.name), -ty.price);
  return v_id;
end $$;

create or replace function public.buy_slot()
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := me(); p pilots; cost bigint;
begin
  select * into p from pilots where id = u for update;
  cost := 60000 * power(2, p.slots - 2);
  if p.cash < cost then raise exception 'Not enough money.'; end if;
  update pilots set cash = cash - cost, slots = slots + 1 where id = u;
  perform add_ledger(u, format('Bought fleet slot %s', p.slots + 1), -cost);
end $$;

create or replace function public.buy_upgrade(p_key text)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := me(); p pilots; costs jsonb := '{"sales":[30000,70000,140000],"broker":[25000,60000,120000],"fast":[20000,50000,100000],"crew":[40000,90000,180000],"pr":[35000,80000,160000],"empty":[50000,120000]}';
  lvl int; cost int;
begin
  select * into p from pilots where id = u for update;
  if not costs ? p_key then raise exception 'Unknown upgrade.'; end if;
  lvl := coalesce((p.upgrades->>p_key)::int, 0);
  if lvl >= jsonb_array_length(costs->p_key) then raise exception 'Already at the top level.'; end if;
  cost := (costs->p_key->>lvl)::int;
  if p.cash < cost then raise exception 'Not enough money.'; end if;
  update pilots set cash = cash - cost, upgrades = jsonb_set(upgrades, array[p_key], to_jsonb(lvl + 1)) where id = u;
  perform add_ledger(u, format('Upgrade: %s level %s', p_key, lvl + 1), -cost);
  if p_key = 'sales' then perform schedule_call(u); end if;
end $$;

create or replace function public.sell_aircraft(p_ac uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := me(); f fleet; ty aircraft_types; v int;
begin
  select * into f from fleet where id = p_ac and pilot_id = u;
  if f.id is null then raise exception 'Not your aircraft.'; end if;
  if (select count(*) from fleet where pilot_id = u) <= 1 then raise exception 'You need at least one aircraft.'; end if;
  if exists (select 1 from trips where aircraft_id = p_ac and status in ('booked','flying','filed')) then raise exception 'Finish or cancel its trips first.'; end if;
  select * into ty from aircraft_types where code = f.type_code;
  v := round(ty.price * 0.6);
  delete from bids where aircraft_id = p_ac and status = 'pending';
  delete from fleet where id = p_ac;
  update pilots set cash = cash + v where id = u;
  perform add_ledger(u, format('Sold %s (%s)', f.reg, ty.name), v);
end $$;

create or replace function public.update_company(p_company text, p_prefix text)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := me();
begin
  p_prefix := upper(trim(p_prefix));
  if p_prefix !~ '^[A-Z]{3}$' then raise exception 'Flight number prefix must be 3 letters.'; end if;
  if length(trim(p_company)) < 2 then raise exception 'Enter a company name.'; end if;
  update pilots set company = trim(p_company), prefix = p_prefix where id = u;
end $$;

create or replace function public.my_tracker_key()
returns text language sql security definer set search_path = public as $$
  select tracker_key from pilot_keys where pilot_id = me()
$$;

create or replace function public.rotate_tracker_key()
returns text language sql security definer set search_path = public as $$
  update pilot_keys set tracker_key = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
   where pilot_id = me() returning tracker_key
$$;

-- =====================================================================
-- tracker functions (called by the desktop tracker with the pilot's key)
-- =====================================================================
create or replace function public.tracker_pilot(p_key text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare u uuid;
begin
  select pilot_id into u from pilot_keys where tracker_key = p_key;
  if u is null then raise exception 'Tracker key not recognised. Copy it again from your Profile page.'; end if;
  return u;
end $$;

create or replace function public.tracker_session(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid := tracker_pilot(p_key); res jsonb;
begin
  update pilots set last_seen = now() where id = u;
  select jsonb_build_object(
    'pilot', (select jsonb_build_object('callsign', callsign, 'name', name, 'company', company) from pilots where id = u),
    'trips', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'flt', t.flt, 'kind', t.kind, 'status', t.status,
        'from', t.from_icao, 'to', t.to_icao, 'dist', t.dist, 'pax', t.pax, 'dep_at', t.dep_at,
        'from_lat', a.lat, 'from_lon', a.lon, 'to_lat', b.lat, 'to_lon', b.lon,
        'reg', f.reg, 'type', f.type_code, 'type_name', ty.name, 'sim_match', ty.sim_match) order by t.dep_at nulls first)
      from trips t
      join fleet f on f.id = t.aircraft_id
      join aircraft_types ty on ty.code = f.type_code
      join airports a on a.icao = t.from_icao
      join airports b on b.icao = t.to_icao
      where t.pilot_id = u and t.status in ('booked','flying')
        and t.seq = (select min(seq) from trips t2 where t2.aircraft_id = t.aircraft_id and t2.status in ('booked','flying'))
    ), '[]')) into res;
  return res;
end $$;

create or replace function public.tracker_start(p_key text, p_trip bigint)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := tracker_pilot(p_key); t trips;
begin
  select * into t from trips where id = p_trip and pilot_id = u for update;
  if t.id is null or t.status not in ('booked','flying') then raise exception 'That booking is not available to fly.'; end if;
  if exists (select 1 from trips where aircraft_id = t.aircraft_id and status in ('booked','flying') and seq < t.seq) then
    raise exception 'This aircraft has an earlier trip to fly first.';
  end if;
  update trips set status = 'flying', started_at = coalesce(started_at, now()) where id = t.id;
end $$;

create or replace function public.tracker_position(p_key text, p_trip bigint, p_lat float8, p_lon float8, p_alt int, p_gs int, p_hdg int, p_phase text)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := tracker_pilot(p_key);
begin
  insert into positions(pilot_id, trip_id, lat, lon, alt, gs, hdg, phase, updated_at)
  values (u, p_trip, p_lat, p_lon, p_alt, p_gs, p_hdg, left(p_phase, 20), now())
  on conflict (pilot_id) do update set trip_id = excluded.trip_id, lat = excluded.lat, lon = excluded.lon, alt = excluded.alt,
    gs = excluded.gs, hdg = excluded.hdg, phase = excluded.phase, updated_at = now();
  update pilots set last_seen = now() where id = u;
end $$;

-- the tracker files the flight report at block on
create or replace function public.tracker_file(p_key text, p_trip bigint, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := tracker_pilot(p_key); t trips; ty aircraft_types; a airports; b airports; s va_settings;
  bo timestamptz; bn timestamptz; tko timestamptz; ldg timestamptz; bh numeric; airh numeric;
  dep_nm int; arr_nm int; type_ok boolean; speed_ok boolean; ok boolean; arr text; chk jsonb; pid bigint; title text; res jsonb;
begin
  select * into t from trips where id = p_trip and pilot_id = u for update;
  if t.id is null or t.status <> 'flying' then raise exception 'That booking is not in progress.'; end if;
  select * into s from va_settings;
  select ty2.* into ty from fleet f join aircraft_types ty2 on ty2.code = f.type_code where f.id = t.aircraft_id;
  select * into a from airports where icao = t.from_icao;
  select * into b from airports where icao = t.to_icao;

  bo := (d->>'block_off')::timestamptz; bn := (d->>'block_on')::timestamptz;
  tko := nullif(d->>'takeoff','')::timestamptz; ldg := nullif(d->>'landing','')::timestamptz;
  if bo is null or bn is null or bn <= bo then raise exception 'Block times are missing or out of order.'; end if;
  bh := round(extract(epoch from bn - bo) / 3600.0, 2);
  airh := case when tko is not null and ldg is not null then round(extract(epoch from ldg - tko)/3600.0, 2) end;
  title := left(coalesce(d->>'aircraft_title',''), 120);

  dep_nm := nm((d->>'dep_lat')::float8, (d->>'dep_lon')::float8, a.lat, a.lon);
  arr_nm := nm((d->>'arr_lat')::float8, (d->>'arr_lon')::float8, b.lat, b.lon);
  type_ok := cardinality(ty.sim_match) = 0 or exists (select 1 from unnest(ty.sim_match) w where lower(title) like '%' || lower(w) || '%');
  -- a jet cannot cover the distance faster than ~1.35x its cruise speed: catches sim-rate acceleration
  speed_ok := airh is null or airh = 0 or t.dist / airh <= ty.ktas * 1.35;
  chk := jsonb_build_object(
    'departure', jsonb_build_object('ok', dep_nm <= 3, 'nm', dep_nm),
    'arrival',   jsonb_build_object('ok', arr_nm <= 3, 'nm', arr_nm),
    'aircraft',  jsonb_build_object('ok', type_ok, 'title', title),
    'speed',     jsonb_build_object('ok', speed_ok),
    'crash',     jsonb_build_object('ok', not coalesce((d->>'crashed')::boolean, false)),
    'slew',      jsonb_build_object('ok', not coalesce((d->>'slew')::boolean, false)),
    'sim_rate',  jsonb_build_object('ok', coalesce((d->>'max_sim_rate')::numeric, 1) <= 1.01, 'max', coalesce((d->>'max_sim_rate')::numeric, 1)),
    'overspeed', jsonb_build_object('ok', coalesce((d->>'overspeed_s')::int, 0) < 60, 'seconds', coalesce((d->>'overspeed_s')::int, 0)));
  select bool_and((v->>'ok')::boolean) into ok from jsonb_each(chk) e(k, v);

  if arr_nm <= 3 then arr := b.icao;
  else select icao into arr from airports order by nm((d->>'arr_lat')::float8, (d->>'arr_lon')::float8, lat, lon) limit 1; end if;

  insert into pireps(trip_id, pilot_id, aircraft_id, sim, aircraft_title, tracker_ver, block_off, takeoff, landing, block_on,
                     block_h, air_h, fuel_used_lb, landing_fpm, landing_g, bounces, arr_icao, dist_flown, checks, path)
  values (t.id, u, t.aircraft_id, left(d->>'sim', 40), title, left(d->>'tracker_ver', 20), bo, tko, ldg, bn,
          bh, airh, (d->>'fuel_used_lb')::numeric, abs((d->>'landing_fpm')::numeric)::int, (d->>'landing_g')::numeric,
          coalesce((d->>'bounces')::int, 0), arr, (d->>'dist_flown')::numeric::int, chk,
          coalesce(case when jsonb_typeof(d->'path') = 'array' and jsonb_array_length(d->'path') <= 4000 then d->'path' end, '[]'))
  returning id into pid;

  update trips set status = 'filed' where id = t.id;
  update fleet set loc = arr where id = t.aircraft_id;
  delete from positions where pilot_id = u;
  if arr <> t.to_icao then perform rebuild_ferries(t.aircraft_id); end if;

  if ok and s.auto_accept then perform settle(pid); end if;
  select jsonb_build_object('pirep', id, 'status', status, 'net', net, 'rep_delta', rep_delta, 'checks', checks, 'note', review_note)
    into res from pireps where id = pid;
  return res;
end $$;

-- =====================================================================
-- owner / staff functions
-- =====================================================================
create or replace function public.require_admin() returns uuid language plpgsql stable security definer set search_path = public as $$
declare u uuid := me();
begin
  if not (select is_admin from pilots where id = u) then raise exception 'Staff only.'; end if;
  return u;
end $$;

create or replace function public.admin_review(p_pirep bigint, p_accept boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare pr pireps;
begin
  perform require_admin();
  select * into pr from pireps where id = p_pirep for update;
  if pr.status <> 'pending' then raise exception 'Already reviewed.'; end if;
  update pireps set review_note = nullif(trim(coalesce(p_note,'')),'') where id = p_pirep;
  if p_accept then perform settle(p_pirep);
  else
    update pireps set status = 'rejected' where id = p_pirep;
    update trips set status = 'rejected' where id = pr.trip_id;
    update pilots set rep = greatest(0, rep - 2) where id = pr.pilot_id;
    perform add_ledger(pr.pilot_id, 'Flight report rejected: ' || coalesce(p_note,'no reason given'), 0);
  end if;
end $$;

create or replace function public.admin_upsert_airport(p_icao text, p_name text, p_city text, p_country text, p_lat float8, p_lon float8, p_tags text[], p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  insert into airports(icao, name, city, country, lat, lon, tags, active)
  values (upper(trim(p_icao)), p_name, p_city, coalesce(p_country,''), p_lat, p_lon, coalesce(p_tags,'{}'), coalesce(p_active,true))
  on conflict (icao) do update set name = excluded.name, city = excluded.city, country = excluded.country,
    lat = excluded.lat, lon = excluded.lon, tags = excluded.tags, active = excluded.active;
end $$;

create or replace function public.admin_settings(p_va_name text, p_timezone text, p_start_cash int, p_market_base int, p_auto_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  perform now() at time zone p_timezone;  -- rejects unknown time zones
  update va_settings set va_name = p_va_name, timezone = p_timezone, start_cash = p_start_cash,
         market_base = greatest(4, least(40, p_market_base)), auto_accept = p_auto_accept;
end $$;

create or replace function public.admin_set_staff(p_pilot uuid, p_staff boolean)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := require_admin();
begin
  if p_pilot = u and not p_staff then raise exception 'You can''t remove your own staff access.'; end if;
  update pilots set is_admin = p_staff where id = p_pilot;
end $$;

create or replace function public.admin_adjust(p_pilot uuid, p_cash int, p_rep numeric, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update pilots set cash = cash + coalesce(p_cash,0), rep = least(100, greatest(0, rep + coalesce(p_rep,0))) where id = p_pilot;
  perform add_ledger(p_pilot, 'Staff adjustment: ' || coalesce(p_reason,''), coalesce(p_cash,0));
end $$;

-- =====================================================================
-- security: read access through row level security, writes only via functions
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['va_settings','airports','aircraft_types','clients','pilots','pilot_keys','fleet','requests',
                           'request_secrets','bids','calls','trips','pireps','positions','ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;

drop policy if exists read_all on public.va_settings;    create policy read_all on public.va_settings    for select using (true);
drop policy if exists read_all on public.airports;       create policy read_all on public.airports       for select using (true);
drop policy if exists read_all on public.aircraft_types; create policy read_all on public.aircraft_types for select using (true);
drop policy if exists read_all on public.clients;        create policy read_all on public.clients        for select using (true);
drop policy if exists read_all on public.positions;      create policy read_all on public.positions      for select using (true);
drop policy if exists read_auth on public.pilots;   create policy read_auth on public.pilots   for select to authenticated using (true);
drop policy if exists read_auth on public.fleet;    create policy read_auth on public.fleet    for select to authenticated using (true);
drop policy if exists read_auth on public.requests; create policy read_auth on public.requests for select to authenticated using (true);
drop policy if exists read_auth on public.trips;    create policy read_auth on public.trips    for select to authenticated using (true);
drop policy if exists read_auth on public.pireps;   create policy read_auth on public.pireps   for select to authenticated using (true);
drop policy if exists read_own on public.bids;   create policy read_own on public.bids   for select to authenticated using (pilot_id = auth.uid());
drop policy if exists read_own on public.calls;  create policy read_own on public.calls  for select to authenticated using (pilot_id = auth.uid());
drop policy if exists read_own on public.ledger; create policy read_own on public.ledger for select to authenticated using (pilot_id = auth.uid());
-- pilot_keys and request_secrets have no policies: nobody can read them directly

-- internal helpers are not callable from outside
do $$
declare f text;
begin
  foreach f in array array['nm(float8,float8,float8,float8)','ap_nm(text,text)','block_h(int,int)','op_rate(int,jsonb)',
     'ap_weight(text[],int,int)','future_loc(uuid)','new_reg()','flt_no(uuid,boolean)','add_ledger(uuid,text,bigint)',
     'gen_route(text,int,int)','spawn_request(text,int,int)','rebuild_ferries(uuid)',
     'book_trip(uuid,uuid,text,text,int,int,text,text,timestamptz,int,text)','schedule_call(uuid)',
     'resolve_request(bigint)','maintain()','settle(bigint)','me()','tracker_pilot(text)','require_admin()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['ensure_pilot(text,text,text,text,text)','poll()','place_bid(bigint,uuid,int)','accept_call(bigint,uuid)',
     'decline_call(bigint)','cancel_trip(bigint)','outsource_ferry(bigint)','buy_aircraft(text)','buy_slot()','buy_upgrade(text)',
     'sell_aircraft(uuid)','update_company(text,text)','my_tracker_key()','rotate_tracker_key()',
     'admin_review(bigint,boolean,text)','admin_upsert_airport(text,text,text,text,float8,float8,text[],boolean)',
     'admin_settings(text,text,int,int,boolean)','admin_set_staff(uuid,boolean)','admin_adjust(uuid,int,numeric,text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['tracker_session(text)','tracker_start(text,bigint)',
     'tracker_position(text,bigint,float8,float8,int,int,int,text)','tracker_file(text,bigint,jsonb)'] loop
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
