'use strict';
// Quick multi-account sanity check for the vault (no Electron needed).
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Vault } = require('../electron/vault');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanguard-'));
const v = new Vault(dir, null);
v.create('test-master');

const a = v.upsertAccount({ label: 'Main', username: 'alpha', password: 'p1' });
console.log('after add 1:', a.length, a.map((x) => x.label));
const b = v.upsertAccount({ label: 'Smurf', username: 'bravo', password: 'p2' });
console.log('after add 2:', b.length, b.map((x) => x.label));
const c = v.upsertAccount({ label: 'Third', username: 'charlie', password: 'p3' });
console.log('after add 3:', c.length, c.map((x) => x.label));

const ids = new Set(c.map((x) => x.id));
const pass = c.length === 3 && ids.size === 3;
console.log(pass ? 'PASS: 3 distinct accounts' : 'FAIL: accounts collapsed/overwritten');

// edit one
const first = c[0];
const edited = v.upsertAccount({ id: first.id, label: 'Main (edited)' });
console.log('after edit:', edited.length, edited.find((x) => x.id === first.id).label);
console.log(edited.length === 3 ? 'PASS: edit kept count' : 'FAIL: edit changed count');

// Regression: renderer sends `id: undefined` explicitly — must not collapse.
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vanguard2-'));
const v2 = new Vault(dir2, null);
v2.create('m');
v2.upsertAccount({ id: undefined, label: 'A', username: 'a', password: 'x', region: '' });
const r2 = v2.upsertAccount({ id: undefined, label: 'B', username: 'b', password: 'y', region: '' });
console.log('undefined-id case:', r2.length, r2.map((x) => x.label), 'ids-distinct=' + (new Set(r2.map((x) => x.id)).size === r2.length));
console.log(r2.length === 2 && r2.every((x) => x.id) ? 'PASS: undefined id does not overwrite' : 'FAIL: overwrite regression');
fs.rmSync(dir2, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
