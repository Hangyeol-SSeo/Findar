# 외부 스킬 원문 (vendor)

경험 카드 추출에 쓰는 공개 Claude 스킬의 원문이다. **파일은 받은 그대로 두고 고치지 않는다.** Findar에 맞춘 연결은
`lib/vendor-skills.ts`에만 둔다. 갱신할 때는 아래 커밋을 바꿔 다시 받는다.

| 폴더 | 원본 | 커밋 | 라이선스 |
|---|---|---|---|
| `cover-letter-team/` | https://github.com/djfksjd/cover-letter-team | `62e313152f4e67cfde4333da17211b5ea71f596b` | MIT (`cover-letter-team/LICENSE`) |

## 어디에 쓰는가

| Findar 단계 | 원문 |
|---|---|
| 경험 카드 추출 (`lib/experience-cards.ts`) | `cover-letter-team/prompts/interviewer.md` — 경험카드 스키마, 검증 질문, 구체성 규칙 |

자기소개서는 대화 세션에서 쓰고, 웹의 첨삭 받기는 외부 스킬 원문 대신 `lib/essay-review.ts`의 짧은 작성 기준을 쓴다.
예전에 함께 쓰던 `jasoseo-plugin`(KangRyun/jasoseo-plugin)과 `im-not-ai`(epoko77-ai/im-not-ai)는 작성 파이프라인을 단순화하면서 뺐다.
원문의 대화형 인터뷰·작업 폴더·YAML 파일은 Findar의 저장소(올린 과거 자소서·면접 대본)로 대체된다. 원문의 확인 게이트(`user_confirmed`·`approval`)는 쓰지 않는다. 카드는 모두 자기소개서 자료에 들어가고, 사용자는 뺄 카드만 고른다(`/profile#experience`).

## 대화 세션용 프로젝트 스킬 (`.claude/skills/`)

자기소개서는 대화 세션에서 쓴다. 그때 Claude Code가 불러 쓰는 프로젝트 스킬이다. Findar 코드는 이 스킬을 읽지 않는다.

| 스킬 | 출처 | 커밋 | 라이선스 | 쓰는 때 |
|---|---|---|---|---|
| `humanizer/` | https://github.com/daleseo/korean-skills (`skills/humanizer`) | `ae12ba27982ebeff03b46dc738365aaa34260d9a` | MIT (`humanizer/LICENSE`) | 초안을 다 쓰고 독자 테스트로 흐름을 고친 뒤, 말투만 다듬을 때 |
| `essay-blind-read/` | Findar 자체. jasoseo-plugin의 비개발 독자 테스트 방식을 옮김 | — | — | 초안을 다 쓴 뒤, 맥락 없는 독자에게 읽혀 흐름이 끊긴 곳을 찾을 때 |
| `essay-ai-check/` | Findar 자체. 기준값은 KatFishNet(ACL 2025), 쉼표 지표 정의는 논문을 따름. 스크립트는 새로 씀 | — | — | 제출 전, 기업의 AI 작성 판별(무하유 GPT킬러 등)에 걸릴 신호를 재고 문단마다 본인 글이 있는지 볼 때 |

`humanizer/`도 받은 그대로 두고 고치지 않는다. 갱신할 때는 위 커밋을 바꿔 다시 받는다.

jasoseo-plugin 전체와 im-not-ai는 넣지 않는다(2026-10-28 검토).
- **jasoseo-plugin:** 8단계 파이프라인이다. 회사 접점 사실 2건 이상, 문단 수 공식, 수치 밀도, 기술 용어 풀어 쓰기 같은 처방이 많다. 이 처방들이 사용자 기준과 부딪히고, 규칙을 쌓아 흐름이 깨진 이전 실패를 되풀이한다. 그래서 독자 테스트만 가져왔다.
- **im-not-ai:** humanizer와 같은 말투 윤문이다. 패턴 85개, 에이전트, 파이썬 스크립트가 딸린 무거운 도구라, 둘 다 쓰면 같은 글을 두 번 고치게 된다.
