-- ============================================================
-- posts / comments — anonymous board (nickname + password, no auth).
--    Writes go ONLY through api/board/*.js using the service_role key;
--    anon/authenticated get column-restricted read access so
--    password_hash/ip_hash can never be fetched from the browser.
-- ============================================================
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('business', 'dev', 'scam', 'free')),
  nickname text not null,
  title text not null,
  body text not null,
  password_hash text not null,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists posts_category_created_at_idx on public.posts(category, created_at desc);
create index if not exists posts_ip_hash_created_at_idx on public.posts(ip_hash, created_at desc);

alter table public.posts enable row level security;

create policy "posts: anyone can read"
  on public.posts for select
  using (true);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  nickname text not null,
  body text not null,
  password_hash text not null,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists comments_post_id_created_at_idx on public.comments(post_id, created_at asc);
create index if not exists comments_ip_hash_created_at_idx on public.comments(ip_hash, created_at desc);

alter table public.comments enable row level security;

create policy "comments: anyone can read"
  on public.comments for select
  using (true);

-- Must revoke any table-wide default privileges FIRST — if anon/authenticated ever
-- had blanket SELECT on the table, a column-level grant on top of that is meaningless
-- (the blanket grant alone already exposes every column, including password_hash).
revoke all on public.posts from anon, authenticated;
revoke all on public.comments from anon, authenticated;

-- Column-level grants (Supabase's documented "hide a column" pattern): anon/authenticated
-- get SELECT on the safe columns only — password_hash/ip_hash are never grantable to them,
-- so no select=password_hash query can ever return data, regardless of RLS.
grant select (id, category, nickname, title, body, created_at) on public.posts to anon, authenticated;
grant select (id, post_id, nickname, body, created_at) on public.comments to anon, authenticated;

-- service_role needs its own explicit grant even though RLS doesn't apply to it —
-- this is the exact grant that was missing before and caused the earlier 403.
grant select, insert, update, delete on public.posts to service_role;
grant select, insert, update, delete on public.comments to service_role;

-- ============================================================
-- notice category — pinned announcements, posted only via the
-- Supabase dashboard (service_role), never by anonymous visitors.
-- ============================================================
alter table public.posts drop constraint if exists posts_category_check;
alter table public.posts add constraint posts_category_check
  check (category in ('business', 'dev', 'scam', 'free', 'notice'));

-- anon/authenticated have NO insert grant on public.posts at all today —
-- every write goes through api/board/*.js with the service_role key, which
-- bypasses RLS entirely — so this policy is defense-in-depth, not the
-- primary gate. The primary gate is api/board/create.js's CATEGORIES
-- allowlist, which already omits 'notice'. This policy only starts doing
-- real work if an INSERT grant to anon is ever added later.
create policy "posts: anon cannot insert notice"
  on public.posts for insert
  to anon, authenticated
  with check (category <> 'notice');

-- ============================================================
-- post images — up to 4 per post, uploaded only via
-- api/board/create.js (service_role), stored as full public
-- URLs pointing into the "post-images" Storage bucket.
-- ============================================================
alter table public.posts add column if not exists image_urls text[] not null default '{}';

alter table public.posts drop constraint if exists posts_image_urls_max4;
alter table public.posts add constraint posts_image_urls_max4
  check (array_length(image_urls, 1) is null or array_length(image_urls, 1) <= 4);

-- Column-level grant is additive — this does not touch the columns already
-- granted above, it just adds image_urls to what anon/authenticated may read.
grant select (image_urls) on public.posts to anon, authenticated;

-- Bucket: public read (served straight from the CDN via the public object URL,
-- no auth needed), all writes/deletes go through api/board/*.js with service_role,
-- which bypasses Storage RLS entirely — same trust model as the posts/comments
-- tables above.
insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', true)
on conflict (id) do nothing;

-- Defense-in-depth, matching the posts/comments RLS policies above: anon has no
-- write policy on storage.objects for this bucket at all, so even if the
-- service_role path were ever misconfigured, direct anon uploads would still be
-- rejected. Public bucket reads don't require a SELECT policy (they're served by
-- the public object endpoint, not through RLS-gated queries), but this policy is
-- added anyway for anyone who lists/reads via the authenticated Storage API.
create policy "post-images: anyone can read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'post-images');
