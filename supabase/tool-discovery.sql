-- ============================================================
-- tools 테이블 확장 — 해외 AI 툴 자동 발굴 크론(api/cron/discover-tools.js)이
-- service_role 키로 후보를 채워넣을 수 있게 한다.
--
-- 자동으로 들어온 행은 is_published=false로 삽입되므로, 사람이 Supabase
-- Table Editor(postgres 권한, RLS 우회)에서 검토하고 is_published를 true로
-- 바꾸기 전까지는 site(tools.html)에 절대 노출되지 않는다.
-- 기존 "수동 큐레이션" 원칙은 그대로 유지되고, 이 자동화는 후보만 만든다.
-- ============================================================

alter table public.tools add column if not exists source text not null default 'manual'
  check (source in ('manual', 'auto'));

-- 검토 대기 중인 자동 후보만 빠르게 필터링하기 위한 인덱스
-- (Supabase Table Editor에서 source=eq.auto&is_published=eq.false 로 필터링).
create index if not exists tools_source_is_published_idx on public.tools(source, is_published);

-- service_role은 RLS를 우회하지만, 다른 테이블들과 동일하게(board.sql/schema.sql 9,10번
-- 섹션 참고) 명시적 GRANT가 없으면 "permission denied"가 난다. 크론은 중복 체크를 위해
-- 기존 tools를 읽어야 하고(select), 새 후보를 넣어야 한다(insert).
grant select, insert, update, delete on public.tools to service_role;
