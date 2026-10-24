// 통화 기록 저장 (bun:sqlite). 보관 기간이 지나면 서버 시작 때 지운다. 음성 원본은 저장하지 않는다(자막·근거·리뷰만). (§13, §16)
import { Database } from 'bun:sqlite';
import type { CallState } from '@eary/schema';

export class CallRecords {
  private db: Database;
  constructor(path: string, private readonly retentionDays: number) {
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`CREATE TABLE IF NOT EXISTS calls (
      call_id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, title TEXT, risk TEXT,
      review TEXT, utterances TEXT, evidence TEXT, saved_at INTEGER)`);
    this.purge();
  }

  get retention() {
    return this.retentionDays;
  }

  save(s: CallState) {
    if (!s.review) return;
    this.db.query(`INSERT OR REPLACE INTO calls VALUES ($id, $start, $end, $title, $risk, $review, $utts, $ev, $now)`).run({
      $id: s.callId, $start: s.startedAt ?? null, $end: s.review.endedAt, $title: s.review.title, $risk: s.risk.level,
      $review: JSON.stringify(s.review),
      $utts: JSON.stringify(s.utteranceOrder.map((id) => s.utterances[id]).filter((u) => u && u.status !== 'interim').map((u) => ({ id: u!.id, speaker: u!.speaker, startMs: u!.startMs, text: u!.text, tags: u!.tags }))),
      $ev: JSON.stringify(Object.values(s.evidence)),
      $now: Date.now(),
    });
  }

  delete(callId: string): boolean {
    return this.db.query('DELETE FROM calls WHERE call_id = ?').run(callId).changes > 0;
  }

  list(limit = 20): { call_id: string; started_at: string; title: string; risk: string }[] {
    return this.db.query('SELECT call_id, started_at, title, risk FROM calls ORDER BY saved_at DESC LIMIT ?').all(limit) as never;
  }

  has(callId: string) {
    return Boolean(this.db.query('SELECT 1 FROM calls WHERE call_id = ?').get(callId));
  }

  purge() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    return this.db.query('DELETE FROM calls WHERE saved_at < ?').run(cutoff).changes;
  }
}
