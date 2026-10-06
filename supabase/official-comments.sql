-- ============================================================
-- 운영자 댓글 표시 (comments.is_official)
-- Supabase SQL Editor에서 한 번 실행. 여러 번 실행해도 안전하다.
--
-- 실행 전에도 사이트는 그대로 동작한다: 댓글은 정상 표시되고, 운영자 키로 쓴 댓글은
-- 표시 없이 일반 댓글로 저장된다. 실행한 뒤부터 운영자 키로 쓴 댓글 닉네임 뒤에 인증 체크가 붙는다.
-- posts 쪽은 supabase/official-posts.sql.
-- ============================================================

alter table public.comments add column if not exists is_official boolean not null default false;

-- comments도 컬럼 단위로만 읽기 권한을 주고 있으므로(board.sql 참고) 새 컬럼을 따로 열어준다.
grant select (is_official) on public.comments to anon, authenticated;

-- 방문자(anon/authenticated) 역할로 들어온 쓰기는 is_official을 무시한다.
-- insert면 항상 false, update면 기존 값을 그대로 둔다. 대시보드(postgres)와 service_role은 통과한다.
-- (지금도 방문자에게는 comments 쓰기 권한이 없다 — 나중에 생기더라도 뚫리지 않게 하는 이중 잠금이다.)
create or replace function public.comments_guard_is_official()
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

drop trigger if exists comments_guard_is_official on public.comments;
create trigger comments_guard_is_official
  before insert or update on public.comments
  for each row execute function public.comments_guard_is_official();

-- restrictive라서 다른 (permissive) 정책이 허용하더라도 이 조건을 반드시 함께 만족해야 한다.
drop policy if exists "comments: anon cannot insert official" on public.comments;
create policy "comments: anon cannot insert official"
  on public.comments as restrictive for insert
  to anon, authenticated
  with check (is_official = false);

drop policy if exists "comments: anon cannot update official" on public.comments;
create policy "comments: anon cannot update official"
  on public.comments as restrictive for update
  to anon, authenticated
  using (true)
  with check (is_official = false);
