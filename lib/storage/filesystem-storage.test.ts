import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createFilesystemStorage, parseObjectKey, verifyUploadToken } from './filesystem-storage';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ycode-storage-'));
  process.env.STORAGE_DIR = root;
  process.env.STORAGE_PUBLIC_URL = 'https://app.example.com';
  process.env.STORAGE_SIGNING_SECRET = 'test-secret';
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('upload, download, public URL and remove', async () => {
  const bucket = createFilesystemStorage(null).from('assets');

  const uploaded = await bucket.upload('images/logo.svg', Buffer.from('<svg/>'), { contentType: 'image/svg+xml' });
  assert.equal(uploaded.error, null);
  assert.equal(uploaded.data?.path, 'images/logo.svg');
  assert.ok(existsSync(path.join(root, 'objects', 'assets', 'images', 'logo.svg')));

  const downloaded = await bucket.download('images/logo.svg');
  assert.equal(downloaded.data?.type, 'image/svg+xml');
  assert.equal(await downloaded.data?.text(), '<svg/>');

  assert.equal(
    bucket.getPublicUrl('images/logo.svg').data.publicUrl,
    'https://app.example.com/ycode/storage/assets/images/logo.svg',
  );

  const removed = await bucket.remove(['images/logo.svg', 'images/missing.png']);
  assert.deepEqual(removed.data, [{ name: 'images/logo.svg' }]);
  assert.equal((await bucket.download('images/logo.svg')).error?.statusCode, '404');
});

test('blobs keep their type and existing files need upsert', async () => {
  const bucket = createFilesystemStorage(null).from('assets');
  const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });

  assert.equal((await bucket.upload('import.csv', blob)).error, null);
  assert.equal((await bucket.download('import.csv')).data?.type, 'text/csv');

  const conflict = await bucket.upload('import.csv', blob);
  assert.equal(conflict.error?.statusCode, '409');
  assert.equal((await bucket.upload('import.csv', 'x', { upsert: true })).error, null);
});

test('tenants are isolated by key prefix', async () => {
  const a = createFilesystemStorage(TENANT_A).from('assets');
  const b = createFilesystemStorage(TENANT_B).from('assets');

  await a.upload('photo.png', Buffer.from('a'));
  assert.ok(existsSync(path.join(root, 'objects', 'assets', TENANT_A, 'photo.png')));
  assert.match(a.getPublicUrl('photo.png').data.publicUrl, new RegExp(`/ycode/storage/assets/${TENANT_A}/photo.png$`));

  assert.equal((await b.download('photo.png')).error?.statusCode, '404');
  assert.deepEqual((await b.remove(['photo.png'])).data, []);
  assert.equal((await a.download('photo.png')).error, null, 'tenant B could not remove it');
});

test('path traversal is rejected', async () => {
  const bucket = createFilesystemStorage(TENANT_A).from('assets');

  const escaped = await bucket.upload(`../${TENANT_B}/photo.png`, Buffer.from('x'));
  assert.ok(escaped.error);
  assert.ok((await bucket.download('../../../etc/passwd')).error);
  assert.throws(() => createFilesystemStorage(null).from('..'));

  assert.equal(parseObjectKey('assets/../secret'), null);
  assert.equal(parseObjectKey('assets'), null);
  assert.deepEqual(parseObjectKey('assets/a/b.png'), ['assets', 'a', 'b.png']);
});

test('signed upload tokens are bound to the key and expire', async () => {
  const bucket = createFilesystemStorage(TENANT_A).from('assets');
  const signed = await bucket.createSignedUploadUrl('imports/data.csv');
  assert.equal(signed.error, null);

  const token = new URL(signed.data!.signedUrl).searchParams.get('token');
  const key = `assets/${TENANT_A}/imports/data.csv`;
  assert.ok(verifyUploadToken(key, token));
  assert.equal(verifyUploadToken(`assets/${TENANT_B}/imports/data.csv`, token), false, 'other key');
  assert.equal(verifyUploadToken(key, `${token}x`), false, 'tampered');
  assert.equal(verifyUploadToken(key, `${Date.now() - 1}.${token!.split('.')[1]}`), false, 'expired');
  assert.equal(verifyUploadToken(key, null), false);
});
