import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import bcrypt from 'bcryptjs';

const generatedDir = path.resolve(process.env.GENERATED_DIR || '/app/generated');
const authPath = path.resolve(process.env.AUTH_PATH || '/srv/auth');
const port = Number.parseInt(process.env.AUTH_PORT || '3000', 10);
const ttlHours = Number.parseFloat(process.env.SESSION_TTL_HOURS || '12');
const secureMode = process.env.SESSION_COOKIE_SECURE || 'auto';
const maxAttempts = 5;
const attemptWindowMs = 10 * 60 * 1000;
const attempts = new Map();

if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) {
  throw new Error('SESSION_TTL_HOURS는 0보다 크고 168 이하여야 합니다.');
}

const courses = JSON.parse(await fs.readFile(path.join(generatedDir, 'runtime-courses.json'), 'utf8'));
const courseMap = new Map(courses.map((course) => [course.slug, course]));

async function loadSecret() {
  if (process.env.SESSION_SECRET?.length >= 32) return process.env.SESSION_SECRET;
  const secretFile = path.join(authPath, 'session.secret');
  const stored = await fs.readFile(secretFile, 'utf8').catch(() => '');
  if (stored.trim().length >= 32) return stored.trim();
  console.warn('session.secret이 없어 재시작 시 로그인 세션이 초기화됩니다.');
  return crypto.randomBytes(48).toString('base64url');
}

const secret = await loadSecret();

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cookieName(slug) {
  return `education_session_${slug}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [part, ''];
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createToken(slug) {
  const payload = Buffer.from(JSON.stringify({slug, exp: Date.now() + ttlHours * 60 * 60 * 1000})).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token, slug) {
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  const expected = sign(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.slug === slug && Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}

function availability(course, now = Date.now()) {
  if (course.availableFrom && now < Date.parse(course.availableFrom)) return 'upcoming';
  if (course.availableUntil && now >= Date.parse(course.availableUntil)) return 'expired';
  return 'active';
}

function safeNext(value, slug) {
  const fallback = `/courses/${slug}/`;
  if (!value || !value.startsWith(`/courses/${slug}/`) || value.startsWith('//')) return fallback;
  return value;
}

function isSecureRequest(req) {
  if (secureMode === 'always') return true;
  if (secureMode === 'never') return false;
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function commonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function sendHtml(res, status, title, body) {
  commonHeaders(res);
  res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8'});
  res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f1f5f9;color:#0f172a}.card{max-width:440px;margin:10vh auto;background:white;padding:2rem;border-radius:16px;box-shadow:0 16px 40px #0f172a1f}h1{font-size:1.5rem}label{display:block;font-weight:700;margin:1.25rem 0 .5rem}input{width:100%;box-sizing:border-box;padding:.8rem;border:1px solid #94a3b8;border-radius:8px;font-size:1rem}button,.button{display:inline-block;margin-top:1rem;padding:.75rem 1rem;border:0;border-radius:8px;background:#155e75;color:white;text-decoration:none;font-weight:700;cursor:pointer}.error{color:#b91c1c}.muted{color:#475569}</style></head><body><main class="card">${body}</main></body></html>`);
}

function statusBody(course, state) {
  const message = state === 'upcoming' ? '아직 배포 기간이 시작되지 않았습니다.' : '자료 배포 기간이 종료되었습니다.';
  return `<h1>${htmlEscape(course.title)}</h1><p>${message}</p><p class="muted">${course.availableFrom ? `시작: ${htmlEscape(course.availableFrom)}<br>` : ''}${course.availableUntil ? `종료: ${htmlEscape(course.availableUntil)}` : ''}</p><a class="button" href="/">수업 목록으로</a>`;
}

function clientKey(req, slug) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return `${forwarded || req.socket.remoteAddress || 'unknown'}:${slug}`;
}

function isRateLimited(key) {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.startedAt > attemptWindowMs) {
    attempts.delete(key);
    return false;
  }
  return record.count >= maxAttempts;
}

function recordFailure(key) {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.startedAt > attemptWindowMs) attempts.set(key, {count: 1, startedAt: now});
  else record.count += 1;
}

async function validPassword(slug, password) {
  if (!password || password.length > 256) return false;
  const content = await fs.readFile(path.join(authPath, `${slug}.htpasswd`), 'utf8').catch(() => '');
  const hashes = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.slice(line.indexOf(':') + 1));
  for (const hash of hashes) {
    if (await bcrypt.compare(password, hash)) return true;
  }
  return false;
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error('요청이 너무 큽니다.');
  }
  return new URLSearchParams(body);
}

function loginForm(course, next, error = '') {
  return `<h1>${htmlEscape(course.title)}</h1><p>수업 자료를 이용하려면 비밀번호를 입력하세요.</p>${error ? `<p class="error">${htmlEscape(error)}</p>` : ''}<form method="post" action="/login/${course.slug}"><input type="hidden" name="next" value="${htmlEscape(next)}"><label for="password">수업 비밀번호</label><input id="password" name="password" type="password" required autocomplete="current-password" autofocus><button type="submit">수업 들어가기</button></form>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const [, action, slug] = url.pathname.split('/');
    const course = courseMap.get(slug);

    if (action === 'health') {
      res.writeHead(204).end();
      return;
    }
    if (!course) {
      sendHtml(res, 404, '수업을 찾을 수 없음', '<h1>수업을 찾을 수 없습니다.</h1><a class="button" href="/">돌아가기</a>');
      return;
    }
    const state = availability(course);

    if (action === 'check') {
      if (state !== 'active') res.writeHead(403).end();
      else if (course.access === 'public') res.writeHead(204).end();
      else {
        const token = parseCookies(req.headers.cookie)[cookieName(slug)];
        res.writeHead(verifyToken(token, slug) ? 204 : 401).end();
      }
      return;
    }

    if (action === 'status') {
      if (state === 'active') {
        res.writeHead(302, {Location: `/courses/${slug}/`}).end();
      } else sendHtml(res, 403, course.title, statusBody(course, state));
      return;
    }

    if (action === 'logout') {
      const secure = isSecureRequest(req) ? '; Secure' : '';
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${cookieName(slug)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
      }).end();
      return;
    }

    if (action !== 'login') {
      res.writeHead(404).end();
      return;
    }
    if (state !== 'active') {
      sendHtml(res, 403, course.title, statusBody(course, state));
      return;
    }
    const next = safeNext(url.searchParams.get('next'), slug);
    if (course.access === 'public') {
      res.writeHead(302, {Location: next}).end();
      return;
    }
    if (req.method === 'GET') {
      sendHtml(res, 200, `${course.title} 로그인`, loginForm(course, next));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, {Allow: 'GET, POST'}).end();
      return;
    }
    const form = await readForm(req);
    const formNext = safeNext(form.get('next'), slug);
    const key = clientKey(req, slug);
    if (isRateLimited(key)) {
      sendHtml(res, 429, '잠시 후 다시 시도', loginForm(course, formNext, '로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.'));
      return;
    }
    if (!(await validPassword(slug, form.get('password')))) {
      recordFailure(key);
      sendHtml(res, 401, '로그인 실패', loginForm(course, formNext, '비밀번호가 올바르지 않습니다.'));
      return;
    }
    attempts.delete(key);
    const secure = isSecureRequest(req) ? '; Secure' : '';
    res.writeHead(303, {
      Location: formNext,
      'Set-Cookie': `${cookieName(slug)}=${createToken(slug)}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      'Cache-Control': 'no-store',
    }).end();
  } catch (error) {
    console.error(`인증 요청 처리 실패: ${error.message}`);
    if (!res.headersSent) sendHtml(res, 500, '서버 오류', '<h1>요청을 처리할 수 없습니다.</h1>');
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => console.log(`인증 서비스가 127.0.0.1:${port}에서 시작되었습니다.`));
