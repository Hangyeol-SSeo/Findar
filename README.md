This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 지원 도우미

### 회사 리서치 사용량

기본 분석 모델은 Sonnet 4.6을 유지하고 추론 수준을 `medium`으로 지정합니다. 섹션당 웹 검색 최대 3회, 페이지 조회 최대 5회, SDK 최대 18턴으로 제한합니다. 원문 3개 확인과 구체적인 분석을 요청하되 페이지 조회 결과는 관련 근거 1500자 이내로 추출하게 합니다(글자 수는 모델 지침이며 강제 절단하지 않습니다). 조사 전용 시스템 프롬프트와 두 웹 도구만 전달합니다.

같은 서버 프로세스에서 동시에 들어온 회사·섹션별 요청은 하나의 실행을 공유합니다. 최신 분석은 기존 TTL에 따라 재사용하며 실패한 새로고침은 기존 정상 분석을 덮어쓰지 않습니다. 여러 서버 프로세스 사이의 실행 공유는 지원하지 않습니다.

필요하면 `.env.local`에 `COMPANY_RESEARCH_EFFORT=high`로 추론 수준을 높이거나 `COMPANY_RESEARCH_MODEL`로 Anthropic 웹 도구와 호환되는 모델을 지정할 수 있습니다. 환경변수 변경 후 개발 서버를 재시작하세요. `USE_FREERIDE`는 기존 공고 요약/매칭에만 적용됩니다. 설치된 FreeRide의 Anthropic 변환기는 서버 검색 결과 블록을 지원하지 않아 회사 리서치는 전환하지 않았습니다. FreeRide 리서치를 구현하려면 별도 검색 도구와 원문 수집 경로가 필요합니다.

서버의 `[company-research] usage` 로그에 실행별 모델·턴 수·입출력/캐시 토큰·SDK 추정 비용이 기록됩니다. 구독 잔여량을 뜻하지 않습니다. 실제 절감률과 품질 차이는 같은 회사·섹션으로 비교해야 하며, 검색 상한 때문에 근거가 부족하면 미확인 내용을 명시하도록 요청합니다. 비용을 쓰지 않는 회귀 테스트는 `node scripts/tests/company-research.cjs`로 실행합니다.

**문항별 자기소개서**에 실제 지원서 문항과 글자 수 제한을 입력합니다. 저장된 경험과 과거 답변의 원문에서 근거를 고른 뒤 작성하고, 별도 편집 검토를 거칩니다. 학교·프로젝트·창업 팀명은 본문에서 제외하고 창업은 직무와 관련된 판단·행동의 경험으로만 다룹니다. 원문 근거, 수치, 글자 수를 검증하며 핵심 경험이 부족하면 보완 질문을 표시합니다. 답변은 직접 수정·저장할 수 있고, 검토한 답변만 참고 자료로 저장합니다. 이전 방식의 공통 답변은 별도 보관됩니다.

**지원서 자동 입력**은 다음 두 경로를 제공합니다.

- Word: 회사 DOCX 양식을 올리면 비어 있는 표 입력칸에 저장 정보를 넣은 작성본을 내려받습니다. 기존 값과 문서의 나머지 ZIP 항목을 보존합니다. DOC/HWP는 DOCX로 변환해야 하며 본문 빈줄, 텍스트 상자, 중첩 표, 체크박스, 서명은 지원하지 않습니다. Python 3가 필요하며 실행 경로는 `FINDAR_PYTHON`으로 지정할 수 있습니다.
- Brave/Chrome: 패널에서 확장 기능 ZIP을 내려받아 압축 해제하고 브라우저의 확장 프로그램 관리 → 개발자 모드 → 압축해제된 확장 프로그램 로드로 설치합니다. Findar 새로고침 → 웹 지원서 연결 → 실제 지원서에서 확장 기능의 현재 양식 채우기를 실행합니다. 설치 상세는 [브라우저 확장 기능 안내](browser-extension/README.md)를 참고하세요.

브라우저 입력은 AI가 입력칸과 저장 필드의 ID를 연결하고 코드가 저장된 원문 값을 입력합니다. 모델이 만든 개인정보는 사용하지 않습니다. 기존 입력값, 동의, 인증, 서명, 파일 첨부와 제출은 자동 처리하지 않습니다. 연결은 같은 컴퓨터의 localhost/127.0.0.1 서버에서 사용하며 20분 후 만료됩니다. 기본 input/textarea/select를 지원하고 iframe·닫힌 shadow DOM·커스텀 드롭다운은 직접 확인해야 합니다. 사이트가 입력 이벤트를 자동 저장하는 경우에는 입력하면서 저장될 수 있습니다.

검증 명령:

```sh
node scripts/tests/application-assistant.cjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_*.py'
npx tsc --noEmit
```

브라우저 회귀 검증은 별도 테스트 프로필과 가상 데이터만 사용합니다. 실행 중인 개발 서버와 테스트용 Playwright 경로를 `FINDAR_TEST_URL`, `FINDAR_PLAYWRIGHT`로, 브라우저 실행 파일을 `FINDAR_BROWSER`로 지정한 뒤 `node scripts/tests/browser-assistant.cjs` 및 `node scripts/tests/browser-extension.cjs`를 실행합니다. 앱의 런타임에는 Playwright를 사용하지 않습니다.
