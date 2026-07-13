# EducationWebPage

Synology NAS의 강의 문서, 배포 자료, 실습 코드를 웹으로 제공하는 교육 사이트입니다. GitHub와 공개 GHCR 이미지에는 애플리케이션만 포함되며 실제 교육 자료와 비밀번호는 NAS에만 보관합니다.

## 주요 기능

- 컨테이너 시작 시 NAS의 수업 정보를 검증하고 Docusaurus 정적 사이트를 생성합니다.
- 보호 수업은 수업 입장 화면에서 공용 비밀번호를 한 번 입력합니다. 이후 같은 브라우저에서는 세션 쿠키가 유지되는 동안 문서와 다운로드를 다시 인증하지 않습니다.
- 수업별 공개 시작·종료 시각을 설정할 수 있습니다.
- 수업별 외부 과제 제출 링크와 선택적 QR 코드를 표시할 수 있습니다.
- 잘못된 JSON, 누락된 인증 파일, 위험한 경로, 심볼릭 링크가 발견되면 안전하게 시작을 중단합니다.

## NAS 폴더 준비

```text
/volume1/docker/education-web/
├─ courses/
│  └─ gmtck-ota/
│     ├─ course.json
│     ├─ docs/
│     │  └─ intro.md
│     ├─ materials/
│     │  └─ lecture-slides.zip
│     └─ code/
│        └─ practice-code.zip
└─ auth/
   ├─ gmtck-ota.htpasswd
   └─ session.secret
```

수업 폴더 이름은 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다. 폴더 안의 실제 파일과 하위 폴더 이름은 한글도 사용할 수 있습니다. [course-template](./course-template)를 복사해서 시작할 수 있습니다.

## course.json 작성

```json
{
  "title": "GMTCK OTA 실습",
  "description": "OTA 보안 실습 자료와 실습 코드를 제공합니다.",
  "order": 10,
  "access": "protected",
  "availableFrom": "2026-06-12T08:30:00+09:00",
  "availableUntil": "2026-06-30T23:59:59+09:00",
  "submissions": [
    {
      "title": "실습 과제 제출",
      "description": "ZIP 파일로 압축해서 제출해 주세요.",
      "url": "https://submit.example.com/form",
      "deadline": "2026-06-29T23:59:59+09:00",
      "showQr": true
    }
  ]
}
```

- `access`: `public` 또는 `protected`
- `order`: 수업 목록 정렬 순서
- `availableFrom`, `availableUntil`: 선택 항목입니다. 한국 시간이라면 반드시 `+09:00`을 포함합니다.
- 시작 전에는 안내 화면, 종료 후에는 배포 종료 화면이 표시됩니다. 기간 검사는 요청할 때마다 수행됩니다.
- `docs`에는 Markdown 문서가 하나 이상 필요합니다.
- `materials`와 `code`의 모든 파일도 수업 페이지에서 개별 다운로드할 수 있습니다.
- `materials` 또는 `code` 폴더에 운영자용 `README.txt`를 넣어도 됩니다. 이 이름의 파일은 사이트 다운로드 목록에서 자동으로 숨겨집니다.

### 외부 과제 제출 링크

- `submissions`는 선택 항목이며 수업당 최대 20개까지 등록할 수 있습니다.
- `title`, `url`은 필수이고 `description`, `deadline`, `showQr`은 선택 항목입니다.
- `url`은 학생 정보와 제출 파일을 보호할 수 있도록 `https://` 주소만 허용합니다.
- `showQr`가 `true`이면 컨테이너가 외부 서비스 호출 없이 QR SVG를 직접 생성합니다.
- 링크는 새 탭으로 열리며 QR을 사용하지 않으려면 `showQr`를 생략하거나 `false`로 설정합니다.
- `deadline`은 수업 페이지에 표시되는 안내입니다. 실제 마감 이후 제출 차단은 Google Forms, Microsoft Forms, Synology 파일 요청 등 외부 제출 서비스에서도 별도로 설정해야 합니다.
- 보호 수업에 등록된 제출 링크와 QR은 해당 수업 로그인 후 수업 페이지에서 확인할 수 있습니다.

## 보호 수업 비밀번호 만들기

비밀번호는 `course.json`에 적지 않습니다. 어느 PC 터미널에서든 다음 명령으로 bcrypt 형식의 파일 내용을 만들 수 있습니다.

```bash
docker run --rm -it httpd:2.4-alpine htpasswd -nB student
```

출력된 한 줄을 NAS의 `auth/<수업 폴더명>.htpasswd`에 저장합니다. 예를 들어 수업 폴더가 `gmtck-ota`이면 `gmtck-ota.htpasswd`입니다. 로그인 화면에서는 사용자 이름 없이 공용 비밀번호만 입력합니다.

비밀번호를 교체한 뒤 컨테이너를 재생성하면 적용됩니다. 이미 로그인한 세션도 모두 끊으려면 `session.secret`도 교체하십시오.

세션 서명 키는 충분히 긴 임의 문자열을 `auth/session.secret`에 한 줄로 저장하는 것을 권장합니다.

```bash
openssl rand -base64 48
```

이 파일이 없어도 실행은 되지만 컨테이너를 재시작할 때마다 모든 로그인 세션이 초기화됩니다. `auth` 폴더는 GitHub에 올리지 마십시오.

## Synology Container Manager 배포

1. File Station에서 `/volume1/docker/education-web/courses`와 `/volume1/docker/education-web/auth`를 만듭니다.
2. 이 저장소의 [docker-compose.yaml](./docker-compose.yaml) 내용을 Container Manager의 새 프로젝트에 붙여 넣습니다.
3. 같은 프로젝트 설정에서 아래 환경 값을 NAS 경로와 도메인에 맞게 지정합니다.
4. 프로젝트를 빌드하고 컨테이너 상태가 정상인지 확인합니다.
5. 내부에서 `http://NAS주소:8080/healthz`를 열어 `ok`가 표시되는지 확인합니다.
6. 새 이미지가 게시되면 Container Manager에서 이미지를 다시 받은 뒤 프로젝트를 재생성합니다.

Synology에서는 `pull_policy` 옵션을 추가하지 않습니다. 최신 이미지가 필요하면 기존 이미지를 제거한 뒤 프로젝트를 다시 빌드하거나, SSH에서 `sudo docker pull ghcr.io/hyeonseongkim99/educationwebpage:latest`를 실행한 뒤 프로젝트를 재생성합니다.

주요 환경 값:

| 이름 | 기본값/예시 | 설명 |
| --- | --- | --- |
| `WEB_PORT` | `8080` | NAS 내부에서 Reverse Proxy가 연결할 포트 |
| `COURSES_PATH` | `/volume1/docker/education-web/courses` | 실제 수업 자료 경로 |
| `AUTH_PATH` | `/volume1/docker/education-web/auth` | htpasswd와 세션 키 경로 |
| `SITE_URL` | `https://education.example.com` | 외부 공개 주소 |
| `SESSION_TTL_HOURS` | `12` | 로그인 세션 유효 시간 |
| `SESSION_COOKIE_SECURE` | `auto` | HTTPS 여부 자동 판별. 일반적으로 변경하지 않음 |

이 버전은 생성 결과를 컨테이너 임시 공간에 만들므로 `/srv/site` 또는 `generated` 볼륨을 연결하지 않습니다.

## HTTPS와 Reverse Proxy

DSM의 Reverse Proxy에서 외부 HTTPS 도메인을 `http://127.0.0.1:WEB_PORT`로 전달하고 해당 도메인의 인증서를 연결합니다. 컨테이너의 `WEB_PORT`는 공유기에서 인터넷으로 직접 포트 포워딩하지 않습니다. Reverse Proxy가 원래 프로토콜을 전달하므로 HTTPS 접속에서는 로그인 쿠키가 자동으로 `Secure`로 설정됩니다.

## 공개 경로

- `/courses/<수업>/...`: 강의 문서
- `/courses/<수업>/materials/...`: 배포 자료 다운로드
- `/courses/<수업>/code/...`: 실습 코드 다운로드
- `/login/<수업>`: 보호 수업 입장
- `/logout/<수업>`: 현재 수업 로그아웃
- `/healthz`: 컨테이너 상태 확인

보호 수업의 문서·자료·코드 직접 URL에도 동일한 로그인 세션과 배포 기간이 적용됩니다. 다른 수업의 세션으로는 접근할 수 없습니다.

## 로컬 검증

Node.js 20 이상과 Docker가 필요합니다.

```bash
npm ci
npm run check
docker build -t education-web-page:test .
```

실제 교육 콘텐츠는 Git 대신 Synology Hyper Backup 또는 NAS 스냅샷으로 백업하는 것을 권장합니다.

## GitHub Actions와 GHCR

- Pull request에서는 Docker 빌드만 검증합니다.
- `main`에 push하면 다음 태그가 GHCR에 게시됩니다.
  - `ghcr.io/hyeonseongkim99/educationwebpage:latest`
  - `ghcr.io/hyeonseongkim99/educationwebpage:<commit-sha>`

GHCR 패키지는 공개 상태를 유지하되 실제 강의자료, 실습 코드, htpasswd, 세션 키는 이미지에 포함하지 않습니다.
