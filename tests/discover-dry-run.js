// 발굴 크론을 DB 쓰기 없이 한 번 돌려 본다 (tools 조회 + Claude 호출만 실제로 한다).
// 실행: node --env-file=.env.local tests/discover-dry-run.js
import { runDiscovery } from '../api/cron/discover-tools.js';

const missing = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`환경변수 없음: ${missing.join(', ')}`);
  process.exit(1);
}

const run = await runDiscovery({ dryRun: true });
console.log(JSON.stringify(run, null, 2));
