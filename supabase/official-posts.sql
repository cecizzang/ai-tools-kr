-- ============================================================
-- 운영자 글 표시 (posts.is_official)
-- Supabase SQL Editor에서 한 번 실행. 여러 번 실행해도 안전하다.
--
-- 운영자 글 여부는 닉네임이 아니라 이 컬럼으로만 판별한다.
-- true로 바꾸는 건 Supabase 대시보드(Table Editor / SQL Editor)에서만 한다.
-- ============================================================

alter table public.posts add column if not exists is_official boolean not null default false;

-- posts는 컬럼 단위로만 읽기 권한을 주고 있으므로(board.sql 참고) 새 컬럼도 따로 열어줘야 한다.
-- 이게 없으면 방문자가 is_official을 읽지 못해 "운영자" 배지와 운영자 가이드 구역이 나오지 않는다.
grant select (is_official) on public.posts to anon, authenticated;

-- ------------------------------------------------------------
-- 방문자(anon/authenticated)는 is_official을 정할 수 없다.
--
-- 지금도 anon/authenticated에는 posts의 insert/update 권한이 아예 없고, 글 작성·수정은
-- api/board/*.js가 service_role 키로만 한다 (create.js·update.js는 is_official을 보내지 않으므로
-- 새 글은 기본값 false, 수정해도 값이 바뀌지 않는다). 아래 트리거와 정책은 나중에 anon에게
-- 쓰기 권한이 생기더라도 뚫리지 않게 하는 이중 잠금이다.
-- ------------------------------------------------------------

-- 1) 트리거: 방문자 역할로 들어온 쓰기는 is_official을 무시한다.
--    insert면 항상 false, update면 기존 값을 그대로 둔다 (true로 올릴 수도, 운영자 글을 false로 내릴 수도 없다).
--    PostgREST는 요청마다 역할을 anon/authenticated/service_role로 바꾸므로 current_user로 구분된다.
--    대시보드(postgres)와 service_role은 그대로 통과한다.
create or replace function public.posts_guard_is_official()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.is_official := false;
    else
      new.is_official := old.is_official;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_guard_is_official on public.posts;
create trigger posts_guard_is_official
  before insert or update on public.posts
  for each row execute function public.posts_guard_is_official();

-- 2) RLS 정책: is_official=true인 행은 방문자 역할의 insert/update 결과가 될 수 없다.
--    restrictive라서 다른 (permissive) 정책이 허용하더라도 이 조건을 반드시 함께 만족해야 한다.
drop policy if exists "posts: anon cannot insert official" on public.posts;
create policy "posts: anon cannot insert official"
  on public.posts as restrictive for insert
  to anon, authenticated
  with check (is_official = false);

drop policy if exists "posts: anon cannot update official" on public.posts;
create policy "posts: anon cannot update official"
  on public.posts as restrictive for update
  to anon, authenticated
  using (true)
  with check (is_official = false);

-- 운영자 글 지정 예시 (대시보드 SQL Editor에서):
--   update public.posts set is_official = true where id = '<글 id>';
