import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const script = path.join(projectRoot, 'scripts', 'prepare-content.mjs');

async function fixture({slug = 'course-one', access = 'public', malformed = false, config = {}} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'education-web-'));
  const courses = path.join(root, 'courses');
  const auth = path.join(root, 'auth');
  const course = path.join(courses, slug);
  await fs.mkdir(path.join(course, 'docs'), {recursive: true});
  await fs.mkdir(path.join(course, 'materials'), {recursive: true});
  await fs.mkdir(path.join(course, 'code'), {recursive: true});
  await fs.mkdir(auth, {recursive: true});
  await fs.writeFile(
    path.join(course, 'course.json'),
    malformed ? '{bad json' : JSON.stringify({title: '테스트 수업', description: '설명', order: 1, access, ...config}),
  );
  await fs.writeFile(path.join(course, 'docs', 'intro.md'), '---\nslug: /unsafe\ntitle: 소개\n---\n\n본문');
  await fs.writeFile(path.join(course, 'docs', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(path.join(course, 'materials', 'lecture.txt'), 'material');
  await fs.writeFile(path.join(course, 'materials', '전체자료.zip'), 'zip');
  await fs.writeFile(path.join(course, 'materials', 'README.txt'), '운영자용 폴더 안내');
  await fs.writeFile(path.join(course, 'code', 'hello.py'), 'print("hello")');
  if (access === 'protected') {
    await fs.writeFile(
      path.join(auth, `${slug}.htpasswd`),
      'student:$2y$05$123456789012345678901uHh1F7Vb1mYOfE7pIzRzYHkP8mP5xSaa\n',
    );
  }
  return {root, courses, auth, course};
}

async function run(paths) {
  const generated = path.join(paths.root, 'generated');
  const nginx = path.join(paths.root, 'nginx.conf');
  const result = await execFileAsync(process.execPath, [script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      COURSES_PATH: paths.courses,
      AUTH_PATH: paths.auth,
      GENERATED_DIR: generated,
      STATIC_DIR: path.join(paths.root, 'static'),
      NGINX_CONFIG_PATH: nginx,
      SITE_ROOT: '/srv/site',
    },
  });
  return {generated, nginx, ...result};
}

test('공개 및 보호 수업 설정을 안전한 경로로 생성한다', async (t) => {
  const publicPaths = await fixture();
  t.after(() => fs.rm(publicPaths.root, {recursive: true, force: true}));
  const publicResult = await run(publicPaths);
  const publicNginx = await fs.readFile(publicResult.nginx, 'utf8');
  assert.match(publicNginx, /location \^~ \/courses\/course-one\/materials\//);
  assert.doesNotMatch(publicNginx, /auth_basic/);
  assert.equal((publicNginx.match(/auth_request \/_auth\/course-one/g) || []).length, 4);
  const generatedDoc = await fs.readFile(
    path.join(publicResult.generated, 'docs', 'course-one', 'intro.md'), 'utf8',
  );
  assert.doesNotMatch(generatedDoc, /slug: \/unsafe/);
  assert.equal(
    await fs.readFile(path.join(publicResult.generated, 'docs', 'course-one', 'diagram.svg'), 'utf8'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );

  const protectedPaths = await fixture({slug: 'secure-course', access: 'protected'});
  t.after(() => fs.rm(protectedPaths.root, {recursive: true, force: true}));
  const protectedResult = await run(protectedPaths);
  const protectedNginx = await fs.readFile(protectedResult.nginx, 'utf8');
  assert.match(protectedNginx, /location @login_secure_course/);
  assert.match(protectedNginx, /location \^~ \/enter\//);
  assert.equal((protectedNginx.match(/auth_request \/_auth\/secure-course/g) || []).length, 4);
  assert.equal((protectedNginx.match(/Cache-Control "private, no-store, max-age=0"/g) || []).length, 4);
  const catalog = await fs.readFile(path.join(protectedResult.generated, 'docs', 'index.md'), 'utf8');
  assert.match(catalog, /href="\/enter\/secure-course"/);
});

test('배포 기간, 과제 제출 링크, QR과 다운로드 카드를 생성한다', async (t) => {
  const paths = await fixture({
    config: {
      availableFrom: '2026-07-20T09:00:00+09:00',
      availableUntil: '2026-07-31T18:00:00+09:00',
      submissions: [{
        title: '실습 과제',
        description: 'ZIP 파일로 제출하세요.',
        url: 'https://submit.example.com/form',
        deadline: '2026-07-30T23:59:59+09:00',
        showQr: true,
      }],
    },
  });
  t.after(() => fs.rm(paths.root, {recursive: true, force: true}));
  const result = await run(paths);
  const index = await fs.readFile(path.join(result.generated, 'docs', 'course-one', 'index.md'), 'utf8');
  assert.match(index, /전체자료\.zip/);
  assert.match(index, /download-card/);
  assert.doesNotMatch(index, /README\.txt/);
  assert.match(index, /과제 제출/);
  assert.match(index, /https:\/\/submit\.example\.com\/form/);
  assert.match(index, /generated-submission-assets\/course-one\/qr-1\.svg/);
  assert.match(
    await fs.readFile(path.join(paths.root, 'static', 'generated-submission-assets', 'course-one', 'qr-1.svg'), 'utf8'),
    /<svg/,
  );
  const runtime = JSON.parse(await fs.readFile(path.join(result.generated, 'runtime-courses.json'), 'utf8'));
  assert.equal(runtime[0].availableUntil, '2026-07-31T18:00:00+09:00');
});

test('잘못된 배포 기간을 거부한다', async (t) => {
  const badPeriod = await fixture({config: {availableFrom: '2026-08-01T00:00:00+09:00', availableUntil: '2026-07-01T00:00:00+09:00'}});
  t.after(() => fs.rm(badPeriod.root, {recursive: true, force: true}));
  await assert.rejects(run(badPeriod), /availableUntil/);
});

test('안전하지 않은 과제 제출 주소를 거부한다', async (t) => {
  const paths = await fixture({config: {submissions: [{title: '과제', url: 'http://submit.example.com'}]}});
  t.after(() => fs.rm(paths.root, {recursive: true, force: true}));
  await assert.rejects(run(paths), /HTTPS URL/);
});

test('잘못된 slug와 JSON을 거부한다', async (t) => {
  const badSlug = await fixture({slug: 'Bad Course'});
  t.after(() => fs.rm(badSlug.root, {recursive: true, force: true}));
  await assert.rejects(run(badSlug), /잘못된 수업 식별자/);

  const badJson = await fixture({malformed: true});
  t.after(() => fs.rm(badJson.root, {recursive: true, force: true}));
  await assert.rejects(run(badJson), /course\.json 형식/);
});

test('보호 수업의 인증 파일 누락을 거부한다', async (t) => {
  const paths = await fixture({access: 'protected'});
  t.after(() => fs.rm(paths.root, {recursive: true, force: true}));
  await fs.rm(path.join(paths.auth, 'course-one.htpasswd'));
  await assert.rejects(run(paths), /htpasswd 파일이 없습니다/);
});

test('NAS 콘텐츠 안의 심볼릭 링크를 거부한다', async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, {recursive: true, force: true}));
  const outside = path.join(paths.root, 'outside');
  await fs.mkdir(outside);
  try {
    await fs.symlink(outside, path.join(paths.course, 'code', 'linked'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('이 Windows 환경에서 심볼릭 링크 생성 권한이 없습니다.');
    throw error;
  }
  await assert.rejects(run(paths), /심볼릭 링크는 허용되지 않습니다/);
});
