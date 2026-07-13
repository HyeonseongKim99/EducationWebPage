import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import matter from 'gray-matter';
import QRCode from 'qrcode';

const root = process.cwd();
const coursesPath = path.resolve(process.env.COURSES_PATH || path.join(root, 'course-template'));
const authPath = path.resolve(process.env.AUTH_PATH || path.join(root, 'auth-template'));
const generatedDir = path.resolve(process.env.GENERATED_DIR || path.join(root, 'generated'));
const staticDir = path.resolve(process.env.STATIC_DIR || path.join(root, 'static'));
const nginxConfigPath = path.resolve(
  process.env.NGINX_CONFIG_PATH || path.join(root, '.runtime', 'nginx.conf'),
);
const siteRoot = process.env.SITE_ROOT || '/srv/site';
const runtimeCoursesPath = process.env.RUNTIME_COURSES_PATH || '/srv/courses';
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const bcryptPattern = /^[^:\r\n]+:\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message) {
  throw new Error(message);
}

function encodeUrlPath(relativePath) {
  return relativePath.split(path.sep).map(encodeURIComponent).join('/');
}

function markdownEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function htmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function validateDateTime(value, label, slug) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !dateTimePattern.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label}은 시간대가 포함된 ISO 8601 형식이어야 합니다: ${slug}`);
  }
  return value;
}

function validateSubmissionUrl(value, slug, index) {
  if (typeof value !== 'string') fail(`submissions[${index}].url이 필요합니다: ${slug}`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`submissions[${index}].url 형식이 올바르지 않습니다: ${slug}`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    fail(`과제 제출 주소는 사용자 정보가 없는 HTTPS URL이어야 합니다: ${slug}`);
  }
  return parsed.href;
}

async function ensureDirectory(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} 디렉터리를 찾을 수 없거나 안전하지 않습니다: ${target}`);
  }
}

async function scanTree(base, {extensions} = {}) {
  const files = [];
  const visit = async (current, relative = '') => {
    const entries = await fs.readdir(current, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        fail(`숨김 파일은 허용되지 않습니다: ${path.join(relative, entry.name)}`);
      }
      const absolute = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        fail(`심볼릭 링크는 허용되지 않습니다: ${childRelative}`);
      }
      if (stat.isDirectory()) {
        await visit(absolute, childRelative);
      } else if (stat.isFile()) {
        if (!extensions || extensions.includes(path.extname(entry.name).toLowerCase())) {
          files.push(childRelative);
        }
      } else {
        fail(`일반 파일이 아닌 항목은 허용되지 않습니다: ${childRelative}`);
      }
    }
  };
  await visit(base);
  return files.sort((a, b) => a.localeCompare(b, 'ko'));
}

async function readCourse(courseDir, slug) {
  if (!slugPattern.test(slug)) {
    fail(`잘못된 수업 식별자입니다: ${slug}`);
  }
  const stat = await fs.lstat(courseDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`수업 항목은 실제 디렉터리여야 합니다: ${slug}`);
  }

  const configFile = path.join(courseDir, 'course.json');
  const raw = await fs.readFile(configFile, 'utf8').catch(() => fail(`course.json이 없습니다: ${slug}`));
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    fail(`course.json 형식이 올바르지 않습니다: ${slug}`);
  }
  if (typeof config.title !== 'string' || !config.title.trim()) fail(`title이 필요합니다: ${slug}`);
  if (typeof config.description !== 'string') fail(`description은 문자열이어야 합니다: ${slug}`);
  if (!Number.isInteger(config.order)) fail(`order는 정수여야 합니다: ${slug}`);
  if (!['public', 'protected'].includes(config.access)) fail(`access 값이 올바르지 않습니다: ${slug}`);

  const docsDir = path.join(courseDir, 'docs');
  const materialsDir = path.join(courseDir, 'materials');
  const codeDir = path.join(courseDir, 'code');
  await ensureDirectory(docsDir, `${slug}/docs`);
  await ensureDirectory(materialsDir, `${slug}/materials`);
  await ensureDirectory(codeDir, `${slug}/code`);
  const docFiles = await scanTree(docsDir);
  const docs = docFiles.filter((file) => path.extname(file).toLowerCase() === '.md');
  if (docs.length === 0) fail(`Markdown 강의 문서가 하나 이상 필요합니다: ${slug}`);
  const isOperatorGuide = (file) => path.basename(file).toLowerCase() === 'readme.txt';
  const materials = (await scanTree(materialsDir)).filter((file) => !isOperatorGuide(file));
  const code = (await scanTree(codeDir)).filter((file) => !isOperatorGuide(file));
  const availableFrom = validateDateTime(config.availableFrom, 'availableFrom', slug);
  const availableUntil = validateDateTime(config.availableUntil, 'availableUntil', slug);
  if (availableFrom && availableUntil && Date.parse(availableFrom) >= Date.parse(availableUntil)) {
    fail(`availableUntil은 availableFrom보다 뒤여야 합니다: ${slug}`);
  }
  const rawSubmissions = config.submissions ?? [];
  if (!Array.isArray(rawSubmissions) || rawSubmissions.length > 20) {
    fail(`submissions는 최대 20개의 배열이어야 합니다: ${slug}`);
  }
  const submissions = rawSubmissions.map((submission, index) => {
    if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
      fail(`submissions[${index}] 형식이 올바르지 않습니다: ${slug}`);
    }
    const allowedKeys = new Set(['title', 'description', 'url', 'deadline', 'showQr']);
    if (Object.keys(submission).some((key) => !allowedKeys.has(key))) {
      fail(`submissions[${index}]에 알 수 없는 설정이 있습니다: ${slug}`);
    }
    if (typeof submission.title !== 'string' || !submission.title.trim()) {
      fail(`submissions[${index}].title이 필요합니다: ${slug}`);
    }
    if (submission.description !== undefined && typeof submission.description !== 'string') {
      fail(`submissions[${index}].description은 문자열이어야 합니다: ${slug}`);
    }
    if (submission.showQr !== undefined && typeof submission.showQr !== 'boolean') {
      fail(`submissions[${index}].showQr은 true 또는 false여야 합니다: ${slug}`);
    }
    return {
      title: submission.title.trim(),
      description: submission.description?.trim() || '',
      url: validateSubmissionUrl(submission.url, slug, index),
      deadline: validateDateTime(submission.deadline, `submissions[${index}].deadline`, slug),
      showQr: submission.showQr ?? false,
    };
  });

  if (config.access === 'protected') {
    const passwordFile = path.join(authPath, `${slug}.htpasswd`);
    const passwordStat = await fs.lstat(passwordFile).catch(() => null);
    if (!passwordStat?.isFile() || passwordStat.isSymbolicLink()) {
      fail(`보호 수업의 htpasswd 파일이 없습니다: ${slug}`);
    }
    const lines = (await fs.readFile(passwordFile, 'utf8'))
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines.some((line) => !bcryptPattern.test(line))) {
      fail(`bcrypt 형식의 htpasswd 파일이 필요합니다: ${slug}`);
    }
  }

  return {
    slug,
    title: config.title.trim(),
    description: config.description.trim(),
    order: config.order,
    access: config.access,
    availableFrom,
    availableUntil,
    submissions,
    docsDir,
    materialsDir,
    codeDir,
    docs,
    docFiles,
    materials,
    code,
  };
}

function fileKind(file) {
  const extension = path.extname(file).slice(1).toUpperCase();
  const icons = {
    ZIP: '📦', RAR: '📦', '7Z': '📦', GZ: '📦',
    PDF: '📕', PPT: '📊', PPTX: '📊',
    DOC: '📄', DOCX: '📄', TXT: '📄',
    XLS: '📈', XLSX: '📈', CSV: '📈',
    PY: '💻', JS: '💻', TS: '💻', C: '💻', CPP: '💻', H: '💻', JAVA: '💻',
  };
  return {extension: extension || 'FILE', icon: icons[extension] || '📎'};
}

function fileList(title, description, urlPrefix, files) {
  const lines = [`## ${title}`, '', description, ''];
  if (files.length === 0) return [...lines, '_등록된 파일이 없습니다._', ''].join('\n');
  return [
    ...lines,
    '<div class="download-grid">',
    ...files.map((file) => {
      const {extension, icon} = fileKind(file);
      return `  <a class="download-card" href="${urlPrefix}/${encodeUrlPath(file)}"><span class="download-icon" aria-hidden="true">${icon}</span><span class="download-info"><strong>${htmlEscape(file)}</strong><small>${extension} 파일</small></span><span class="download-action">다운로드 ↓</span></a>`;
    }),
    '</div>',
    '',
  ].join('\n');
}

function availabilityText(course) {
  if (!course.availableFrom && !course.availableUntil) return '';
  const lines = ['## 배포 기간', ''];
  if (course.availableFrom) lines.push(`- 시작: ${course.availableFrom}`);
  if (course.availableUntil) lines.push(`- 종료: ${course.availableUntil}`);
  lines.push('');
  return lines.join('\n');
}

function submissionCards(course) {
  if (course.submissions.length === 0) return '';
  return [
    '## 과제 제출',
    '',
    '<div class="submission-grid">',
    ...course.submissions.map((submission, index) => [
      '  <article class="submission-card">',
      `    <div class="submission-content"><h3>${htmlEscape(submission.title)}</h3>`,
      submission.description ? `    <p>${htmlEscape(submission.description)}</p>` : '',
      submission.deadline ? `    <p class="submission-deadline">제출 마감: <time datetime="${htmlEscape(submission.deadline)}">${htmlEscape(submission.deadline)}</time></p>` : '',
      `    <a class="button button--primary" href="${htmlEscape(submission.url)}" target="_blank" rel="noopener noreferrer">제출 페이지 열기 ↗</a></div>`,
      submission.showQr ? `    <img class="submission-qr" src="/generated-submission-assets/${course.slug}/qr-${index + 1}.svg" alt="${htmlEscape(submission.title)} 제출 페이지 QR 코드" />` : '',
      '  </article>',
    ].filter(Boolean).join('\n')),
    '</div>',
    '',
  ].join('\n');
}

async function writeDocs(courses) {
  const docsRoot = path.join(generatedDir, 'docs');
  const submissionAssetsRoot = path.join(staticDir, 'generated-submission-assets');
  await fs.rm(docsRoot, {recursive: true, force: true});
  await fs.rm(submissionAssetsRoot, {recursive: true, force: true});
  await fs.mkdir(docsRoot, {recursive: true});
  await fs.mkdir(submissionAssetsRoot, {recursive: true});

  const catalog = [
    '---',
    'id: course-catalog',
    'slug: /',
    'title: 수업 목록',
    'hide_table_of_contents: true',
    '---',
    '',
    '# 수업 목록',
    '',
    ...courses.flatMap((course) => [
      course.access === 'protected'
        ? `<h2><a href="/enter/${course.slug}">${htmlEscape(course.title)}</a></h2>`
        : `## [${markdownEscape(course.title)}](/courses/${course.slug}/)`,
      '',
      course.access === 'protected' ? '🔒 비밀번호가 필요한 수업입니다.' : '🌐 공개 수업입니다.',
      '',
      course.description,
      '',
    ]),
  ];
  if (courses.length === 0) catalog.push('_등록된 수업이 없습니다._', '');
  await fs.writeFile(path.join(docsRoot, 'index.md'), catalog.join('\n'), 'utf8');

  for (const course of courses) {
    const target = path.join(docsRoot, course.slug);
    await fs.mkdir(target, {recursive: true});
    const index = [
      '---',
      `title: ${JSON.stringify(course.title)}`,
      'slug: /' + course.slug + '/',
      'hide_table_of_contents: true',
      '---',
      '',
      `# ${course.title}`,
      '',
      course.description,
      '',
      course.access === 'protected' ? `<a href="/logout/${course.slug}">로그아웃</a>` : '',
      '',
      availabilityText(course),
      submissionCards(course),
      fileList('강의 자료', '강의 슬라이드와 참고 자료를 내려받을 수 있습니다.', `/courses/${course.slug}/materials`, course.materials),
      fileList('실습 코드', '실습에 필요한 코드와 예제 파일을 내려받을 수 있습니다.', `/courses/${course.slug}/code`, course.code),
      '## 강의 문서',
      '',
      '<ul>',
      ...course.docs.map((file) => {
        const withoutExt = file.slice(0, -path.extname(file).length);
        return `<li><a href="/courses/${course.slug}/${encodeUrlPath(withoutExt)}">${htmlEscape(withoutExt)}</a></li>`;
      }),
      '</ul>',
      '',
    ];
    await fs.writeFile(path.join(target, 'index.md'), index.join('\n'), 'utf8');

    for (const relative of course.docFiles) {
      const source = path.join(course.docsDir, relative);
      const destination = path.join(target, relative);
      await fs.mkdir(path.dirname(destination), {recursive: true});
      if (path.extname(relative).toLowerCase() !== '.md') {
        await fs.copyFile(source, destination);
        continue;
      }
      const parsed = matter(await fs.readFile(source, 'utf8'));
      const safeFrontmatter = {};
      for (const key of ['title', 'description', 'sidebar_label', 'sidebar_position', 'hide_title', 'toc_min_heading_level', 'toc_max_heading_level']) {
        if (parsed.data[key] !== undefined) safeFrontmatter[key] = parsed.data[key];
      }
      safeFrontmatter.pagination_next = null;
      safeFrontmatter.pagination_prev = null;
      await fs.writeFile(destination, matter.stringify(parsed.content, safeFrontmatter), 'utf8');
    }
    for (const [index, submission] of course.submissions.entries()) {
      if (!submission.showQr) continue;
      const svg = await QRCode.toString(submission.url, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 180,
      });
      const qrTarget = path.join(submissionAssetsRoot, course.slug);
      await fs.mkdir(qrTarget, {recursive: true});
      await fs.writeFile(path.join(qrTarget, `qr-${index + 1}.svg`), svg, 'utf8');
    }
  }
}

function courseLocations(course) {
  const slug = course.slug;
  const locationName = slug.replaceAll('-', '_');
  const privateCache = course.access === 'protected'
    ? '\n    add_header Cache-Control "private, no-store, max-age=0" always;'
    : '';
  const auth = `
    auth_request /_auth/${slug};
    error_page 401 = @login_${locationName};
    error_page 403 = @closed_${locationName};`;
  return `
  location = /_auth/${slug} {
    internal;
    proxy_pass http://127.0.0.1:3000/check/${slug};
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location @login_${locationName} { return 302 /login/${slug}?next=$request_uri; }
  location @closed_${locationName} { return 302 /status/${slug}; }
  location = /courses/${slug} { return 301 /courses/${slug}/; }
  location ^~ /courses/${slug}/materials/ {${auth}
    alias ${runtimeCoursesPath}/${slug}/materials/;
    autoindex off;
    disable_symlinks on;
    add_header Content-Disposition "attachment";${privateCache}
  }
  location ^~ /courses/${slug}/code/ {${auth}
    alias ${runtimeCoursesPath}/${slug}/code/;
    autoindex off;
    disable_symlinks on;
    add_header Content-Disposition "attachment";${privateCache}
  }
  location ^~ /generated-submission-assets/${slug}/ {${auth}
    try_files $uri =404;${privateCache}
  }
  location ^~ /courses/${slug}/ {${auth}
    try_files $uri $uri/ =404;${privateCache}
  }
  `;
}

async function writeNginxConfig(courses) {
  const config = `map $http_x_forwarded_proto $education_forwarded_proto {
  default $http_x_forwarded_proto;
  "" $scheme;
}

server {
  listen 80 default_server;
  server_name _;
  root ${siteRoot};
  index index.html;
  charset utf-8;
  server_tokens off;

  location = /healthz {
    access_log off;
    default_type text/plain;
    return 200 "ok\\n";
  }

  location ~ (^|/)\\. { deny all; }

  location ^~ /login/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $education_forwarded_proto;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location ^~ /enter/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Forwarded-Proto $education_forwarded_proto;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location ^~ /logout/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $education_forwarded_proto;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location ^~ /status/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $education_forwarded_proto;
  }
${courses.map(courseLocations).join('\n')}

  location / {
    try_files $uri $uri/ /404.html;
  }
}
`;
  await fs.mkdir(path.dirname(nginxConfigPath), {recursive: true});
  await fs.writeFile(nginxConfigPath, config, 'utf8');
}

async function main() {
  await ensureDirectory(coursesPath, 'courses');
  await ensureDirectory(authPath, 'auth');
  const entries = await fs.readdir(coursesPath, {withFileTypes: true});
  const courses = [];
  const seen = new Set();
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const normalized = entry.name.toLowerCase();
    if (seen.has(normalized)) fail(`중복 수업 식별자입니다: ${entry.name}`);
    seen.add(normalized);
    courses.push(await readCourse(path.join(coursesPath, entry.name), entry.name));
  }
  courses.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ko'));
  await fs.mkdir(generatedDir, {recursive: true});
  await writeDocs(courses);
  await fs.writeFile(
    path.join(generatedDir, 'courses.json'),
    JSON.stringify(courses.map(({slug, title, description, order, access, availableFrom, availableUntil}) => ({slug, title, description, order, access, availableFrom, availableUntil})), null, 2) + '\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(generatedDir, 'runtime-courses.json'),
    JSON.stringify(courses.map(({slug, title, access, availableFrom, availableUntil}) => ({slug, title, access, availableFrom, availableUntil})), null, 2) + '\n',
    'utf8',
  );
  await writeNginxConfig(courses);
  console.log(`${courses.length}개 수업의 콘텐츠와 Nginx 설정을 생성했습니다.`);
}

main().catch((error) => {
  console.error(`콘텐츠 준비 실패: ${error.message}`);
  process.exitCode = 1;
});
