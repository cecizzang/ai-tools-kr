-- ============================================================
-- advisor_logs — AI 툴 추천 상담사(api/advisor/ask.js) 사용 기록.
--
-- 용도 두 가지:
--   1) 일일 한도 집계 (IP당 / 사이트 전체) — 비용 폭탄 방지
--   2) 방문자가 실제로 뭘 찾는지 보기 (어떤 툴을 새로 등록할지 참고)
--
-- IP는 원문 대신 HMAC 해시(board와 같은 IP_HASH_SECRET)만 저장한다.
-- 방문자는 읽지도 쓰지도 못하고, 서버(service_role)만 접근한다.
-- ============================================================

create table if not exists public.advisor_logs (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  question text not null check (char_length(question) <= 300),
  status text not null check (status in ('ok', 'error')),
  picked_tool_ids uuid[],
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);

create index if not exists advisor_logs_created_at_idx on public.advisor_logs(created_at desc);
create index if not exists advisor_logs_ip_hash_created_at_idx on public.advisor_logs(ip_hash, created_at desc);

alter table public.advisor_logs enable row level security;
-- anon/authenticated용 정책을 일부러 만들지 않는다 → 방문자는 접근 불가.

grant select, insert on public.advisor_logs to service_role;
