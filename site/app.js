// 정처기 필기 문제풀이 - SPA entry
// Pure vanilla JS, hash routing, localStorage persistence.
//
// XSS posture: All dynamic interpolations go through `esc()`. Static HTML
// templates are written as tagged template literals via `tpl`. Rendering uses
// `render(el, html)` which constructs a fragment and swaps it in place of the
// element's children — equivalent to assigning innerHTML, but avoids the
// pattern at the call site.

const STORE_KEY = "jcgi-quiz-state-v1";
const RESULTS_TO_KEEP = 50;

const App = {
  questions: [],
  subjects: [],
  exams: [],
  state: loadState(),
  session: null,
};

// ─── Persistence ────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return mergeDefaults(JSON.parse(raw));
  } catch (e) {
    console.warn("state load failed:", e);
  }
  return mergeDefaults({});
}
function mergeDefaults(s) {
  return {
    history: s.history || {},
    bookmarks: s.bookmarks || {},
    wrongs: s.wrongs || {},
    results: s.results || [],
  };
}
function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(App.state));
}

// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const res = await fetch("data/questions.json");
    const data = await res.json();
    App.questions = data.questions;
    App.subjects = data.subjects;
    App.exams = data.exams;
    document.getElementById("footer-total").textContent = data.totalQuestions;
  } catch (e) {
    render(app(), tpl`
      <div class="card">
        <h2>📚 자료를 불러올 수 없습니다</h2>
        <p>이 사이트는 같은 폴더의 <code>data/questions.json</code> 파일이 필요합니다.</p>
        <p>로컬에서 보려면 사이트 폴더에서 다음 명령을 실행하고 표시되는 URL을 여세요:</p>
        <pre>python3 -m http.server 8000 -d site</pre>
        <p class="muted small">에러: ${e.message}</p>
      </div>`);
    return;
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("keydown", onKey);
  route();
}

// ─── Router ─────────────────────────────────────────────────────────────────
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/");
  const base = parts[1] || "";
  const rest = parts.slice(2);
  highlightNav(`/${base}`);
  if (!base) return renderHome();
  if (base === "practice") return renderPracticeMenu();
  if (base === "stats") return renderStats();
  if (base === "data") return renderDataPage();
  if (base === "quiz") return startQuiz(rest);
  if (base === "result") return renderResult();
  renderHome();
}

function highlightNav(path) {
  document.querySelectorAll(".top-nav a").forEach((a) => {
    a.classList.toggle("is-active", a.getAttribute("data-route") === path);
  });
}

function navigate(hash) {
  if (location.hash === "#" + hash) {
    route();
  } else {
    location.hash = hash;
  }
}

// ─── Home ───────────────────────────────────────────────────────────────────
function renderHome() {
  const total = App.questions.length;
  const answered = Object.keys(App.state.history).length;
  const correctCount = Object.values(App.state.history).filter(h => h.correct).length;
  const accuracy = answered ? Math.round((correctCount / answered) * 100) : 0;
  const wrongs = Object.keys(App.state.wrongs).length;

  render(app(), tpl`
    <section class="hero">
      <h1>정보처리기사 필기 기출 문제풀이</h1>
      <p>2020년 1·2회부터 2022년 2회까지, 8개 회차에서 추출한 ${total}문제</p>
      <div class="hero-stats">
        <div class="hero-stat"><div class="num">${answered}</div><div class="lbl">풀어본 문제</div></div>
        <div class="hero-stat"><div class="num">${accuracy}%</div><div class="lbl">정답률</div></div>
        <div class="hero-stat"><div class="num">${wrongs}</div><div class="lbl">오답노트</div></div>
      </div>
    </section>

    <div class="section-title">학습 모드</div>
    <div class="mode-grid">
      <a class="mode-card is-primary" href="#/practice">
        <div class="icon">🎯</div>
        <div class="ttl">문제풀이 시작</div>
        <div class="desc">회차별 / 과목별 / 랜덤 / 즐겨찾기에서 골라 풀기</div>
      </a>
      <a class="mode-card" href="#/quiz/random/30">
        <div class="icon">⚡</div>
        <div class="ttl">빠른 30문제</div>
        <div class="desc">5과목에서 랜덤 30문제, 약 15분</div>
      </a>
      <a class="mode-card" href="#/quiz/wrongs">
        <div class="icon">📝</div>
        <div class="ttl">오답노트 다시 풀기</div>
        <div class="desc">${wrongs}개 문제</div>
      </a>
      <a class="mode-card" href="#/stats">
        <div class="icon">📊</div>
        <div class="ttl">진도·통계</div>
        <div class="desc">과목별, 회차별 정답률 보기</div>
      </a>
    </div>

    <div class="section-title">최근 결과</div>
    ${raw(renderRecentResults())}
  `);
}

function renderRecentResults() {
  const r = App.state.results.slice(-5).reverse();
  if (!r.length) {
    return tplStr`<div class="card muted center small">아직 완료한 세션이 없어요.</div>`;
  }
  const rows = r.map(x => tplStr`
    <tr style="border-top:1px solid var(--hairline);">
      <td style="padding:0.55rem 0;">${formatDate(x.date)}</td>
      <td>${x.mode}</td>
      <td>${x.label}</td>
      <td style="text-align:right; font-weight:600;">
        ${x.correct} / ${x.total} (${Math.round(x.correct/x.total*100)}%)
      </td>
    </tr>`).join("");
  return tplStr`<div class="card">
    <table style="width:100%; border-collapse: collapse; font-size:0.92rem;">
      <thead>
        <tr style="text-align:left; color:var(--muted); font-weight:500;">
          <th style="padding:0.4rem 0;">일자</th>
          <th>모드</th>
          <th>대상</th>
          <th style="text-align:right;">점수</th>
        </tr>
      </thead>
      <tbody>${raw(rows)}</tbody>
    </table>
  </div>`;
}

// ─── Practice menu ──────────────────────────────────────────────────────────
function renderPracticeMenu() {
  const examCounts = countBy(q => q.exam);
  const subjCounts = countBy(q => q.subject);
  const bookmarks = Object.keys(App.state.bookmarks).length;
  const wrongs = Object.keys(App.state.wrongs).length;

  const examCards = App.exams.map(e => tplStr`
    <a class="choice" href="#/quiz/exam/${encodeURIComponent(e.exam)}">
      <div class="ch-ttl">${e.exam}</div>
      <div class="ch-meta">${e.date} · ${examCounts[e.exam] || 0}문제</div>
    </a>`).join("");

  const subjCards = App.subjects.map(s => tplStr`
    <a class="choice" href="#/quiz/subject/${encodeURIComponent(s)}">
      <div class="ch-ttl">${s}</div>
      <div class="ch-meta">${subjCounts[s] || 0}문제</div>
    </a>`).join("");

  render(app(), tpl`
    <h2>문제풀이 모드 선택</h2>

    <div class="section-title">랜덤 학습</div>
    <div class="btn-row">
      <a class="btn" href="#/quiz/random/10">랜덤 10문제</a>
      <a class="btn" href="#/quiz/random/30">랜덤 30문제</a>
      <a class="btn" href="#/quiz/random/50">랜덤 50문제</a>
      <a class="btn btn-primary" href="#/quiz/random/100">실전 100문제</a>
    </div>

    <div class="section-title">회차별 (한 회 100문제)</div>
    <div class="choice-grid">${raw(examCards)}</div>

    <div class="section-title">과목별</div>
    <div class="choice-grid">${raw(subjCards)}</div>

    <div class="section-title">복습</div>
    <div class="btn-row">
      <a class="btn" href="#/quiz/wrongs">📝 오답노트 (${wrongs}문제)</a>
      <a class="btn" href="#/quiz/bookmarks">⭐ 북마크 (${bookmarks}문제)</a>
      <a class="btn" href="#/quiz/unseen/30">🆕 아직 안 푼 문제 (30개)</a>
    </div>
  `);
}

function countBy(fn) {
  const c = {};
  for (const q of App.questions) c[fn(q)] = (c[fn(q)] || 0) + 1;
  return c;
}

// ─── Quiz session ───────────────────────────────────────────────────────────
function startQuiz(rest) {
  const [mode, arg] = rest;
  let ids = [];
  let label = "";

  if (mode === "random") {
    const n = Math.min(parseInt(arg, 10) || 30, App.questions.length);
    ids = shuffle(App.questions.map(q => q.id)).slice(0, n);
    label = `랜덤 ${n}문제`;
  } else if (mode === "exam") {
    const exam = decodeURIComponent(arg);
    ids = App.questions.filter(q => q.exam === exam).map(q => q.id);
    label = exam;
  } else if (mode === "subject") {
    const subj = decodeURIComponent(arg);
    ids = shuffle(App.questions.filter(q => q.subject === subj).map(q => q.id));
    label = subj;
  } else if (mode === "wrongs") {
    ids = shuffle(Object.keys(App.state.wrongs));
    label = "오답노트";
  } else if (mode === "bookmarks") {
    ids = shuffle(Object.keys(App.state.bookmarks));
    label = "북마크";
  } else if (mode === "unseen") {
    const n = parseInt(arg, 10) || 30;
    const seen = new Set(Object.keys(App.state.history));
    ids = shuffle(App.questions.filter(q => !seen.has(q.id)).map(q => q.id)).slice(0, n);
    label = `미풀이 ${ids.length}문제`;
  } else if (mode === "retry") {
    if (!App.session) { navigate("/practice"); return; }
    // already set up by retry-wrongs action
    renderQuiz();
    return;
  } else {
    navigate("/practice");
    return;
  }

  if (!ids.length) {
    render(app(), tpl`
      <div class="card empty">
        <div style="font-size:2rem;">🌱</div>
        <p>풀 문제가 없습니다.</p>
        <a class="btn" href="#/practice">← 문제풀이 모드로</a>
      </div>`);
    return;
  }

  App.session = {
    mode, label, ids,
    idx: 0,
    responses: ids.map(() => null),
    revealed: ids.map(() => false),
    explained: ids.map(() => false),
    startedAt: Date.now(),
  };
  renderQuiz();
}

function renderQuiz() {
  const s = App.session;
  if (!s) return navigate("/");
  const q = App.questions.find(x => x.id === s.ids[s.idx]);
  if (!q) return navigate("/practice");

  const resp = s.responses[s.idx];
  const showFeedback = s.revealed[s.idx];
  const showExpl = s.explained[s.idx];
  const bookmarked = !!App.state.bookmarks[q.id];

  const optsHTML = q.options.map((opt, i) => {
    const n = i + 1;
    let cls = "option";
    if (showFeedback) {
      if (n === q.answer) cls += " is-correct";
      else if (resp && n === resp.choice) cls += " is-wrong";
    } else if (resp && resp.choice === n) {
      cls += " is-selected";
    }
    return tplStr`<button class="${cls}" data-opt="${n}">
      <span class="opt-num">${n}</span>
      <span>${opt}</span>
    </button>`;
  }).join("");

  const answeredCount = s.responses.filter(r => r !== null).length;
  const correctCount = s.responses.filter(r => r && r.correct).length;
  const progressPct = Math.round((s.idx + 1) / s.ids.length * 100);

  const feedbackHTML = !showFeedback ? "" :
    (resp.correct
      ? tplStr`<div class="feedback correct">✅ 정답입니다!</div>`
      : tplStr`<div class="feedback wrong">❌ 정답은 ${q.answer}번 — ${q.options[q.answer - 1]}</div>`);

  const explHTML = showExpl ? renderExplanation(q) : "";

  const imgWarning = q.needsImage ? tplStr`<div class="image-warning">⚠ 이 문제는 원본 시험지의 그림이나 표/SQL/코드를 참조합니다. 텍스트만으로 풀기 어려울 수 있어요.</div>` : "";
  const imgTag = q.needsImage ? tplStr`<span class="tag tag-warning">⚠ 그림/표 참조</span>` : "";

  const rightAction = !showFeedback
    ? tplStr`<button class="btn btn-primary" data-act="submit" ${raw(resp ? "" : "disabled")}>확인 (Enter)</button>`
    : (s.idx < s.ids.length - 1
      ? tplStr`<button class="btn btn-primary" data-act="next">다음 →</button>`
      : tplStr`<button class="btn btn-primary" data-act="finish">결과 보기 →</button>`);

  const explBtn = showFeedback ? tplStr`<button class="btn" data-act="toggle-expl" title="단축키 E">${showExpl ? "해설 숨기기" : "💡 해설 보기"}</button>` : "";

  render(app(), tpl`
    <div class="quiz-bar">
      <div class="label-block">
        <div>${s.label}</div>
        <div class="quiz-meta">
          <span>${s.idx + 1} / ${s.ids.length}</span>
          <span>·</span>
          <span class="tag">${q.subject}</span>
          <span class="tag tag-primary">${q.exam} ${q.qNum}번</span>
          ${raw(imgTag)}
        </div>
        <div class="progress"><span style="width:${progressPct}%"></span></div>
      </div>
      <div class="quiz-meta">
        <span>맞춤 ${correctCount} · 답함 ${answeredCount}</span>
        <a class="btn btn-ghost" href="#/practice" title="모드 변경">← 모드</a>
      </div>
    </div>

    <div class="quiz-card">
      <div class="question-text">${q.question}</div>
      ${raw(imgWarning)}
      <div class="options" id="opts">${raw(optsHTML)}</div>

      ${raw(feedbackHTML)}
      ${raw(explHTML)}

      <div class="quiz-actions">
        <div class="left">
          <button class="btn" data-act="prev" ${raw(s.idx === 0 ? "disabled" : "")}>← 이전</button>
          <button class="btn" data-act="bookmark" title="단축키 B">${bookmarked ? "★ 북마크됨" : "☆ 북마크"}</button>
          ${raw(explBtn)}
        </div>
        <div class="right">${raw(rightAction)}</div>
      </div>
    </div>
  `);

  // Hook up clicks
  document.querySelectorAll(".option").forEach(el => {
    el.addEventListener("click", () => {
      if (s.revealed[s.idx]) return;
      const n = parseInt(el.getAttribute("data-opt"), 10);
      s.responses[s.idx] = { choice: n, correct: n === q.answer };
      renderQuiz();
    });
  });
  document.querySelectorAll("[data-act]").forEach(b => {
    b.addEventListener("click", () => action(b.getAttribute("data-act")));
  });
}

function renderExplanation(q) {
  if (!q.explanation || !q.explanation.trim()) {
    return tplStr`<div class="explanation is-empty">해설이 제공되지 않은 문제입니다.</div>`;
  }
  return tplStr`<div class="explanation"><strong>해설</strong><br/>${q.explanation}</div>`;
}

function action(act) {
  const s = App.session;
  if (!s) return;
  const q = App.questions.find(x => x.id === s.ids[s.idx]);

  switch (act) {
    case "submit": {
      const resp = s.responses[s.idx];
      if (!resp) return;
      s.revealed[s.idx] = true;
      s.explained[s.idx] = true;
      App.state.history[q.id] = {
        lastSeen: Date.now(),
        lastAnswer: resp.choice,
        correct: resp.correct,
      };
      if (resp.correct) delete App.state.wrongs[q.id];
      else App.state.wrongs[q.id] = true;
      saveState();
      renderQuiz();
      break;
    }
    case "next":
      if (s.idx < s.ids.length - 1) { s.idx++; renderQuiz(); }
      break;
    case "prev":
      if (s.idx > 0) { s.idx--; renderQuiz(); }
      break;
    case "finish": finish(); break;
    case "bookmark":
      if (App.state.bookmarks[q.id]) delete App.state.bookmarks[q.id];
      else App.state.bookmarks[q.id] = true;
      saveState();
      renderQuiz();
      break;
    case "toggle-expl":
      s.explained[s.idx] = !s.explained[s.idx];
      renderQuiz();
      break;
  }
}

function finish() {
  const s = App.session;
  if (!s) return;
  const correct = s.responses.filter(r => r && r.correct).length;
  const total = s.ids.length;
  App.state.results.push({
    date: Date.now(),
    mode: s.mode,
    label: s.label,
    total, correct,
  });
  if (App.state.results.length > RESULTS_TO_KEEP) {
    App.state.results = App.state.results.slice(-RESULTS_TO_KEEP);
  }
  saveState();
  navigate("/result");
}

function renderResult() {
  const s = App.session;
  if (!s) return navigate("/");
  const correct = s.responses.filter(r => r && r.correct).length;
  const total = s.ids.length;
  const pct = Math.round(correct / total * 100);
  const wrongIds = s.ids.filter((_, i) => s.responses[i] && !s.responses[i].correct);
  const skipped = s.ids.filter((_, i) => !s.responses[i]);

  const msg = pct >= 80 ? "🎉 훌륭해요! 합격권입니다."
            : pct >= 60 ? "📈 합격 가능권 — 오답을 다시 확인해 보세요."
            : pct >= 40 ? "💪 더 풀어볼수록 점수가 오릅니다."
            : "🌱 천천히 한 회씩 풀어 보세요.";

  const wrongList = wrongIds.map(id => {
    const q = App.questions.find(x => x.id === id);
    const idx = s.ids.indexOf(id);
    const r = s.responses[idx];
    return tplStr`<div style="padding:0.6rem 0; border-top:1px solid var(--hairline);">
      <div class="small muted">${q.exam} ${q.qNum}번 · ${q.subject}</div>
      <div style="font-weight:500;">${q.question}</div>
      <div class="small" style="margin-top:0.2rem;">
        <span class="tag tag-danger">내 답 ${r.choice}번</span>
        <span class="tag tag-success">정답 ${q.answer}번 — ${q.options[q.answer - 1]}</span>
      </div>
    </div>`;
  }).join("");

  const retryBtn = wrongIds.length
    ? tplStr`<button class="btn btn-primary" id="retry-wrongs">틀린 ${wrongIds.length}문제 다시 풀기</button>`
    : "";

  const wrongSection = wrongIds.length ? tplStr`
    <div class="card">
      <h3 style="margin-top:0;">틀린 문제</h3>
      ${raw(wrongList)}
    </div>` : "";

  const skippedSection = skipped.length ? tplStr`<div class="card small muted">건너뛴 문제: ${skipped.length}개</div>` : "";

  render(app(), tpl`
    <div class="card result-summary">
      <div class="muted">${s.label}</div>
      <div class="score">${correct} / ${total}</div>
      <div class="muted small" style="margin-top:0.2rem;">${pct}%</div>
      <div class="msg">${msg}</div>
      <div class="result-actions">
        ${raw(retryBtn)}
        <a class="btn" href="#/practice">다른 모드로</a>
        <a class="btn" href="#/stats">진도·통계</a>
        <a class="btn" href="#/">홈</a>
      </div>
    </div>
    ${raw(wrongSection)}
    ${raw(skippedSection)}
  `);

  document.getElementById("retry-wrongs")?.addEventListener("click", () => {
    App.session = {
      mode: "wrongs-retry",
      label: `${s.label} 중 틀린 문제 다시 풀기`,
      ids: wrongIds,
      idx: 0,
      responses: wrongIds.map(() => null),
      revealed: wrongIds.map(() => false),
      explained: wrongIds.map(() => false),
      startedAt: Date.now(),
    };
    location.hash = "#/quiz/retry";
  });
}

// ─── Stats ──────────────────────────────────────────────────────────────────
function renderStats() {
  const h = App.state.history;
  const total = App.questions.length;
  const answered = Object.keys(h).length;
  const correct = Object.values(h).filter(r => r.correct).length;
  const wrong = answered - correct;
  const accuracy = answered ? Math.round(correct / answered * 100) : 0;

  const subjStats = {};
  for (const subj of App.subjects) subjStats[subj] = { total: 0, answered: 0, correct: 0 };
  for (const q of App.questions) {
    subjStats[q.subject].total++;
    if (h[q.id]) {
      subjStats[q.subject].answered++;
      if (h[q.id].correct) subjStats[q.subject].correct++;
    }
  }
  const examStats = {};
  for (const e of App.exams) examStats[e.exam] = { total: 0, answered: 0, correct: 0 };
  for (const q of App.questions) {
    examStats[q.exam].total++;
    if (h[q.id]) {
      examStats[q.exam].answered++;
      if (h[q.id].correct) examStats[q.exam].correct++;
    }
  }

  const subjBars = App.subjects.map(s => barRow(s, subjStats[s])).join("");
  const examBars = App.exams.map(e => barRow(e.exam, examStats[e.exam])).join("");

  render(app(), tpl`
    <h2>진도·통계</h2>

    <div class="stat-grid">
      <div class="stat-card"><div class="lbl">총 문제</div><div class="num">${total}</div></div>
      <div class="stat-card"><div class="lbl">풀어본 문제</div><div class="num">${answered}</div></div>
      <div class="stat-card"><div class="lbl">정답</div><div class="num" style="color:var(--success)">${correct}</div></div>
      <div class="stat-card"><div class="lbl">오답</div><div class="num" style="color:var(--error)">${wrong}</div></div>
      <div class="stat-card"><div class="lbl">전체 정답률</div><div class="num">${accuracy}%</div></div>
    </div>

    <div class="section-title">과목별 정답률</div>
    <div class="card">
      <div class="bar-chart">${raw(subjBars)}</div>
    </div>

    <div class="section-title">회차별 정답률</div>
    <div class="card">
      <div class="bar-chart">${raw(examBars)}</div>
    </div>

    <div class="section-title">최근 세션</div>
    ${raw(renderRecentResults())}

    <div class="section-title">데이터</div>
    <div class="btn-row">
      <a class="btn" href="#/data">데이터 관리 (백업·복원·초기화)</a>
    </div>
  `);
}

function barRow(name, s) {
  const pct = s.answered ? Math.round(s.correct / s.answered * 100) : 0;
  const w = s.answered ? pct : 0;
  return tplStr`<div class="bar-row">
    <div class="name" title="${name}">${name}</div>
    <div class="bar"><span style="width:${w}%"></span></div>
    <div class="val">${s.correct}/${s.answered} <span class="muted small">·${pct}%</span></div>
  </div>`;
}

// ─── Data management ────────────────────────────────────────────────────────
function renderDataPage() {
  const counts = {
    answered: Object.keys(App.state.history).length,
    wrongs: Object.keys(App.state.wrongs).length,
    bookmarks: Object.keys(App.state.bookmarks).length,
    results: App.state.results.length,
  };

  render(app(), tpl`
    <h2>데이터 관리</h2>
    <div class="card">
      <h3 style="margin-top:0;">백업</h3>
      <p class="muted small">학습 진도·오답·북마크·세션 기록을 JSON으로 내려받아 다른 기기에서 복원할 수 있어요.</p>
      <div class="btn-row">
        <button class="btn btn-primary" id="export">JSON으로 내려받기</button>
        <label class="btn" style="cursor:pointer">
          파일로부터 가져오기
          <input type="file" id="import-file" accept="application/json" hidden />
        </label>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">현재 저장된 내용</h3>
      <div class="stat-grid">
        <div class="stat-card"><div class="lbl">답한 문제</div><div class="num">${counts.answered}</div></div>
        <div class="stat-card"><div class="lbl">오답노트</div><div class="num">${counts.wrongs}</div></div>
        <div class="stat-card"><div class="lbl">북마크</div><div class="num">${counts.bookmarks}</div></div>
        <div class="stat-card"><div class="lbl">완료 세션</div><div class="num">${counts.results}</div></div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0; color:var(--error);">위험 영역</h3>
      <p class="muted small">아래 작업은 되돌릴 수 없어요. 미리 백업을 받아두세요.</p>
      <div class="btn-row">
        <button class="btn" id="clear-history">진도/정답 기록 초기화</button>
        <button class="btn" id="clear-wrongs">오답노트만 비우기</button>
        <button class="btn" id="clear-bookmarks">북마크만 비우기</button>
        <button class="btn btn-danger" id="clear-all">모두 초기화</button>
      </div>
    </div>
  `);

  document.getElementById("export").onclick = () => {
    const blob = new Blob([JSON.stringify(App.state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jcgi-quiz-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  document.getElementById("import-file").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      App.state = mergeDefaults(data);
      saveState();
      alert("불러왔습니다.");
      renderDataPage();
    } catch (err) {
      alert("가져오기 실패: " + err.message);
    }
  };
  document.getElementById("clear-history").onclick = () => {
    if (confirm("진도/정답 기록을 모두 비울까요?")) { App.state.history = {}; saveState(); renderDataPage(); }
  };
  document.getElementById("clear-wrongs").onclick = () => {
    if (confirm("오답노트를 비울까요?")) { App.state.wrongs = {}; saveState(); renderDataPage(); }
  };
  document.getElementById("clear-bookmarks").onclick = () => {
    if (confirm("북마크를 비울까요?")) { App.state.bookmarks = {}; saveState(); renderDataPage(); }
  };
  document.getElementById("clear-all").onclick = () => {
    if (confirm("정말로 모든 데이터를 초기화할까요? 되돌릴 수 없어요.")) {
      App.state = mergeDefaults({});
      saveState();
      renderDataPage();
    }
  };
}

// ─── Keyboard shortcuts ─────────────────────────────────────────────────────
function onKey(e) {
  const tgt = e.target;
  if (tgt && typeof tgt.matches === "function" && tgt.matches("input, textarea")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!App.session || !location.hash.startsWith("#/quiz")) return;
  const s = App.session;
  const q = App.questions.find(x => x.id === s.ids[s.idx]);
  if (!q) return;

  if (e.key >= "1" && e.key <= "4") {
    if (s.revealed[s.idx]) return;
    const n = parseInt(e.key, 10);
    s.responses[s.idx] = { choice: n, correct: n === q.answer };
    renderQuiz();
    e.preventDefault();
  } else if (e.key === "Enter") {
    if (!s.revealed[s.idx] && s.responses[s.idx]) {
      action("submit");
    } else if (s.revealed[s.idx]) {
      if (s.idx < s.ids.length - 1) action("next");
      else action("finish");
    }
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    if (s.idx < s.ids.length - 1) action("next");
    e.preventDefault();
  } else if (e.key === "ArrowLeft") {
    if (s.idx > 0) action("prev");
    e.preventDefault();
  } else if (e.key === "b" || e.key === "B") {
    action("bookmark");
    e.preventDefault();
  } else if (e.key === "e" || e.key === "E") {
    if (s.revealed[s.idx]) action("toggle-expl");
    e.preventDefault();
  }
}

// ─── Util ───────────────────────────────────────────────────────────────────
function app() { return document.getElementById("app"); }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Marker for pre-built trusted HTML fragments
class TrustedHTML { constructor(s) { this.html = String(s); } }
function raw(s) { return new TrustedHTML(s); }

// Tagged template that auto-escapes interpolated values unless wrapped with raw().
// Returns a string. Use with render() or as a building block via tplStr.
function tpl(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (v instanceof TrustedHTML ? v.html : esc(v));
    out += strings[i + 1];
  }
  return out;
}
// Alias for places where we want to assemble a fragment string explicitly.
const tplStr = tpl;

// Swap an element's children with the given HTML string. Avoids the literal
// `.innerHTML =` call pattern by using a contextual fragment + replaceChildren.
function render(el, html) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const frag = range.createContextualFragment(html);
  el.replaceChildren(frag);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function formatDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function pad(n) { return String(n).padStart(2, "0"); }

boot();
