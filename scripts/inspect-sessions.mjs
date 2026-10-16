import { DshClient } from '../adapters/dsh.mjs';
import { createLogger } from '../host/log.mjs';
const dsh = new DshClient({ log: createLogger('warn') });
const value = await dsh.listSessions();
const items = (value.items || []).filter(i => String((i.projections && i.projections.values && i.projections.values.title) || '').includes('工作状态通知'));
for (const it of items) {
  console.log('=== ' + it.sessionId.slice(0, 20) + ' ===');
  console.log(JSON.stringify(it, (k, v) => (k === 'projections' ? '[省略]' : v), 1).slice(0, 900));
  const v = (it.projections && it.projections.values) || {};
  console.log('projections 里的键:', Object.keys(v).join(','));
  console.log('sessionListMetadata:', JSON.stringify(v.sessionListMetadata));
}
process.exit(0);