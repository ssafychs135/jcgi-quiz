"""
Extractor for 시나공 (Sinagong) 복원본 PDFs — 2023년 1·2·3회, 2024년 1·2·3회,
2025년 1·2·3회 (9 exam rounds × 100 questions each).

These PDFs are single-file booklets (no separate teacher/explanation PDFs).
The last page carries an answer table like:

      정답
   1.①  2.③  3.④  ...
   ...
   91.② ... 100.③

Question body is laid out across multiple pages in 2 columns. PyMuPDF's
``sort=True`` mode reproduces reading order well enough to parse the
"N. question ① opt1 ② opt2 ③ opt3 ④ opt4" pattern out of the joined text.

Output: extends site/data/questions.json (merged with the comcbt 8 rounds).
Each question is tagged with ``source: "sinagong-restored"`` so the UI can
warn users that these are unofficial restored copies.
"""

import json
import re
from pathlib import Path

import fitz  # PyMuPDF

BASE = Path(__file__).parent
SITE = BASE / "site"
PDF_ROOT = SITE / "data" / "pdfs"
PDF_REL_PREFIX = "data/pdfs"

# (folder name, exam label, exam date)
EXAMS_SINAGONG = [
    ("2023_1회_복원본", "2023년 1회 (복원본)", "2023-03"),
    ("2023_2회_복원본", "2023년 2회 (복원본)", "2023-05"),
    ("2023_3회_복원본", "2023년 3회 (복원본)", "2023-08"),
    ("2024_1회_복원본", "2024년 1회 (복원본)", "2024-03"),
    ("2024_2회_복원본", "2024년 2회 (복원본)", "2024-05"),
    ("2024_3회_복원본", "2024년 3회 (복원본)", "2024-08"),
    ("2025_1회_복원본", "2025년 1회 (복원본)", "2025-03"),
    ("2025_2회_복원본", "2025년 2회 (복원본)", "2025-05"),
    ("2025_3회_복원본", "2025년 3회 (복원본)", "2025-08"),
]

SUBJECTS = [
    "소프트웨어 설계",
    "소프트웨어 개발",
    "데이터베이스 구축",
    "프로그래밍 언어 활용",
    "정보시스템 구축 관리",
]

HOLLOW = {"①": 1, "②": 2, "③": 3, "④": 4}

# Lines that appear on every Sinagong page header
NOISE_PATTERNS = [
    re.compile(r"^\s*\d+\s*회\s*$", re.MULTILINE),                # "1 회"
    re.compile(r"^\s*-\s*\d+\s*-\s*$", re.MULTILINE),             # "- 1 -"
    re.compile(r"기출문제\s*&\s*정답\s*및\s*해설"),
    re.compile(r"\d{4}년\s*\d+회\s*정보처리기사\s*필기"),
    re.compile(r"※\s*다음 문제를 읽고[^?]+표기하시오[^.]*\."),
    re.compile(r"답란.*?에 표기하시오\.", re.DOTALL),
    re.compile(r"저작권 안내.*?수\s*없습니다\.", re.DOTALL),
    re.compile(r"이 자료는 시나공 카페[^.]*\.", re.DOTALL),
    re.compile(r"제\s*과목\s*\d", re.MULTILINE),                  # "제과목1"
    # subject-row markers: e.g. "소프트웨어 설계" alone on a line is informative
    # but the subject is inferable from question number (1–20 / 21–40 / ...)
]


def _page_text_two_columns(page) -> str:
    """
    Read a 2-column page in proper column-major order by physically clipping
    the page into a left rect and a right rect, then asking PyMuPDF to extract
    each rect separately. This avoids the cross-column block interleaving that
    happens with `sort=True` on the full page.

    A small overlap (8px) past the midline catches characters whose bounding
    boxes straddle the column gutter without leaking entire sentences across.
    """
    W = page.rect.width
    H = page.rect.height
    mid = W / 2
    left_rect = fitz.Rect(0, 0, mid, H)
    right_rect = fitz.Rect(mid, 0, W, H)
    left = page.get_text("text", clip=left_rect, sort=True)
    right = page.get_text("text", clip=right_rect, sort=True)
    return left + "\n" + right


def _page_text_single_column(page) -> str:
    """Plain top-to-bottom reading for the answer-key page (single column)."""
    return page.get_text("text", sort=True)


def extract_full_text(path: Path) -> tuple[str, str]:
    """
    Returns (body_text, last_page_text).

    Body pages: read 2-column. Last page (answer key): single column.
    """
    doc = fitz.open(str(path))
    n = doc.page_count
    if n == 0:
        doc.close()
        return "", ""
    body_pages = [_page_text_two_columns(doc[i]) for i in range(n - 1)]
    last = _page_text_single_column(doc[n - 1])
    doc.close()
    return "\n".join(body_pages), last


def strip_noise(text: str) -> str:
    for pat in NOISE_PATTERNS:
        text = pat.sub("", text)
    # Collapse runs of blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def parse_answer_key(last_page: str) -> dict[int, int]:
    """
    Sinagong answer table looks like:
       정답
       1.①  2.③  3.④ ...
       ...
       91.② 92.① ... 100.④

    Sometimes spaces collapse: "12.①13.①14.③15.①16.②". Just regex match every
    occurrence of digits + dot + ①②③④.
    """
    answers: dict[int, int] = {}
    for m in re.finditer(r"(\d{1,3})\.\s*([①②③④])", last_page):
        n = int(m.group(1))
        if 1 <= n <= 100:
            answers[n] = HOLLOW[m.group(2)]
    return answers


def split_questions(body: str) -> dict[int, str]:
    """
    Find each "N. <stuff until N+1.>" block, for N in 1..100.

    We scan sequentially for the next expected number (1, then 2, then 3, ...).
    If a number is missing, we skip it but keep going. The body text doesn't
    repeat numbers 1..100 in a way that confuses the parser as long as we use
    a `(?<![0-9])N\.\s` lookbehind to avoid mid-token false hits.
    """
    blocks: dict[int, str] = {}
    # Build a list of plausible (num, position) headers.
    found: list[tuple[int, int]] = []
    pos = 0
    expected = 1
    while expected <= 100:
        pat = re.compile(rf"(?<![0-9]){expected}\.\s")
        m = pat.search(body, pos)
        if not m:
            expected += 1
            continue
        found.append((expected, m.start()))
        pos = m.end()
        expected += 1

    for i, (n, start) in enumerate(found):
        end = found[i + 1][1] if i + 1 < len(found) else len(body)
        blocks[n] = body[start:end].strip()
    return blocks


def parse_one_block(block: str) -> tuple[str, list[str]] | None:
    """
    A question block looks like (whitespace varies, ① etc on own lines):
      "1. 소프트웨어 공학에서 워크스루(Walkthrough)에 대한 설명으로 ...
       ① 사용사례를 ...
       ② 복잡한 알고리즘 ...
       ③ 인스펙션(Inspection)과 ...
       ④ 단순한 테스트 케이스를 ...  "

    Returns (question_text, [opt1, opt2, opt3, opt4]) or None.
    """
    block = re.sub(r"^\s*\d+\.\s*", "", block, count=1)

    # All marker positions
    marks = [(m.start(), HOLLOW[m.group(0)]) for m in re.finditer(r"[①②③④]", block)]
    if len(marks) < 4:
        return None
    # Find the first 4 in 1,2,3,4 order
    sel = None
    for i in range(len(marks) - 3):
        if [marks[i + j][1] for j in range(4)] == [1, 2, 3, 4]:
            sel = marks[i : i + 4]
            break
    if not sel:
        return None

    q_text = block[: sel[0][0]].strip()
    opts: list[str] = []
    for j, (p, _) in enumerate(sel):
        s = p + 1
        e = sel[j + 1][0] if j + 1 < 4 else len(block)
        opts.append(block[s:e].strip())
    return q_text, opts


def clean(s: str) -> str:
    s = s.replace("\xa0", " ")
    # Collapse internal whitespace runs (including newlines from PDF columns)
    s = re.sub(r"\s+", " ", s)
    s = s.strip()
    # Strip a trailing single hangul char that occasionally leaks from the
    # next column (e.g. "...ORDER BY 판매액 DESC; 록"). Safe because legitimate
    # Korean exam answers don't end on a lone non-final syllable.
    s = re.sub(r"[\s\.\,\;\:\)\]\}\"\'’”]?\s+[가-힣]$", lambda m: m.group(0)[:-1].rstrip(), s)
    # Same for trailing "- N -" page-number debris
    s = re.sub(r"\s*-\s*\d+\s*-\s*$", "", s)
    return s.strip()


def needs_image(q_text: str, options: list[str]) -> bool:
    cues = [
        "다음 그림", "다음 트리", "다음 표", "아래 표", "아래의 표",
        "다음 SQL", "다음 코드", "다음 프로그램",
        "다음과 같은", "그림과 같은",
        "다음 보기", "다음에서 설명", "다음의 ",
        "다음 릴레이션", "다음과 같이",
    ]
    if any(c in q_text for c in cues):
        return True
    if "다음" in q_text and len(q_text) < 60:
        return True
    return False


def is_valid(q_text: str, opts: list[str]) -> bool:
    if len(q_text) < 8:
        return False
    if all(len(o.strip()) < 1 for o in opts):
        return False
    # At least 3 of 4 options should be non-trivial
    nonempty = sum(1 for o in opts if len(o.strip()) >= 1)
    return nonempty == 4


def parse_one_exam(folder: str, label: str, date: str) -> list[dict]:
    pdf_path = next(iter((PDF_ROOT / folder).glob("*.pdf")), None)
    if not pdf_path:
        print(f"  [skip] no PDF found in {folder}")
        return []
    body, last_page = extract_full_text(pdf_path)
    body = strip_noise(body)
    last_page = strip_noise(last_page)

    answers = parse_answer_key(last_page)
    blocks = split_questions(body)

    # Use the exam code as the YYYY[1-3] tag for question IDs
    # e.g., "2023_1회_복원본" → "20231"
    m = re.match(r"(\d{4})_(\d)회", folder)
    code = f"{m.group(1)}{m.group(2)}r" if m else folder

    results: list[dict] = []
    for q_num in range(1, 101):
        block = blocks.get(q_num)
        if not block:
            continue
        parsed = parse_one_block(block)
        if not parsed:
            continue
        q_text, opts = parsed
        q_text = clean(q_text)
        opts = [clean(o) for o in opts]
        if not is_valid(q_text, opts):
            continue
        ans = answers.get(q_num)
        if not ans:
            continue
        subj = SUBJECTS[min((q_num - 1) // 20, 4)]
        results.append({
            "id": f"sg-{code}-{q_num:03d}",
            "exam": label,
            "examDate": date,
            "qNum": q_num,
            "subject": subj,
            "question": q_text,
            "options": opts,
            "answer": ans,
            "explanation": "",       # Sinagong PDFs ship without per-question explanations
            "needsImage": needs_image(q_text, opts),
            "source": "sinagong-restored",
        })
    return results


def main():
    out_path = SITE / "data" / "questions.json"
    with out_path.open(encoding="utf-8") as f:
        existing = json.load(f)

    # Mark existing comcbt questions as "official" if not already tagged
    for q in existing["questions"]:
        q.setdefault("source", "comcbt-official")

    new_exam_meta = []
    new_per_exam = []
    new_questions: list[dict] = []
    for folder, label, date in EXAMS_SINAGONG:
        qs = parse_one_exam(folder, label, date)
        new_questions.extend(qs)
        new_per_exam.append({"exam": label, "count": len(qs)})
        # Single PDF, so all three buttons point to the same file (학생용 only)
        pdf = next(iter((PDF_ROOT / folder).glob("*.pdf")), None)
        rel = f"{PDF_REL_PREFIX}/{folder}/{pdf.name}" if pdf else ""
        new_exam_meta.append({
            "exam": label,
            "date": date,
            "code": folder,
            "folder": folder,
            "source": "sinagong-restored",
            "files": {"student": rel, "teacher": "", "explanation": ""},
        })
        print(f"  · {label}: {len(qs)} 문제")

    # Merge into existing JSON
    existing["exams"].extend(new_exam_meta)
    existing["perExam"].extend(new_per_exam)
    existing["questions"].extend(new_questions)
    existing["totalQuestions"] = len(existing["questions"])

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=1)

    print()
    print(f"시나공 추가: {len(new_questions)} 문제")
    print(f"전체 합계  : {existing['totalQuestions']} 문제 ({len(existing['exams'])} 회차)")


if __name__ == "__main__":
    main()
