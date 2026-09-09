import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const watcher = path.join(projectRoot, 'scripts', 'content-watcher.mjs');

async function fingerprint(courses, auth, now) {
  const {stdout} = await execFileAsync(process.execPath, [watcher, '--fingerprint'], {
    cwd: projectRoot,
    env: {...process.env, COURSES_PATH: courses, AUTH_PATH: auth, CONTENT_FINGERPRINT_NOW: String(now)},
  });
  return stdout.trim();
}

test('NAS 파일 변경과 공개 상태 변경을 감지한다', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'education-watch-'));
  const courses = path.join(root, 'courses');
  const auth = path.join(root, 'auth');
  const course = path.join(courses, 'sample');
  await fs.mkdir(path.join(course, 'docs'), {recursive: true});
  await fs.mkdir(auth);
  await fs.writeFile(path.join(course, 'course.json'), JSON.stringify({
    title: '샘플', description: '', order: 1, access: 'public', availableUntil: '2999-01-01T00:00:00+09:00',
  }));
  await fs.writeFile(path.join(course, 'docs', 'intro.md'), '첫 내용');
  t.after(() => fs.rm(root, {recursive: true, force: true}));

  const before = await fingerprint(courses, auth, Date.parse('2998-01-01T00:00:00+09:00'));
  await fs.writeFile(path.join(course, 'docs', 'intro.md'), '변경된 내용입니다');
  const afterFile = await fingerprint(courses, auth, Date.parse('2998-01-01T00:00:00+09:00'));
  assert.notEqual(afterFile, before);

  const afterDeadline = await fingerprint(courses, auth, Date.parse('3000-01-01T00:00:00+09:00'));
  assert.notEqual(afterDeadline, afterFile);

  await fs.writeFile(path.join(course, 'course.json'), '{잘못된 JSON');
  const invalid = await fingerprint(courses, auth, Date.parse('3000-01-01T00:00:00+09:00'));
  assert.notEqual(invalid, afterDeadline);
});
