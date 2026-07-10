import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'education-auth-'));
  const generated = path.join(root, 'generated');
  const auth = path.join(root, 'auth');
  await fs.mkdir(generated);
  await fs.mkdir(auth);
  await fs.writeFile(path.join(generated, 'runtime-courses.json'), JSON.stringify([
    {slug: 'secure-course', title: '보호 수업', access: 'protected', availableFrom: null, availableUntil: null},
    {slug: 'future-course', title: '예정 수업', access: 'public', availableFrom: '2999-01-01T00:00:00+09:00', availableUntil: null},
  ]));
  const hash = await bcrypt.hash('class-password', 4);
  await fs.writeFile(path.join(auth, 'secure-course.htpasswd'), `student:${hash}\n`);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'auth-server.mjs')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      GENERATED_DIR: generated,
      AUTH_PATH: auth,
      AUTH_PORT: String(port),
      SESSION_SECRET: 'test-secret-with-at-least-thirty-two-characters',
      SESSION_TTL_HOURS: '12',
      SESSION_COOKIE_SECURE: 'auto',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill();
    return fs.rm(root, {recursive: true, force: true});
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('인증 서버 시작 시간 초과')), 5000);
    child.once('exit', (code) => reject(new Error(`인증 서버 조기 종료: ${code}`)));
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('인증 서비스가')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return `http://127.0.0.1:${port}`;
}

test('로그인 한 번으로 보호 수업 세션을 발급하고 확인한다', async (t) => {
  const base = await startServer(t);
  assert.equal((await fetch(`${base}/check/secure-course`)).status, 401);
  const deniedEntry = await fetch(`${base}/enter/secure-course`, {redirect: 'manual'});
  assert.equal(deniedEntry.status, 302);
  assert.equal(deniedEntry.headers.get('location'), '/login/secure-course?next=%2Fcourses%2Fsecure-course%2F');
  assert.equal((await fetch(`${base}/login/secure-course?next=/courses/secure-course/`)).status, 200);

  const failed = await fetch(`${base}/login/secure-course`, {
    method: 'POST',
    body: new URLSearchParams({password: 'wrong', next: '/courses/secure-course/'}),
    redirect: 'manual',
  });
  assert.equal(failed.status, 401);

  const login = await fetch(`${base}/login/secure-course`, {
    method: 'POST',
    body: new URLSearchParams({password: 'class-password', next: '/courses/secure-course/materials/all.zip'}),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/courses/secure-course/materials/all.zip');
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /education_session_secure-course=/);
  assert.match(cookie, /HttpOnly/);
  assert.doesNotMatch(cookie, /Max-Age/);
  assert.equal((await fetch(`${base}/check/secure-course`, {headers: {Cookie: cookie.split(';')[0]}})).status, 204);
  const allowedEntry = await fetch(`${base}/enter/secure-course`, {
    headers: {Cookie: cookie.split(';')[0]},
    redirect: 'manual',
  });
  assert.equal(allowedEntry.headers.get('location'), '/courses/secure-course/');

  const logout = await fetch(`${base}/logout/secure-course`, {
    headers: {Cookie: cookie.split(';')[0]},
    redirect: 'manual',
  });
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), '/login/secure-course');
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(logout.headers.get('clear-site-data'), '"cache"');
});

test('배포 시작 전에는 공개 수업도 차단한다', async (t) => {
  const base = await startServer(t);
  assert.equal((await fetch(`${base}/check/future-course`)).status, 403);
  const status = await fetch(`${base}/status/future-course`);
  assert.equal(status.status, 403);
  assert.match(await status.text(), /아직 배포 기간이 시작되지 않았습니다/);
});
