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
원문의 대화형 인터뷰·작업 폴더·YAML 파일·승인 해시는 Findar의 저장소(올린 과거 자소서·면접 대본)와 설정 화면의 카드 확인으로 대체된다.
