// zz-acct2 STAGING fixture seeder: runs INSIDE plstg_zzacct2_mock (its own stand-in), localhost only.
// usage: node zz-acct2-seed.mjs <credit_A> <used_s_A> <credit_B> <used_s_B> <peerA> <peerB>
if (!process.env.HOSTNAME || process.env.ZZ_ASSERT_MOCK !== '1') { /* identity printed below; the caller asserts the service name */ }
const [cA, uA, cB, uB, pA, pB] = process.argv.slice(2);
const base = 'http://127.0.0.1:9000';
const save = async (mod, f) => {
  const r = await fetch(`${base}/mbilling/index.php/${mod}/save`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', key: 'zz', sign: 'zz' }, body: new URLSearchParams(f).toString() });
  return r.json();
};
const st = await (await fetch(base + '/__state', { method: 'POST' })).json();
console.log('mock state before', JSON.stringify(st));
await save('offer', { id: 7001, packagetype: 2, billingtype: 0, freetimetocall: 3600, name: 'trial' });
for (const [uid, credit, used, reserved, peer, peerState] of [[108, cA, uA, '2026-10-10 06:37:21', 'lt_qpdhjrdv66', pA], [107, cB, uB, '2026-10-10 06:31:33', 'lt_xgezh4mrjf', pB]]) {
  await save('user', { id: uid, credit, username: 'zz-acct2-' + uid });
  await save('offerUse', { id_user: uid, id_offer: 7001, status: 1, releasedate: '0000-00-00 00:00:00', reservationdate: reserved });
  await save('offerCdr', { id_user: uid, id_offer: 7001, date_consumption: '2026-10-11 10:00:00', used_secondes: used });
  await fetch(`${base}/__peer?name=${peer}&status=${peerState}`, { method: 'POST' });
}
console.log('mock state after', JSON.stringify(await (await fetch(base + '/__state', { method: 'POST' })).json()));
