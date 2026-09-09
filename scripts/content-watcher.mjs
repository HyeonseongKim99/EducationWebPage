import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const projectRoot = process.cwd();
const coursesPath = path.resolve(process.env.COURSES_PATH || '/srv/courses');
const authPath = path.resolve(process.env.AUTH_PATH || '/srv/auth');
const pollSeconds = Number.parseInt(process.env.CONTENT_POLL_SECONDS || '60', 10);
const settleSeconds = Number.parseInt(process.env.CONTENT_SETTLE_SECONDS || '15', 10);

if (!Number.isInteger(pollSeconds) || pollSeconds < 10 || pollSeconds > 3600) {
  throw new Error('CONTENT_POLL_SECONDS는 10~3600 사이의 정수여야 합니다.');
}
if (!Number.isInteger(settleSeconds) || settleSeconds < 5 || settleSeconds > 600) {
  throw new Error('CONTENT_SETTLE_SECONDS는 5~600 사이의 정수여야 합니다.');
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function availabilityMarker(config, now) {
  if (!config || typeof config !== 'object') return 'invalid';
  if (config.availableFrom && now < Date.parse(config.availableFrom)) return 'upcoming';
  if (config.availableUntil && now >= Date.parse(config.availableUntil)) return 'completed';
  return 'active';
}

async function scan(target, label, rows, now) {
  const entries = await fs.readdir(target, {withFileTypes: true});
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(target, entry.name);
    const relative = `${label}/${path.relative(target, absolute).replaceAll('\\', '/')}`;
    const stat = await fs.lstat(absolute);
    rows.push(`${relative}|${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}|${stat.size}|${stat.mtimeMs}`);
    if (entry.isDirectory()) await scanNested(absolute, `${label}/${entry.name}`, rows, now);
    if (label === 'courses' && entry.isDirectory()) {
      const raw = await fs.readFile(path.join(absolute, 'course.json'), 'utf8').catch(() => '');
      let config;
      try { config = JSON.parse(raw); } catch { config = null; }
      rows.push(`${label}/${entry.name}|availability|${availabilityMarker(config, now)}`);
    }
  }
}

async function scanNested(target, label, rows) {
  const entries = await fs.readdir(target, {withFileTypes: true});
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(target, entry.name);
    const relative = `${label}/${entry.name}`;
    const stat = await fs.lstat(absolute);
    rows.push(`${relative}|${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}|${stat.size}|${stat.mtimeMs}`);
    if (entry.isDirectory()) await scanNested(absolute, relative, rows);
  }
}

export async function snapshotFingerprint(now = Date.now()) {
  const rows = [];
  await scan(coursesPath, 'courses', rows, now);
  await scan(authPath, 'auth', rows, now);
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: projectRoot, env, stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`명령이 종료 코드 ${code}로 실패했습니다.`)));
  });
}

async function validateBuild() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'education-refresh-'));
  try {
    const env = {
      ...process.env,
      NGINX_CONFIG_PATH: path.join(work, 'nginx.conf'),
      SITE_ROOT: path.join(work, 'site'),
    };
    await run(process.execPath, ['scripts/prepare-content.mjs'], env);
    await run(process.execPath, ['node_modules/@docusaurus/core/bin/docusaurus.mjs', 'build', '--out-dir', env.SITE_ROOT], env);
  } finally {
    await fs.rm(work, {recursive: true, force: true});
  }
}

async function main() {
  let baseline = await snapshotFingerprint();
  console.log(`NAS 콘텐츠 자동 확인을 시작합니다. 확인 주기: ${pollSeconds}초`);
  while (true) {
    await delay(pollSeconds * 1000);
    let detected;
    try {
      detected = await snapshotFingerprint();
    } catch (error) {
      console.error(`NAS 콘텐츠를 일시적으로 읽을 수 없어 다음 확인까지 기다립니다: ${error.message}`);
      continue;
    }
    if (detected === baseline) continue;

    console.log(`NAS 콘텐츠 변경을 감지했습니다. ${settleSeconds}초 동안 업로드 완료를 기다립니다.`);
    await delay(settleSeconds * 1000);
    let settled;
    try {
      settled = await snapshotFingerprint();
    } catch (error) {
      console.error(`안정화 확인 중 NAS 콘텐츠를 읽을 수 없어 다음 확인까지 기다립니다: ${error.message}`);
      continue;
    }
    if (settled !== detected) {
      console.log('콘텐츠가 계속 변경 중이므로 다음 확인 때 다시 검사합니다.');
      continue;
    }

    try {
      await validateBuild();
      let finalFingerprint;
      try {
        finalFingerprint = await snapshotFingerprint();
      } catch (error) {
        console.error(`최종 확인 중 NAS 콘텐츠를 읽을 수 없어 이번 결과를 적용하지 않습니다: ${error.message}`);
        continue;
      }
      if (finalFingerprint !== settled) {
        console.log('검증 중 콘텐츠가 변경되어 이번 결과를 적용하지 않습니다.');
        continue;
      }
      console.log('새 콘텐츠 검증이 완료되어 교육 웹 컨테이너를 안전하게 갱신합니다.');
      process.kill(1, 'SIGTERM');
      return;
    } catch (error) {
      console.error(`잘못된 콘텐츠 변경을 무시하고 기존 사이트를 유지합니다: ${error.message}`);
      baseline = settled;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fingerprintNow = process.env.CONTENT_FINGERPRINT_NOW
    ? Number.parseInt(process.env.CONTENT_FINGERPRINT_NOW, 10)
    : Date.now();
  const entry = process.argv.includes('--fingerprint')
    ? snapshotFingerprint(fingerprintNow).then((fingerprint) => console.log(fingerprint))
    : main();
  entry.catch((error) => {
    console.error(`콘텐츠 자동 확인 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
