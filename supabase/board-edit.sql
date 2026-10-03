-- ============================================================
-- 게시판 글 수정 (api/board/update.js)
-- Supabase SQL Editor에서 한 번 실행. 여러 번 실행해도 안전하다.
-- 이걸 실행하기 전에는 글 수정이 "수정 실패"로 끝난다 (글 보기는 그대로 동작).
-- ============================================================

-- 수정 시각. 한 번도 수정 안 한 글은 null — post.html은 값이 있으면 "(수정됨)"을 붙인다.
alter table public.posts add column if not exists updated_at timestamptz;

-- posts는 컬럼 단위로만 읽기 권한을 주고 있으므로(board.sql 참고) 새 컬럼도 따로 열어줘야 한다.
grant select (updated_at) on public.posts to anon, authenticated;

-- 수정 시도 기록 — IP 기준 레이트리밋용 (1분에 5번).
-- 수정은 posts에 새 행을 만들지 않아서 create.js처럼 "이 IP의 최근 글"로는 셀 수 없고,
-- 비밀번호가 틀린 시도까지 세야 비밀번호 추측을 늦출 수 있어서 따로 둔다.
create table if not exists public.board_edit_attempts (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists board_edit_attempts_ip_hash_created_at_idx
  on public.board_edit_attempts(ip_hash, created_at desc);

-- 브라우저(anon)에서는 읽기도 쓰기도 못 한다. api/board/update.js만 service_role로 접근.
alter table public.board_edit_attempts enable row level security;
revoke all on public.board_edit_attempts from anon, authenticated;
grant select, insert, delete on public.board_edit_attempts to service_role;

-- (선택) 오래된 시도 기록 정리 — 레이트리밋은 최근 1분만 보므로 언제 지워도 된다.
-- delete from public.board_edit_attempts where created_at < now() - interval '1 day';
