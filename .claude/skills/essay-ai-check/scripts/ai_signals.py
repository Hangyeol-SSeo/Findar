#!/usr/bin/env python3
"""자기소개서 답변에서 AI 판별기가 보는 표면 신호를 잰다. 표준 라이브러리만 쓰고, 네트워크에 접속하지 않는다.

기준값은 KatFishNet(Park et al., ACL 2025, arXiv 2503.00032)의 KatFish 에세이 장르 값(사람 / LLM)이다.
쉼표 지표 정의는 im-not-ai(epoko77-ai/im-not-ai, MIT)의 metrics.py와 같게 맞췄다.
토큰 확률(예측 가능성)은 모델 없이 잴 수 없어서 재지 않는다. 그 부분은 SKILL.md의 문단 점검으로 본다.

사용: python3 ai_signals.py 답변.txt   (또는 표준 입력으로 붙여 넣기)
"""
import re
import statistics
import sys

# KatFish 에세이: 사람 / LLM. 논문의 "comma usage rate"(문장별 쉼표 수 ÷ 형태소 수)는 형태소 분석 없이 잴 수 없어 비교하지 않는다.
REF = {
    "comma_sentences": (26.31, 61.03),  # 쉼표가 있는 문장 비율(%)
    "ending_comma": (4.10, 19.83),  # 연결어미 가운데 바로 뒤에 쉼표를 찍은 비율(%)
}

CONNECTIVE = re.compile(r"(?:고|며|지만|면서|아서|어서|는데|으며|므로|니까|도록)$")
# 연결어미로 끝나 보이지만 명사이거나 문장 첫머리 접속어인 말. 형태소 분석 대신 쓰는 근사라 완전하지 않다.
NOT_ENDING = {"잔고", "광고", "재고", "최고", "경고", "신고", "원고", "참고", "사고", "창고", "보고", "그리고", "하지만",
              "그러면서", "그러므로", "그러니까", "그런데", "그래서", "따라서", "어서"}
DIGIT_COMMA = re.compile(r"(?<=\d),(?=\d)")
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
OPENER_COMMA = re.compile(r"^(또한|따라서|그러나|하지만|특히|이를 통해|이처럼|결국|즉|나아가|무엇보다|그 결과|이에|더불어)\s*,")

# 인터넷에 흔한 자소서 상투구(표절 검사에서도 걸리는 쪽)와 AI가 자주 쓰는 마무리. 금지 목록이 아니라 개수만 센다.
STOCK = [
    "귀사", "밑거름", "역량을 발휘", "기여하고 싶습니다", "기여하겠습니다", "성장하고 싶습니다", "성장하겠습니다",
    "라는 것을 배웠습니다", "깨달았습니다", "확신", "열정", "끊임없이", "최선을 다하", "소중한 경험",
    "다양한 경험", "효율적", "체계적", "핵심", "시너지", "한 걸음 더", "발판", "이바지",
]


def sentences(text):
    out = []
    for line in text.splitlines():
        out += [s.strip() for s in SENTENCE_END.split(line) if s.strip()]
    return out


def paragraphs(text):
    return [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]


def side(value, key):
    human, ai = REF[key]
    return "AI 쪽" if abs(value - ai) < abs(value - human) else "사람 쪽"


def measure(text):
    text = DIGIT_COMMA.sub("", text)
    sents = sentences(text)
    if not sents:
        return None
    lengths = [len(s) for s in sents]
    mean = statistics.mean(lengths)
    cv = statistics.pstdev(lengths) / mean if len(lengths) > 1 and mean else 0.0
    endings, spots = 0, []
    for token in text.split():
        bare = token.rstrip(".!?\"'”’)")
        word = bare.rstrip(",")
        if word in NOT_ENDING or not CONNECTIVE.search(word):
            continue
        endings += 1
        if bare.endswith(","):
            spots.append(word)
    finals = [s.split()[-1] if s.split() else "" for s in sents]
    streak = max((sum(1 for _ in g) for g in _runs(finals)), default=0)
    return {
        "sentences": len(sents),
        "comma_sentences": 100 * sum("," in s for s in sents) / len(sents),
        "commas_per_sentence": sum(s.count(",") for s in sents) / len(sents),
        "ending_comma": 100 * len(spots) / endings if endings else 0.0,
        "endings": endings,
        "mean_len": mean,
        "cv": cv,
        "same_final_streak": streak,
        "ending_comma_spots": spots,
        "opener_commas": [s[:20] for s in sents if OPENER_COMMA.match(s)],
        "stock": {w: text.count(w) for w in STOCK if w in text},
    }


def _runs(items):
    run = []
    for item in items:
        if run and item != run[-1]:
            yield run
            run = []
        run.append(item)
    if run:
        yield run


def report(text):
    whole = measure(text)
    if not whole:
        return "읽을 문장이 없습니다."
    lines = [f"문장 {whole['sentences']}개, 평균 {whole['mean_len']:.0f}자", "", "[전체] 기준: KatFish 에세이 사람 / LLM"]
    for key, label, unit in [("comma_sentences", "쉼표가 있는 문장", "%"), ("ending_comma", "연결어미 뒤 쉼표", "%")]:
        human, ai = REF[key]
        few = " (연결어미가 10개 미만이라 참고만)" if key == "ending_comma" and whole["endings"] < 10 else ""
        lines.append(f"- {label}: {whole[key]:.2f}{unit} (사람 {human}{unit} / LLM {ai}{unit}) → {side(whole[key], key)}{few}")
    lines.append(f"- 문장당 쉼표: {whole['commas_per_sentence']:.2f}개 (참고, 기준값 없음)")
    lines.append(f"- 문장 길이 변동(CV): {whole['cv']:.2f} → {'균일함(문장 길이를 섞을 것)' if whole['cv'] < 0.3 else '보통'}")
    lines.append(f"- 같은 마지막 어절 연속: 최대 {whole['same_final_streak']}번" + (" → 끝맺음이 반복됨" if whole["same_final_streak"] >= 3 else ""))
    if whole["ending_comma_spots"]:
        lines.append("- 연결어미 뒤 쉼표 위치: " + " / ".join(f"{w}," for w in whole["ending_comma_spots"]))
    if whole["opener_commas"]:
        lines.append(f"- 접속어 뒤 쉼표로 시작하는 문장: {' / '.join(whole['opener_commas'])}")
    if whole["stock"]:
        lines.append("- 흔한 상투구: " + ", ".join(f"{w} {n}회" for w, n in whole["stock"].items()))
    lines += ["", "[문단별] 판별기는 문단 단위로 본다"]
    for i, para in enumerate(paragraphs(text), 1):
        m = measure(para)
        if not m:
            continue
        flags = []
        if m["comma_sentences"] > 45:
            flags.append(f"쉼표 문장 {m['comma_sentences']:.0f}%")
        if m["ending_comma_spots"]:
            flags.append(f"연결어미 뒤 쉼표 {len(m['ending_comma_spots'])}곳")
        if m["sentences"] >= 4 and m["cv"] < 0.25:
            flags.append(f"문장 길이 균일(CV {m['cv']:.2f})")
        if m["same_final_streak"] >= 3:
            flags.append("끝맺음 반복")
        if m["stock"]:
            flags.append("상투구 " + "·".join(m["stock"]))
        lines.append(f"{i}. {para[:24]}… — " + (", ".join(flags) if flags else "표면 신호 없음"))
    return "\n".join(lines)


if __name__ == "__main__":
    source = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else sys.stdin.read()
    print(report(source))
