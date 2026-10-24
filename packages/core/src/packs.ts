// 도메인 팩·템플릿 타입. 파일 읽기는 서버가 하고, core는 파싱된 객체만 받는다(브라우저에서도 import 가능하게).
import type { EntityType, SignalCategory, Suggestion } from '@eary/schema';

export interface GazetteerOrg { canon: string; aliases: string[]; kind: string }

export interface DomainPack {
  id: 'impersonation' | 'billing' | 'general';
  label: string;
  jev: string;
  gate?: SignalCategory[];
  gazetteer: { org: GazetteerOrg[]; title?: string[]; product?: string[] };
  patterns: Partial<Record<'person' | 'case' | 'account_me' | 'account_safe' | 'amount' | 'duration' | 'date', string>>;
  suggestions: (Suggestion & {
    unless?: { entityType?: EntityType };
    requires?: { signal?: SignalCategory[]; orgKind?: string[] };
  })[];
  board: string;
  verify: string[];
}

export interface LexiconEntry { category: SignalCategory; strength: number; patterns: string[] }
export interface Lexicon { signals: LexiconEntry[] }

export interface Rect { x: number; y: number; w: number; h: number }
export interface TemplateSlot extends Rect {
  match: { type: EntityType };
  label: string;
  style?: 'me';
  mono?: boolean;
}
export interface TemplateZone extends Rect { cell?: { w: number; h: number }; gap?: number; cols?: number; /** 이 구역이 받는 엔티티 타입 (없으면 전부) */ types?: EntityType[] }
export interface BoardTemplate {
  id: string;
  title: string;
  size: { w: number; h: number };
  slots: Record<string, TemplateSlot>;
  zones: Record<string, TemplateZone>;
  relations: { from: string; to: string; label: string }[];
}

export interface Packs {
  lexicon: Lexicon;
  domains: Record<DomainPack['id'], DomainPack>;
  templates: Record<string, BoardTemplate>;
}
