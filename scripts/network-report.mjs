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
console.log('=== 会被写进二维码的前 3 个地址 ===');
for (const item of candidateAddresses(localIPv4List()).slice(0, 3)) {
  console.log('  ' + item.address + '  (' + item.name + ')');
}