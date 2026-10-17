const copy = {
  en: {
    results: {
      naiveReleasedUnverifiedBytes: 'Unchecked bytes were selected',
      postHocCheck: 'Runtime contract failed',
      boundApply: 'The verified commit was selected',
      checkerExit: 'Normal exit, but no concrete checks',
      approvalDecision: 'Approval refused: required checks missing',
      candidateControlledCompiler: 'Passed under the candidate’s configuration',
      trustedCompiler: 'Type errors detected under trusted strict policy',
      weakenedPolicyDecision: 'Approval refused: type check failed',
      reusedEvidence: 'Refused: evidence belongs to another commit',
      expiryBoundary: 'Refused: evidence expired',
      faultWindowReached: 'Reached after Git accepted the update',
      callerAcknowledgement: 'No acknowledgement; observation required',
      executorTerminated: 'Worker exit and tree-kill acknowledgement observed',
      reconciliation: 'The candidate is currently selected',
      replayNotApplied: 'No successful acknowledgement for the replay',
    },
    skip: 'Skip to evidence',
    languageLabel: 'Language',
    loading: 'Loading the locally generated evidence…',
    loadError: 'Run pnpm experiment, then reload.',
    eyebrow: 'AUTOMATION · EVIDENCE · CHANGE CONTROL',
    headline: 'Approve the change.\nKeep the evidence attached.',
    lead: 'A passing check describes a moment. This experiment asks whether that evidence still belongs to the code we actually apply.',
    boundary:
      'Real Git objects and child processes. Original synthetic source. Local ref changes only.',
    steps: [
      ['Candidate', 'Immutable commit + tree'],
      ['Evidence', 'Independent check inventory'],
      ['Approval', 'Base + candidate + evidence'],
      ['Conditional update', 'Compare the actual Git ref'],
    ],
    caseLabel: 'Experiment cases',
    checked: 'Observed as declared',
    failed: 'Unexpected observation',
    expected: 'Expected',
    all: 'Declared outcomes matched the captured run.',
    unestablishedTitle: 'This run did not establish the expected result.',
    unestablishedDescription:
      'One or more captured observations differed from the declared expectations. Inspect the values and raw transcript below before drawing a conclusion.',
    facts: 'Inspect evidence and decisions',
    raw: 'Inspect raw command transcript',
    limitsLabel: 'THE BOUNDARY IS PART OF THE RESULT',
    limitsTitle: 'Evidence narrows uncertainty. It does not erase it.',
    limitsBody:
      'This is a trusted local-process experiment, not a sandbox, authenticated approval system or deployment tool. Hashes bind records; a local writer can forge them. Observing a ref proves its current value, not who changed it or an exactly-once external action. The five-case report uses scripted approvals; a separate CLI supports explicit manual confirmation.',
    download: 'Download the complete run JSON ↗',
    generated: 'Generated',
    fingerprint: 'Source fingerprint',
    source: 'Source manifest and runtime provenance',
    dirty: 'working tree changed',
    clean: 'clean source revision',
    statusUnavailable: 'Git status unavailable',
    noGit: 'Git revision unavailable',
    cases: {
      drift: [
        'Workspace drift',
        'The check passed. A different commit was selected.',
        'The naive path checks a candidate, then commits the mutable workspace after an edit. The protected path applies the already-verified immutable commit, even though its workspace also changed.',
        'The experiment moves the fixture ref to the unchecked commit, then demonstrates its failing runtime contract. The protected ref still names the checked commit.',
      ],
      empty: [
        'What did green mean?',
        'A green check can answer a weaker question.',
        'First, a checker exits zero with no concrete checks. Then a candidate sets strict: true together with noCheck: true. A real compiler using that candidate configuration reports no errors, despite implicit-any source.',
        'Check names and completeness are not enough if the candidate can redefine their meaning. The trusted checker supplies both its inventory and compiler options independently, detects the errors and refuses approval.',
      ],
      stale: [
        'Evidence reuse',
        'Valid evidence can belong to the wrong change.',
        'Two implementations satisfy the same intended contract but have different commits. Evidence for the first cannot approve the second. The expiry boundary is separately evaluated using an explicitly injected logical time.',
        'Equivalence of intent is not identity of artifact. New bytes require new evidence; expired evidence requires a fresh run.',
      ],
      competing: [
        'Competing approvals',
        'Two approvals. One conditional transition.',
        'Two child executors wait at a ready barrier, then compete to move the same Git ref from the same base to different verified candidates. Git performs the conditional update.',
        'One worker receives a successful CAS result. Reconciliation finds one candidate and one conflict. The losing approval cannot overwrite the winner.',
      ],
      'lost-ack': [
        'Lost acknowledgement',
        'The executor died. The ref had already moved.',
        'The parent terminates a real child process after Git accepts the ref update and before the child writes its acknowledgement. The caller records an unknown outcome, then reads the ref.',
        'The observation establishes that the candidate is currently selected. It does not attribute the update to this executor or prove exactly-once execution. A replay using the old base is refused.',
      ],
    },
    labels: {
      naiveReleasedUnverifiedBytes: 'Naive path selected an unchecked commit',
      postHocCheck: 'Post-hoc contract result',
      boundApply: 'Bound path apply result',
      releasedExactlyVerifiedCommit: 'Protected release ref',
      releasedSourceUnchanged: 'Actual source at protected ref',
      checkerExit: 'Checker process exit code',
      approvalDecision: 'Approval decision',
      releaseUnchanged: 'Release ref remained at base',
      candidateControlledCompiler: 'Compiler using candidate configuration',
      trustedCompiler: 'Compiler using trusted strict policy',
      weakenedPolicyDecision: 'Approval after trusted verification',
      weakPolicyRefUnchanged: 'Weakened-policy fixture ref stayed at base',
      reusedEvidence: 'Evidence for another candidate',
      expiryBoundary: 'At the exact expiry boundary',
      acknowledgedWinners: 'Successful CAS acknowledgements',
      observedWinners: 'Candidates currently selected',
      observedConflicts: 'Candidates observing another commit',
      faultWindowReached: 'Actual post-CAS fault window reached',
      callerAcknowledgement: 'Caller observation',
      executorTerminated: 'Executor termination confirmed',
      reconciliation: 'Reconciliation decision',
      replayNotApplied: 'Replay using the old base',
      releaseStillCandidate: 'Release ref after reconciliation',
    },
  },
  ko: {
    results: {
      naiveReleasedUnverifiedBytes: '미검증 코드가 반영됨',
      postHocCheck: '런타임 동작 검사 실패',
      boundApply: '검증된 커밋 반영',
      checkerExit: '정상 종료했지만 구체적인 검사 없음',
      approvalDecision: '필수 검사 누락으로 승인 거절',
      candidateControlledCompiler: '후보가 정한 설정에서는 통과',
      trustedCompiler: '독립된 strict 정책에서 타입 오류 발견',
      weakenedPolicyDecision: '타입 검사 실패로 승인 거절',
      reusedEvidence: '다른 커밋의 근거이므로 거절',
      expiryBoundary: '만료된 근거이므로 거절',
      faultWindowReached: 'Git이 변경을 수락한 이후 지점에 도달',
      callerAcknowledgement: '응답 없음 · 현재 상태 재조회 필요',
      executorTerminated: '실행기 종료와 트리 종료 요청 수락 확인',
      reconciliation: '현재 ref에서 후보 커밋 확인',
      replayNotApplied: '재요청에 대한 변경 성공 응답 없음',
    },
    skip: '검증 근거로 이동',
    languageLabel: '언어 선택',
    loading: '로컬 실행 결과를 불러오고 있습니다…',
    loadError: 'pnpm experiment 실행 후 새로고침하세요.',
    eyebrow: '자동화 · 검증 근거 · 변경 통제',
    headline: '승인한 변경에,\n검증한 근거가 끝까지 남도록.',
    lead: '검사 통과는 어느 한 시점의 사실입니다. 이 실험은 그 근거가 실제로 반영하는 코드에도 여전히 유효한지 확인합니다.',
    boundary: '실제 Git 객체와 별도 프로세스 · 독립 제작한 가상 코드 · 로컬 ref만 변경',
    steps: [
      ['변경 후보', '불변 커밋과 트리'],
      ['검증 근거', '독립적으로 정한 필수 검사'],
      ['명시적 승인', '기준 커밋 + 후보 + 근거'],
      ['조건부 반영', 'Git ref의 현재 값 비교'],
    ],
    caseLabel: '실험 사례',
    checked: '선언한 결과와 일치',
    failed: '예상과 다른 결과',
    expected: '예상',
    all: '선언한 결과가 실제 실행 기록과 일치했습니다.',
    unestablishedTitle: '이번 실행에서는 예상한 결과를 확인하지 못했습니다.',
    unestablishedDescription:
      '기록된 관측 중 하나 이상이 선언한 예상과 달랐습니다. 결론을 내리기 전에 아래 관측값과 원시 실행 기록을 확인하세요.',
    facts: '검증 근거와 판단 상세 보기',
    raw: '원시 명령 실행 기록 보기',
    limitsLabel: '확인한 범위와 한계를 함께',
    limitsTitle: '근거는 불확실성을 줄입니다. 없애지는 않습니다.',
    limitsBody:
      '신뢰하는 로컬 프로세스의 실험입니다. 샌드박스, 사용자 인증 또는 배포 도구가 아닙니다. 해시는 기록을 연결하지만 로컬 파일 작성자의 위조를 막지 못합니다. ref 관찰로는 현재 값만 확인할 수 있으며, 변경 주체나 외부 작업의 정확히 한 번 실행을 알 수는 없습니다. 보고서의 승인은 스크립트가 수행하며, 별도 CLI에서 사람이 직접 확인하는 흐름을 제공합니다.',
    download: '전체 실행 기록 JSON 다운로드 ↗',
    generated: '생성 시각',
    fingerprint: '소스 지문',
    source: '소스 파일 목록과 실행 환경 보기',
    dirty: '작업 폴더에 변경 있음',
    clean: '커밋과 소스 일치',
    statusUnavailable: 'Git 작업 폴더 상태 확인 불가',
    noGit: 'Git 커밋 정보 확인 불가',
    cases: {
      drift: [
        '검사 후 코드 변경',
        '검사는 통과했는데, 다른 코드가 반영됐다.',
        '잘못된 경로는 후보를 검사한 후 수정된 작업 폴더를 다시 커밋합니다. 보호된 경로는 작업 폴더가 바뀌어도 이미 검사한 불변 커밋만 반영합니다.',
        '격리된 가상 저장소에 미검증 코드를 실제로 반영한 뒤, 런타임 검사가 실패하는 것을 확인합니다. 보호된 ref에는 검사한 커밋이 그대로 남습니다.',
      ],
      empty: [
        '통과한 검사의 의미',
        '통과한 검사가 더 약한 기준을 확인했을 수 있다.',
        '먼저 구체적인 검사 없이 정상 종료하는 경우를 확인합니다. 다음 후보는 strict: true와 noCheck: true를 함께 설정합니다. 후보 설정을 따른 실제 컴파일러는 implicit-any 코드에서도 오류가 없다고 보고합니다.',
        '후보가 검사의 의미를 바꿀 수 있다면 이름과 누락 여부만 확인해서는 부족합니다. 신뢰하는 검사기가 필수 목록과 컴파일 옵션을 독립적으로 적용하면 오류를 발견하고 승인을 거절합니다.',
      ],
      stale: [
        '검증 근거 재사용',
        '유효한 근거도 다른 변경에는 쓸 수 없다.',
        '같은 의도의 두 구현이라도 커밋은 다릅니다. 첫 번째 근거로 두 번째를 승인할 수 없습니다. 만료 경계는 주입한 논리 시각으로 별도 확인하며 실제 시간을 기다렸다고 표시하지 않습니다.',
        '의도가 같다는 것과 산출물이 같다는 것은 다릅니다. 코드가 바뀌거나 근거가 만료되면 새 검증이 필요합니다.',
      ],
      competing: [
        '동시 승인 경쟁',
        '두 개의 승인, 하나의 조건부 전환.',
        '실제 자식 프로세스 두 개가 준비 신호를 기다린 뒤, 같은 기준 커밋에서 서로 다른 후보로 Git ref 변경을 시도합니다. 조건부 갱신은 Git이 수행합니다.',
        '하나만 CAS 성공 응답을 받습니다. 이후 관찰에서도 선택된 후보와 충돌한 후보가 하나씩 남습니다. 나중 요청이 먼저 반영된 변경을 덮어쓰지 못합니다.',
      ],
      'lost-ack': [
        '응답 전 프로세스 종료',
        '실행기는 종료됐다. ref는 이미 바뀌었다.',
        'Git이 ref 변경을 수락한 직후, 실행기가 응답 파일을 쓰기 전에 부모가 실제 자식 프로세스를 종료합니다. 호출자는 결과를 모르는 상태로 기록하고 ref를 다시 읽습니다.',
        '후보가 현재 선택됐다는 사실까지만 확인합니다. 변경 주체나 정확히 한 번 실행을 주장하지 않습니다. 이전 기준 커밋을 사용한 재요청은 거절됩니다.',
      ],
    },
    labels: {
      naiveReleasedUnverifiedBytes: '잘못된 경로에서 미검증 코드 반영',
      postHocCheck: '반영 후 런타임 검사',
      boundApply: '승인에 묶인 경로의 결과',
      releasedExactlyVerifiedCommit: '보호된 경로의 실제 ref',
      releasedSourceUnchanged: '보호된 ref의 실제 코드',
      checkerExit: '검사 프로세스 종료 코드',
      approvalDecision: '승인 판단',
      releaseUnchanged: '기준 커밋으로 유지된 ref',
      candidateControlledCompiler: '후보 설정을 따른 컴파일러 종료 코드',
      trustedCompiler: '독립된 strict 정책의 컴파일러 종료 코드',
      weakenedPolicyDecision: '독립 검증 이후의 승인 판단',
      weakPolicyRefUnchanged: '설정 완화 fixture의 기준 ref 유지',
      reusedEvidence: '다른 후보에 근거 재사용',
      expiryBoundary: '정확한 만료 시점의 판단',
      acknowledgedWinners: 'CAS 성공 응답 수',
      observedWinners: '현재 선택된 후보 수',
      observedConflicts: '다른 커밋을 관찰한 후보 수',
      faultWindowReached: '실제 CAS 이후 종료 지점 도달',
      callerAcknowledgement: '호출자가 확인한 응답',
      executorTerminated: '실행 프로세스 종료 확인',
      reconciliation: '재조회 후 판단',
      replayNotApplied: '이전 기준 커밋으로 재요청',
      releaseStillCandidate: '재조회 이후 유지된 ref',
    },
  },
};

let language = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
try {
  const stored = localStorage.getItem('verified-change-language');
  if (stored === 'ko' || stored === 'en') language = stored;
} catch {
  /* Browser preference remains the fallback when storage is unavailable. */
}
let selected = 'drift';
let report;
let loadFailed = false;
const open = { facts: false, raw: false };
const $ = (id) => document.getElementById(id);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const valueText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const navButtons = new Map();
for (const [index, id] of Object.keys(copy.en.cases).entries()) {
  const button = element('button');
  button.type = 'button';
  button.setAttribute('aria-controls', 'case-panel');
  button.append(element('span', '', String(index + 1).padStart(2, '0')), element('span'));
  button.addEventListener('click', () => {
    selected = id;
    open.facts = false;
    open.raw = false;
    render();
  });
  navButtons.set(id, button);
  $('cases').append(button);
}
for (const lang of ['ko', 'en'])
  $(lang).addEventListener('click', () => {
    language = lang;
    try {
      localStorage.setItem('verified-change-language', lang);
    } catch {
      /* The toggle still works without storage. */
    }
    render();
  });

function render() {
  const t = copy[language];
  document.documentElement.lang = language;
  document.querySelector('.skip').textContent = t.skip;
  document.querySelector('.languages').setAttribute('aria-label', t.languageLabel);
  if ($('loading')) $('loading').textContent = loadFailed ? t.loadError : t.loading;
  for (const lang of ['ko', 'en']) $(lang).setAttribute('aria-pressed', String(language === lang));
  for (const id of ['eyebrow', 'headline', 'lead', 'boundary']) $(id).textContent = t[id];
  for (const [id, key] of [
    ['limits-label', 'limitsLabel'],
    ['limits-title', 'limitsTitle'],
    ['limits-body', 'limitsBody'],
    ['download', 'download'],
    ['source-label', 'source'],
  ])
    $(id).textContent = t[key];
  $('cases').setAttribute('aria-label', t.caseLabel);
  $('protocol').replaceChildren(
    ...t.steps.map(([title, subtitle], index) => {
      const li = element('li');
      li.append(
        element('span', 'number', `0${index + 1}`),
        element('strong', '', title),
        element('small', '', subtitle),
      );
      return li;
    }),
  );
  for (const [id, button] of navButtons) {
    button.lastElementChild.textContent = t.cases[id][0];
    button.setAttribute('aria-pressed', String(id === selected));
  }
  if (!report) return;
  const data = report.cases.find((item) => item.id === selected);
  const text = t.cases[selected];
  const good = data.observations.every((item) => item.passed);
  const top = element('div', 'case-top');
  top.append(
    element(
      'span',
      'case-number',
      `CASE ${String(report.cases.indexOf(data) + 1).padStart(2, '0')}`,
    ),
    element('span', good ? 'status' : 'status fail', good ? t.checked : t.failed),
  );
  const title = element('h2', '', good ? text[1] : t.unestablishedTitle);
  title.id = 'case-title';
  const observations = element('dl', 'observations');
  for (const item of data.observations) {
    const row = element('div', 'observation');
    const dd = element('dd');
    const observed = valueText(item.observed);
    const expected = valueText(item.expected);
    const meaning = item.passed ? t.results[item.key] : undefined;
    dd.append(
      meaning
        ? element('span', 'human-value', meaning)
        : element('code', 'value', observed.length > 230 ? `${observed.slice(0, 230)}…` : observed),
    );
    if (!item.passed) dd.append(element('span', 'expected', `${t.expected}: ${expected}`));
    row.append(element('dt', '', t.labels[item.key] || item.key), dd);
    observations.append(row);
  }
  const details = (key, label, content) => {
    const node = element('details', 'details');
    node.open = open[key];
    node.append(element('summary', '', label));
    const pre = element('pre', '', JSON.stringify(content, null, 2));
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', label);
    node.append(pre);
    node.addEventListener('toggle', () => {
      if (node.isConnected) open[key] = node.open;
    });
    return node;
  };
  $('case-panel').replaceChildren(
    top,
    title,
    element('p', 'description', good ? text[2] : t.unestablishedDescription),
    ...(good ? [element('p', 'insight', text[3])] : []),
    observations,
    element('p', 'outcome', good ? t.all : t.failed),
    details('facts', t.facts, data.facts),
    details('raw', t.raw, data.transcripts),
  );
  const p = report.provenance;
  const gitStatus =
    p.gitDirty === true ? t.dirty : p.gitDirty === false ? t.clean : t.statusUnavailable;
  $('provenance').textContent =
    `${t.generated} ${new Date(report.generatedAt).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US')} · ${p.nodeVersion} · ${p.gitVersion} · ${p.gitRevision ? `${p.gitRevision.slice(0, 12)} (${gitStatus})` : t.noGit}`;
  $('fingerprint').textContent = `${t.fingerprint} ${p.sourceFingerprint}`;
  $('source-files').textContent = JSON.stringify(p, null, 2);
}
render();
try {
  const response = await fetch('/report.json');
  if (!response.ok) throw new Error('Run pnpm experiment, then reload.');
  report = await response.json();
  render();
} catch {
  loadFailed = true;
  render();
}
