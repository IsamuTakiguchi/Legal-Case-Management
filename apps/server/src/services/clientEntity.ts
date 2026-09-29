import { eq } from 'drizzle-orm';
import { looksLikeCorporation } from '@lcm/shared';
import { db, schema } from '../db/index.js';
import { getSyncState, setSyncState } from './settings.js';

/**
 * 個人・法人の区分を入れる前から登録してあった依頼者のうち、名前が法人らしいもの（株式会社〇〇 など）を法人にする。
 * 一度だけ行う（あとから画面で個人に戻したものを、起動のたびに法人へ戻さない）
 */
export function backfillClientEntityTypes(): number {
  const key = 'cleanup:client_entity_type';
  if (getSyncState(key)) return 0;
  let n = 0;
  for (const c of db().select({ id: schema.clients.id, name: schema.clients.name, entityType: schema.clients.entityType }).from(schema.clients).all()) {
    if (c.entityType === 'individual' && looksLikeCorporation(c.name)) {
      db().update(schema.clients).set({ entityType: 'corporation' }).where(eq(schema.clients.id, c.id)).run();
      n++;
    }
  }
  setSyncState(key, new Date().toISOString());
  return n;
}
