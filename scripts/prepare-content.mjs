import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import matter from 'gray-matter';

const root = process.cwd();
const coursesPath = path.resolve(process.env.COURSES_PATH || path.join(root, 'course-template'));
const authPath = path.resolve(process.env.AUTH_PATH || path.join(root, 'auth-template'));
const generatedDir = path.resolve(process.env.GENERATED_DIR || path.join(root, 'generated'));
const nginxConfigPath = path.resolve(
  process.env.NGINX_CONFIG_PATH || path.join(root, '.runtime', 'nginx.conf'),
);
const siteRoot = process.env.SITE_ROOT || '/srv/site';
const runtimeCoursesPath = process.env.RUNTIME_COURSES_PATH || '/srv/courses';
const runtimeAuthPath = process.env.RUNTIME_AUTH_PATH || '/srv/auth';
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const bcryptPattern = /^[^:\r\n]+:\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function fail(message) {
  throw new Error(message);
}

function escapeNginx(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
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
  const materials = await scanTree(materialsDir);
  const code = await scanTree(codeDir);

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
    docsDir,
    materialsDir,
    codeDir,
    docs,
    docFiles,
    materials,
    code,
  };
}

function fileList(title, urlPrefix, files) {
  const lines = [`## ${title}`, ''];
  if (files.length === 0) return [...lines, '_등록된 파일이 없습니다._', ''].join('\n');
  return [
    ...lines,
    '<ul>',
    ...files.map((file) => `  <li><a href="${urlPrefix}/${encodeUrlPath(file)}">${htmlEscape(file)}</a></li>`),
    '</ul>',
    '',
  ].join('\n');
}

async function writeDocs(courses) {
  const docsRoot = path.join(generatedDir, 'docs');
  await fs.rm(docsRoot, {recursive: true, force: true});
  await fs.mkdir(docsRoot, {recursive: true});

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
      `## [${markdownEscape(course.title)}](/courses/${course.slug}/)`,
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
      fileList('강의 자료', `/files/${course.slug}`, course.materials),
      fileList('실습 코드', `/code/${course.slug}`, course.code),
      '## 강의 문서',
      '',
      ...course.docs.map((file) => {
        const withoutExt = file.slice(0, -path.extname(file).length);
        return `- [${markdownEscape(withoutExt)}](/courses/${course.slug}/${encodeUrlPath(withoutExt)})`;
      }),
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
  }
}

function authDirectives(course) {
  if (course.access !== 'protected') return '';
  const file = `${runtimeAuthPath}/${course.slug}.htpasswd`;
  return `\n    auth_basic "${escapeNginx(course.title)}";\n    auth_basic_user_file "${escapeNginx(file)}";`;
}

function courseLocations(course) {
  const auth = authDirectives(course);
  const slug = course.slug;
  return `
  location = /courses/${slug} { return 301 /courses/${slug}/; }
  location ^~ /courses/${slug}/ {${auth}
    try_files $uri $uri/ =404;
  }
  location = /files/${slug} { return 301 /files/${slug}/; }
  location /files/${slug}/ {${auth}
    alias ${runtimeCoursesPath}/${slug}/materials/;
    autoindex off;
    disable_symlinks on;
  }
  location = /code/${slug} { return 301 /code/${slug}/; }
  location /code/${slug}/ {${auth}
    alias ${runtimeCoursesPath}/${slug}/code/;
    autoindex off;
    disable_symlinks on;
  }`;
}

async function writeNginxConfig(courses) {
  const config = `server {
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
    JSON.stringify(courses.map(({slug, title, description, order, access}) => ({slug, title, description, order, access})), null, 2) + '\n',
    'utf8',
  );
  await writeNginxConfig(courses);
  console.log(`${courses.length}개 수업의 콘텐츠와 Nginx 설정을 생성했습니다.`);
}

main().catch((error) => {
  console.error(`콘텐츠 준비 실패: ${error.message}`);
  process.exitCode = 1;
});
