# 상태 메모 (2026-09-23 기준)

## 반영된 것 (배포 완료)
- `api/cron/discover-tools.js`: 해외 신규 AI 툴 자동 발굴 크론 (매주 월요일 낮 12시 KST 실행)
  - 기존 `tools` 테이블과 중복 체크 후 Claude(Haiku)+web_search로 최대 5개 후보 제안
  - `is_published=false`, `source='auto'`로 삽입 → Supabase Table Editor에서 사람이 검토 후 발행해야 사이트에 노출
  - `supabase/tool-discovery.sql` 마이그레이션 이미 실행함 (`source` 컬럼/인덱스/grant 추가)
  - Vercel 환경변수(`ANTHROPIC_API_KEY`, `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) 전부 확인 완료
- `robots.txt` / `sitemap.xml` 추가 (기본 5개 페이지만 등록, 개별 게시글은 미포함)
- 회사 소식(`company_updates`)은 기존 5개사(Anthropic/OpenAI/Google/Meta/Mistral) 그대로 유지하기로 결정 — xAI/DeepSeek/Perplexity 추가했다가 되돌림

## 2026-09-23 discover-tools 수정 + 첫 테스트
- 버그 수정 (ad64875): `tool_choice`를 propose_tools로 강제하면 web_search가 실행되지 않던 문제
  → `auto` + pause_turn 이어받기 + propose_tools 재촉, 요청별 `web_search_requests` 로그,
  AbortController 타임아웃 (30초 이후 새 요청 금지, 52초에 진행 중 요청 중단)
- 테스트 (9/23 13:13 KST, Vercel 대시보드 Cron Jobs → Run)
  - 요청 1회: `stop_reason=tool_use web_search_requests=5 input_tokens=59170 output_tokens=1228 elapsed=16913ms` → 60초 한도 안에 여유 있게 끝남
  - inserted 3 (Fathom, Veo, Lovable) / skipped 0 / failed 0
- 검토 결과
  - Fathom: 발행 (description 수동으로 줄임)
  - Lovable: 발행 (korean full → partial, UI는 영어 / description 줄임)
  - Veo: 삭제 — Gemini 안의 모델이지 독립 툴이 아님. URL(gemini.google.com/app)이 기존 Gemini와 사실상 같은데 중복 체크를 통과함
  - 발행한 2개는 last_checked를 수동으로 오늘 날짜로 입력
  - 3개 모두 이미 유명한 툴이라 "최근 신규 툴 발굴" 목적과 안 맞음
- 위 결과를 바탕으로 한 후속 수정
  - 프롬프트: 최근 3개월 내 출시·주요 업데이트 툴 우선, 빅테크 본체 서비스·모델 자체(ChatGPT, Gemini, Veo 등) 제외
  - description: 40자 안팎 한 문장, `is_published=true` + `source='manual'` 툴의 description을 예시로 프롬프트에 넣음 (자동 문구가 예시로 재사용되며 톤이 틀어지는 것 방지)
  - 중복 체크: URL을 호스트 기준으로 비교 (하위 경로 무시 → gemini.google.com/app도 Gemini와 중복 처리). github.com, huggingface.co 같은 공용 호스트는 경로 앞 2단계까지 비교
  - 삽입 시 `last_checked`를 오늘 날짜(KST)로 채움

## 다음 할 일
1. 다음 월요일 자동 실행 결과 확인 — 신규 툴 위주로 나오는지, 빅테크 모델이 걸러지는지, description 길이가 맞는지
2. 그 다음 순서였던 "사이트 관리용 자동화"는 아직 미착수
3. (검토) 개별 게시글까지 포함하는 동적 sitemap 필요한지 나중에 판단
