"""
Extracts the 정보처리기사 question bank into site/data/questions.json.

For each exam round:
  - Student PDF supplies the question text and 4 options (clean ①②③④).
  - Teacher PDF's last page contains a compact answer key for all 100 items.
  - 해설집 PDF supplies the explanation per question.

Approach:
  1) Concatenate all pages of each PDF into a single text blob (preserve order).
  2) Locate every plausible "N." question header (1..100), in order.
  3) For each question block, parse ①, ②, ③, ④ option spans (in that order).
  4) Skip questions whose option text is empty (image-dependent).
  5) Pull the correct answer from the teacher PDF's compact answer table.
  6) Pull the explanation from the 해설집 PDF (text after "<문제 해설>").

Heuristic: a question with all four options ≥2 chars and a question stem ≥10 chars
is considered self-contained. Otherwise it's flagged or dropped.
"""

import json
import re
from collections import Counter
from pathlib import Path

import pypdf

BASE = Path(__file__).parent
EXAM_ROOT = BASE / "정보처리기사_기출문제"

EXAMS = [
    ("2020_1-2회통합_06-06", "20200606", "2020년 1·2회 통합", "2020-06-06"),
    ("2020_3회_08-22",        "20200822", "2020년 3회",          "2020-08-22"),
    ("2020_4회_09-26",        "20200926", "2020년 4회",          "2020-09-26"),
    ("2021_1회_03-07",        "20210307", "2021년 1회",          "2021-03-07"),
    ("2021_2회_05-15",        "20210515", "2021년 2회",          "2021-05-15"),
    ("2021_3회_08-14",        "20210814", "2021년 3회",          "2021-08-14"),
    ("2022_1회_03-05",        "20220305", "2022년 1회",          "2022-03-05"),
    ("2022_2회_04-24",        "20220424", "2022년 2회",          "2022-04-24"),
]

SUBJECTS = [
    "소프트웨어 설계",
    "소프트웨어 개발",
    "데이터베이스 구축",
    "프로그래밍 언어 활용",
    "정보시스템 구축 관리",
]

OPTION_MARKS_HOLLOW = ["①", "②", "③", "④"]
OPTION_MARKS_FILLED = ["❶", "❷", "❸", "❹"]
HOLLOW_TO_NUM = {m: i + 1 for i, m in enumerate(OPTION_MARKS_HOLLOW)}
FILLED_TO_NUM = {m: i + 1 for i, m in enumerate(OPTION_MARKS_FILLED)}

JUNK_LINES = (
    "전자문제집 CBT : www.comcbt.com",
    "최강 자격증 기출문제 전자문제집 CBT : www.comcbt.com",
    "최강 자격증 기출문제 전자문제집 CBT:www.comcbt.com",
    "기출문제 해설은 최강 자격증 기출문제 전자문제집 CBT:www.comcbt.com통해서 실시간으로 변경됩니다.",
    "최강 자격증 기출문제",  # leftover after splits
    "전자문제집 CBT:www.comcbt.com",
)
HEADER_RE = re.compile(r"정보처리기사\s+◐[^◐◑]*◑\s*")
SUBJECT_LINE_RE = re.compile(r"\d과목\s*:\s*[가-힣 ]+")
CREDIT_RE = re.compile(r"본 해설집은[^.]*감사 드립니다\.")
FOOTER_RE = re.compile(
    r"전자문제집 CBT 홈페이지.*?확인하세요\.", re.DOTALL
)
# In 해설집, the first page intro fragment can leak: "본 해설집은 ... CBT:www.comcbt.com"
SOLUTION_INTRO_RE = re.compile(
    r"본 해설집은[^◐]*?기출문제 및 해설집[^◐]*?◐", re.DOTALL
)


def extract_text(path: Path) -> str:
    reader = pypdf.PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n".join(pages)
    text = SOLUTION_INTRO_RE.sub("", text)
    for j in JUNK_LINES:
        text = text.replace(j, "")
    text = HEADER_RE.sub("", text)
    text = SUBJECT_LINE_RE.sub("", text)
    text = CREDIT_RE.sub("", text)
    text = FOOTER_RE.sub("", text)
    return text


def find_question_spans(text: str) -> list[tuple[int, int, int]]:
    """
    Returns ordered list of (q_num, start, end) for question headers found in `text`.

    A header is the substring "<n>. " where <n> is a question number we expect next
    and the previous character is not another digit. We scan forward, requiring the
    discovered numbers to be strictly increasing (and within 1..100), which prevents
    false positives like "5.0" or "2.4GHz" inside option text.
    """
    spans: list[tuple[int, int]] = []  # (num, position)
    pos = 0
    expected = 1
    while expected <= 100:
        pat = re.compile(rf"(?<![0-9]){expected}\.\s")
        m = pat.search(text, pos)
        if not m:
            # Try skipping this question, look for the next one
            expected += 1
            continue
        spans.append((expected, m.start()))
        pos = m.end()
        expected += 1

    result: list[tuple[int, int, int]] = []
    for i, (num, start) in enumerate(spans):
        end = spans[i + 1][1] if i + 1 < len(spans) else len(text)
        result.append((num, start, end))
    return result


def parse_question_block(block: str) -> tuple[str, list[str]] | None:
    """
    Given a block "N. question text ① opt1 ② opt2 ③ opt3 ④ opt4 [trailing]",
    returns (question_text, [opt1, opt2, opt3, opt4]) or None if parsing fails.
    """
    # Remove leading "N. "
    block = re.sub(r"^\s*\d+\.\s*", "", block, count=1)

    # Find the LAST occurrence of ① that begins a 1→2→3→4 ordered run; pick the first
    # such run actually.
    positions: list[tuple[str, int]] = []
    for m in re.finditer(r"[①②③④❶❷❸❹]", block):
        positions.append((m.group(0), m.start()))

    if len(positions) < 4:
        return None

    # Build a sequence of (num, pos) where num is 1..4 regardless of hollow/filled
    seq: list[tuple[int, int]] = []
    for ch, p in positions:
        if ch in HOLLOW_TO_NUM:
            seq.append((HOLLOW_TO_NUM[ch], p))
        else:
            seq.append((FILLED_TO_NUM[ch], p))

    # Find first run of 4 consecutive elements with values [1,2,3,4]
    found_idx = -1
    for i in range(len(seq) - 3):
        if [seq[i + j][0] for j in range(4)] == [1, 2, 3, 4]:
            found_idx = i
            break
    if found_idx == -1:
        return None

    sel = seq[found_idx : found_idx + 4]
    q_text = block[: sel[0][1]].strip()
    options: list[str] = []
    for j, (num, p) in enumerate(sel):
        opt_start = p + 1  # past the mark char (each is 1 codepoint)
        opt_end = sel[j + 1][1] if j + 1 < 4 else len(block)
        options.append(block[opt_start:opt_end].strip())
    return q_text, options


def parse_answer_key_block(teacher_text: str) -> dict[int, int]:
    """
    The teacher PDF's last page ends with rows like:
      12345678910③③②④④①②④③②11121314...

    We pair up consecutive runs of digits with the run of ①/②/③/④ that follows.
    """
    answers: dict[int, int] = {}
    # Find every run of consecutive ①②③④ chars (10 at a time, usually)
    # Iterate pairs: a digit-run preceding a circle-run.
    pattern = re.compile(r"(\d+)([①②③④❶❷❸❹]+)")
    for m in pattern.finditer(teacher_text):
        digits = m.group(1)
        circles = m.group(2)
        # Parse digit-run as a sequence of question numbers. They're concatenated as
        # 12345678910, 11121314..., etc. Each number is 1-3 digits, but in practice
        # they're always 10 numbers per row, so we expect digits like "12345678910" (11 chars)
        # or "11121314151617181920" (20 chars).
        nums = _parse_concat_numbers(digits)
        if not nums or len(nums) != len(circles):
            continue
        for n, c in zip(nums, circles):
            if c in HOLLOW_TO_NUM:
                answers[n] = HOLLOW_TO_NUM[c]
            else:
                answers[n] = FILLED_TO_NUM[c]
    return answers


def _parse_concat_numbers(s: str) -> list[int] | None:
    """
    Parses concatenated question-number strings like "12345678910" -> [1..10],
    "11121314151617181920" -> [11..20], "919293949596979899100" -> [91..100].

    Strategy: try to split greedily into a run of 10 consecutive integers starting
    from a small start value. We try start values from 1 upward and use the first
    that consumes all characters.
    """
    n = len(s)
    if n == 0:
        return None
    for start in range(1, 92):  # max start is 91 (91..100)
        cur = start
        idx = 0
        consumed = []
        while idx < n:
            # Match cur's digits at idx
            d = str(cur)
            if s.startswith(d, idx):
                consumed.append(cur)
                idx += len(d)
                cur += 1
            else:
                break
        if idx == n and len(consumed) >= 1:
            return consumed
    return None


EXPL_NOISE_RE = re.compile(
    r"본 해설집은[^.]*감사 드립니다\.|"
    r"기출문제 해설은[^.]*변경됩니다\.|"
    r"전자문제집 CBT[: ]?[\w./가-힣()\[\] ]*"
)


def parse_explanation_blocks(expl_text: str) -> dict[int, str]:
    """Given 해설집 text, return {q_num: explanation_text}."""
    spans = find_question_spans(expl_text)
    out: dict[int, str] = {}
    for q_num, start, end in spans:
        block = expl_text[start:end]
        marker = "<문제 해설>"
        idx = block.find(marker)
        if idx == -1:
            continue
        expl = block[idx + len(marker) :].strip()
        # Strip any banner/footer noise that may have crept in
        expl = EXPL_NOISE_RE.sub("", expl)
        expl = re.sub(r"\s*\n\s*", " ", expl)
        expl = re.sub(r"\s{2,}", " ", expl)
        out[q_num] = expl.strip()
    return out


def clean(s: str) -> str:
    s = s.replace("\xa0", " ").replace(" ", " ")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def is_valid_question(q_text: str, options: list[str]) -> bool:
    if len(q_text) < 8:
        return False
    if not q_text.endswith("?") and "?" not in q_text[-15:] and "것은" not in q_text[-15:]:
        # Allow questions ending without ? as long as they're substantial
        if len(q_text) < 20:
            return False
    for opt in options:
        if len(opt.strip()) < 1:
            return False
        # Reject options that are obviously page-noise leftovers
        if opt.strip() in {"-", "_", "—"}:
            return False
    return True


def needs_image(q_text: str, options: list[str]) -> bool:
    cues = [
        "다음 그림", "다음 트리", "다음 표", "아래의 표", "아래 표",
        "다음 보기", "다음과 같은", "그림과 같은",
        "다음 SQL", "다음 코드", "다음 프로그램",
        "다음 (", "다음(",
    ]
    if any(c in q_text for c in cues):
        return True
    # Question text containing "다음" followed shortly by ① likely had a missing chunk
    if "다음" in q_text and len(q_text) < 50:
        return True
    return False


def parse_one_exam(folder: str, code: str, label: str, date: str) -> list[dict]:
    teacher_pdf = EXAM_ROOT / folder / f"정보처리기사{code}(교사용).pdf"
    student_pdf = EXAM_ROOT / folder / f"정보처리기사{code}(학생용).pdf"
    expl_pdf    = EXAM_ROOT / folder / f"정보처리기사{code}(해설집).pdf"

    student_text = extract_text(student_pdf)
    teacher_text = extract_text(teacher_pdf)
    expl_text    = extract_text(expl_pdf)

    answer_key = parse_answer_key_block(teacher_text)
    explanations = parse_explanation_blocks(expl_text)

    spans = find_question_spans(student_text)
    by_num: dict[int, str] = {q: student_text[s:e] for q, s, e in spans}

    results: list[dict] = []
    for q_num in range(1, 101):
        block = by_num.get(q_num)
        if not block:
            continue
        parsed = parse_question_block(block)
        if not parsed:
            continue
        q_text, options = parsed
        q_text = clean(q_text)
        options = [clean(o) for o in options]

        # Drop questions whose extracted options are clearly garbage (image-only options)
        if not is_valid_question(q_text, options):
            continue

        ans = answer_key.get(q_num)
        if not ans:
            # Try to find from the teacher PDF inline (filled marks)
            t_spans = find_question_spans(teacher_text)
            for q2, s, e in t_spans:
                if q2 != q_num:
                    continue
                t_block = teacher_text[s:e]
                for ch in OPTION_MARKS_FILLED:
                    if ch in t_block:
                        ans = FILLED_TO_NUM[ch]
                        break
                break
        if not ans:
            continue

        subj_idx = (q_num - 1) // 20
        subject = SUBJECTS[min(subj_idx, 4)]

        results.append(
            {
                "id": f"{code}-{q_num:03d}",
                "exam": label,
                "examDate": date,
                "qNum": q_num,
                "subject": subject,
                "question": q_text,
                "options": options,
                "answer": ans,
                "explanation": explanations.get(q_num, ""),
                "needsImage": needs_image(q_text, options),
            }
        )
    return results


def main() -> None:
    all_questions: list[dict] = []
    per_exam: list[tuple[str, int]] = []
    for folder, code, label, date in EXAMS:
        qs = parse_one_exam(folder, code, label, date)
        all_questions.extend(qs)
        per_exam.append((label, len(qs)))
        print(f"  · {label}: {len(qs):3d} 문제")

    print(f"\n총 {len(all_questions)} 문제")
    by_subj = Counter(q["subject"] for q in all_questions)
    for s in SUBJECTS:
        print(f"   · {s}: {by_subj[s]}")
    img_flagged = sum(1 for q in all_questions if q["needsImage"])
    print(f"   · 이미지 의존 가능성 플래그: {img_flagged}")

    out = {
        "subjects": SUBJECTS,
        "exams": [{"exam": label, "date": date} for _, _, label, date in EXAMS],
        "perExam": [{"exam": e, "count": c} for e, c in per_exam],
        "totalQuestions": len(all_questions),
        "questions": all_questions,
    }
    out_path = BASE / "site" / "data" / "questions.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n→ {out_path.relative_to(BASE)}")


if __name__ == "__main__":
    main()
