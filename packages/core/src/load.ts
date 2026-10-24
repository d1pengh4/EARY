// 서버·테스트 전용: data/ 아래 YAML 팩을 읽는다. 브라우저 번들에는 들어가지 않는다(index.ts에서 내보내지 않음).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { BoardTemplate, DomainPack, Lexicon, Packs } from './packs';

export function loadPacks(dataDir: string): Packs {
  const lexicon = parse(readFileSync(join(dataDir, 'lexicon/risk.yaml'), 'utf8')) as Lexicon;
  const domains = {} as Packs['domains'];
  const templates: Packs['templates'] = {};
  for (const dir of readdirSync(join(dataDir, 'domains'))) {
    const base = join(dataDir, 'domains', dir);
    for (const f of readdirSync(base)) {
      const doc = parse(readFileSync(join(base, f), 'utf8'));
      if (f === 'pack.yaml') domains[(doc as DomainPack).id] = doc as DomainPack;
      else if (f.startsWith('board.')) { const t = doc as BoardTemplate; templates[t.id] = { ...t, slots: t.slots ?? {}, relations: t.relations ?? [] }; }
    }
  }
  return { lexicon, domains, templates };
}

export function loadYaml<T>(path: string): T {
  return parse(readFileSync(path, 'utf8')) as T;
}
