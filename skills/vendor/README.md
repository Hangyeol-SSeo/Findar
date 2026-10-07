# 외부 스킬 원문 (vendor)

자기소개서 소재 활용(경험 카드 → 소재 배치 → 작성 → 검토)에 쓰는 공개 Claude 스킬의 원문이다.
**파일은 받은 그대로 두고 고치지 않는다.** Findar에 맞춘 연결(어느 절을 어느 단계에 넣는지, 대화형 단계를
무엇으로 대체하는지)은 `lib/vendor-skills.ts`와 `lib/vendor-checks.ts`에만 둔다. 갱신할 때는 아래 커밋을 바꿔 다시 받는다.

| 폴더 | 원본 | 커밋 | 라이선스 |
|---|---|---|---|
| `cover-letter-team/` | https://github.com/djfksjd/cover-letter-team | `62e313152f4e67cfde4333da17211b5ea71f596b` | MIT (`cover-letter-team/LICENSE`) |
| `jasoseo-plugin/` | https://github.com/KangRyun/jasoseo-plugin | `5bfb5d06ec5aa780c85f6a2d0636c610a739e0d8` | MIT (`jasoseo-plugin/LICENSE`) |
| `im-not-ai/` | https://github.com/epoko77-ai/im-not-ai | `2f3d943d08056b612a92e12bfb72ea94dd2acd18` | MIT (`im-not-ai/LICENSE`) |

## 어디에 쓰는가

| Findar 단계 | 원문 |
|---|---|
| 경험 카드 추출 (`lib/experience-cards.ts`) | `cover-letter-team/prompts/interviewer.md` — 경험카드 스키마, 검증 질문, 구체성 규칙 |
| 소재 배치 (`prepareEssayBatch`) | `cover-letter-team/prompts/evidence-planner.md`, `references/intake-and-gaps.md`(충분성·갭 상태), `jasoseo-plugin/.../소제목_문항패턴.md` §2 |
| 작성 | `cover-letter-team/prompts/writer.md` — 사실·의사·해석, 풍부함의 기준 / `소제목_문항패턴.md` §3, §4-2 |
| 편집·검토 | `cover-letter-team/prompts/reviewer.md` — 검사, `references/content-quality.md` — 엄격하게 볼 것, 문항별 판정 |
| 한국어 AI 문체 (편집 단계, 첨삭 받기) | `im-not-ai/.../quick-rules.md` — 원칙(Do-NOT·서법 보존·내용 앵커)과 A·C·D·F·G·H·I 범주, 자체검증 체크리스트. E 범주(문장 길이·리듬)는 jasoseo·Findar의 문장 길이 기준과 충돌해 넣지 않는다 |
| 코드 검사 | `jasoseo-plugin/.../scripts/style_check.py`(+`verify.py`, `문체_금지규칙.md`), `cover-letter-team/scripts/dedup_check.py`(+`charcount.py`), `im-not-ai/.../metrics_v2.py`(+`metrics.py`, `baseline*.json`: AI 문체 위험도·증거 구절, 이중 피동 등 계수, 고쳐쓰기 변경률) — 모두 표준 라이브러리만 쓰므로 `python3`로 그대로 실행 |

원문의 대화형 인터뷰·작업 폴더·YAML 파일·승인 해시는 Findar의 저장소(올린 과거 자소서·면접 대본), 설정 화면의
카드 확인, 보완 질문(missingInfo)으로 대체된다. `contracts.md`는 원문이 참조하는 계약 문서라 함께 보관한다.
