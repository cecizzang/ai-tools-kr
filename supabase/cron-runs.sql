-- ============================================================
-- cron_runs — 크론 실행 결과 요약 기록.
-- 지금은 api/cron/discover-tools.js가 회차마다 한 행씩 남긴다:
-- 후보 수(proposed), 추가 수(inserted), 후보별 결과와 사유(results).
--
-- 이 테이블이 없어도 크론은 경고 로그만 남기고 그대로 동작한다.
-- ============================================================

create table if not exists public.cron_runs (
  id bigint generated always as identity primary key,
  job text not null,
  ran_at timestamptz not null default now(),
  proposed integer not null default 0,
  inserted integer not null default 0,
  -- { "categories": [{ "category", "status": "ok|skipped|error", "reason", "proposed", "requests",
  --                    "webSearches", "inputTokens", "outputTokens" }],
  --   "candidates": [{ "category", "name", "url", "evidence",
  --                    "result": "inserted|duplicate|invalid|insert_error|over_limit", "reason" }] }
  results jsonb not null default '[]'::jsonb,
  -- 후보를 못 받은 카테고리(시간 부족으로 생략 / 요청 실패) 요약, 또는 회차 전체가 실패했을 때의 에러 메시지
  error text
);

create index if not exists cron_runs_job_ran_at_idx on public.cron_runs(job, ran_at desc);

-- 방문자는 접근 불가 — 정책 없이 RLS만 켜 두고, service_role에만 명시적으로 권한을 준다
-- (tool-discovery.sql과 같은 이유: GRANT가 없으면 service_role도 "permission denied").
alter table public.cron_runs enable row level security;
revoke all on public.cron_runs from anon, authenticated;
grant select, insert on public.cron_runs to service_role;
