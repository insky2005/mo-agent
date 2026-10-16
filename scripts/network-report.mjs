import os from 'node:os';
import { localIPv4List } from '../host/http.mjs';
import { candidateAddresses } from '../host/pairing.mjs';
console.log('=== os.networkInterfaces() 里的 IPv4 ===');
const all = os.networkInterfaces();
for (const name of Object.keys(all)) {
  for (const i of all[name]) {
    if (i.family === 'IPv4') console.log('  ' + name.padEnd(10), i.address.padEnd(18), 'internal=' + i.internal);
  }
}
console.log('=== localIPv4List()（非 internal）===');
console.log(JSON.stringify(localIPv4List()));
console.log('=== candidateAddresses()（排序后，第一个会写进二维码）===');
console.log(JSON.stringify(candidateAddresses(localIPv4List())));
console.log('=== en0 是否在列表里 ===');
console.log(localIPv4List().some(a => a.address === '192.0.2.10') ? '是' : '否 —— 二维码会写错地址！');