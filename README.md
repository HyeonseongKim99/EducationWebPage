# EducationWebPage

Synology NAS의 강의 문서, 배포 자료, 실습 코드를 Docusaurus와 Nginx로 제공하는 교육 자료 웹사이트입니다. GitHub와 공개 GHCR 이미지에는 웹 애플리케이션만 포함되며 실제 수업 콘텐츠와 비밀번호는 NAS에만 저장됩니다.

## 구성 원리

- 컨테이너 시작 시 `/srv/courses`의 수업을 검증하고 Docusaurus 정적 사이트를 생성합니다.
- 수업별 `access`가 `protected`이면 강의 페이지, 자료, 코드에 같은 Nginx Basic Auth를 적용합니다.
- NAS 콘텐츠와 인증 파일은 읽기 전용이며 생성 결과만 `/srv/site`에 기록합니다.
- NAS 콘텐츠를 변경한 뒤에는 Container Manager에서 컨테이너를 다시 생성하거나 재시작해야 합니다.

## NAS 디렉터리 준비

```text
/volume1/docker/education-web/
├─ courses/
│  └─ python-basic/
│     ├─ course.json
│     ├─ docs/
│     │  └─ intro.md
│     ├─ materials/
│     │  └─ lecture-01.pdf
│     └─ code/
│        └─ practice-01.py
├─ auth/
│  └─ python-basic.htpasswd
└─ generated/
```

수업 폴더 이름은 영문 소문자, 숫자, 하이픈만 사용합니다. 예시는 [course-template](./course-template)를 복사해 시작할 수 있습니다.

`course.json` 형식:

```json
{
  "title": "Python 기초",
  "description": "Python 문법과 데이터 처리 기초를 학습합니다.",
  "order": 10,
  "access": "protected"
}
```

- `access`: `public` 또는 `protected`
- `order`: 수업 목록 정렬 순서
- `docs`에는 `.md` 문서가 하나 이상 필요합니다.
- 숨김 파일과 심볼릭 링크는 허용되지 않습니다.
- `materials`와 `code`의 모든 일반 파일이 해당 수업 페이지에 다운로드 항목으로 표시됩니다.

## 수업 비밀번호 만들기

Basic Auth는 사용자 이름과 비밀번호를 모두 요구합니다. 공용 사용자 이름은 `student`로 운영하는 것을 권장합니다. 비밀번호를 명령 기록에 남기지 않도록 대화형으로 bcrypt 해시를 생성합니다.

```bash
docker run --rm -it httpd:2.4-alpine htpasswd -nB student
```

출력된 한 줄을 NAS의 `auth/<수업 폴더명>.htpasswd`에 저장합니다. 평문 비밀번호나 `auth` 디렉터리를 Git에 올리지 마세요. 비밀번호를 변경한 뒤 컨테이너를 재시작하면 새 인증 정보가 적용됩니다.

## 로컬 개발

Node.js 20 이상과 Docker가 필요합니다.

```bash
npm ci
npm start
```

기본 개발 서버는 `course-template`의 공개 샘플 수업을 사용합니다. 전체 검증:

```bash
npm run check
docker build -t education-web-page:test .
```

실제 구조를 로컬 Docker로 확인하려면 `.env.example`을 `.env`로 복사하고 경로를 로컬 절대 경로로 바꾼 다음 실행합니다.

```bash
docker compose up -d
```

## GitHub Actions와 GHCR

- Pull request: Docker 이미지를 빌드만 하고 게시하지 않습니다.
- `main` push: 다음 두 태그를 GHCR에 게시합니다.
  - `ghcr.io/hyeonseongkim99/educationwebpage:latest`
  - `ghcr.io/hyeonseongkim99/educationwebpage:<commit-sha>`

첫 게시 후 GitHub의 **Packages → educationwebpage → Package settings → Change visibility**에서 패키지를 `Public`으로 설정합니다. 공개 패키지로 설정하면 Synology NAS에서 별도 GitHub 토큰 없이 이미지를 받을 수 있습니다.

## Synology Container Manager 배포

1. File Station에서 `/volume1/docker/education-web/{courses,auth,generated}`를 생성합니다.
2. 이 저장소의 `compose.yaml`과 `.env.example` 내용을 Container Manager 프로젝트에 등록합니다.
3. 환경값을 실제 NAS 경로와 도메인으로 변경합니다.
4. 프로젝트를 빌드해 `education-web` 컨테이너가 정상 상태인지 확인합니다.
5. 브라우저에서 `http://NAS주소:8080/healthz`가 `ok`를 반환하는지 확인합니다.
6. 새 이미지가 게시되면 프로젝트에서 이미지를 다시 가져온 후 컨테이너를 재생성합니다.

주요 환경변수:

| 이름 | 기본/예시 값 | 설명 |
| --- | --- | --- |
| `WEB_PORT` | `8080` | NAS 내부에서 Reverse Proxy가 연결할 포트 |
| `COURSES_PATH` | `/volume1/docker/education-web/courses` | 실제 수업 원본 |
| `AUTH_PATH` | `/volume1/docker/education-web/auth` | bcrypt htpasswd 파일 |
| `GENERATED_PATH` | `/volume1/docker/education-web/generated` | 생성된 정적 사이트 |
| `SITE_URL` | `https://education.example.com` | 외부 공개 주소 |

## HTTPS 공개

Synology DSM의 **로그인 포털 → 고급 → 역방향 프록시**에서 HTTPS 도메인을 `http://127.0.0.1:WEB_PORT`로 전달합니다. DSM 인증서 메뉴에서 해당 도메인의 인증서를 연결하고 공유기에서는 HTTPS에 필요한 포트만 Reverse Proxy로 전달합니다. 컨테이너의 `WEB_PORT`를 인터넷에 직접 노출하지 마세요.

## 공개 경로와 보안

- `/courses/<수업>/...`: 강의 문서
- `/files/<수업>/...`: PDF 등 배포 자료
- `/code/<수업>/...`: 실습 코드
- `/healthz`: 컨테이너 상태 확인

보호 수업은 위 세 수업 경로 모두 인증됩니다. 인증 파일 누락, 잘못된 JSON, 위험한 경로 또는 심볼릭 링크가 발견되면 컨테이너는 공개 상태로 실행되지 않고 시작에 실패합니다. 학생별 계정, 웹 코드 실행, 자동 NAS 업데이트는 이 초기 버전에 포함되지 않습니다.

실제 교육 콘텐츠는 Git 대신 Synology Hyper Backup 또는 스냅샷으로 백업하는 것을 권장합니다.
