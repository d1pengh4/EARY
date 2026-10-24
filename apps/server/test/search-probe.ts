// bun apps/server/test/search-probe.ts "국민건강보험공단 미환급금 앱 설치"
import { createProviders, readPage, WebSearch } from '../src/search';
const ws = new WebSearch(createProviders(process.env));
console.log('enabled:', ws.enabledNames.join(', '));
const r = await ws.search(process.argv[2] ?? '보이스피싱 검찰 사칭', (m, from) => console.log(`  +${from} → ${m.length} merged`), 10_000); // 확인용: 끝까지 기다림
console.log(`total ${r.ms.toFixed(0)}ms`, JSON.stringify(r.perProvider));
for (const h of r.merged.slice(0, 6)) console.log(` [${h.tier}] ${h.score.toFixed(1)} ${h.title} — ${h.host} (${h.providers})\n     ${h.snippet.slice(0, 100)}`);
if (r.merged[0]) { const p = await readPage(r.merged[0].url, process.argv[2] ?? '보이스피싱'); console.log('read:', 'error' in p ? p.error : `${p.title}\n${p.text.slice(0, 300)}`); }
process.exit(0);
