const SUBJECTS = {
  "국": "국어", "사": "사회", "도": "도덕", "수": "수학", "과": "과학", "체": "체육",
  "음": "음악", "미": "미술", "영": "영어", "실": "실과",
  "바": "바른 생활", "슬": "슬기로운 생활", "즐": "즐거운 생활",
  "자": "자율·자치활동", "동": "동아리활동", "진": "진로활동"
};
const DAYS = ["월", "화", "수", "목", "금"];
const COLORS = {
  "00 00 00 00": "normal",
  "22 66 09 00": "specialist",
  "80 40 00 00": "room",
  "00 00 FF 00": "event"
};

const state = {
  cells: [], byWeek: new Map(), maxWeek: 0, fileName: "",
  screenChecked: false, semesterTables: [], selectedSemester: null
};
const $ = (selector) => document.querySelector(selector);

function appendLog(message) {
  const now = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  for (const log of [$("#log")].filter(Boolean)) {
    log.textContent = log.textContent === "대기 중" ? `[${now}] ${message}` : `${log.textContent}\n[${now}] ${message}`;
    log.scrollTop = log.scrollHeight;
  }
}

function readInt32(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(offset, true);
}

function colorHex(data, offset) {
  return Array.from(data.slice(offset, offset + 4), value => value.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function parseDat(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  const decoder = new TextDecoder("euc-kr");
  const cells = [];
  const seen = new Set();
  for (let offset = 0; offset <= data.length - 77; offset++) {
    if (data[offset] !== 0x26 || data[offset + 1] !== 0) continue;
    const length = readInt32(data, offset + 2);
    if (![71, 77, 83].includes(length)) continue;
    const col = readInt32(data, offset + 6);
    const row = readInt32(data, offset + 10);
    if (row < 4 || row > 40 || col < 9 || col > 48) continue;
    const short = decoder.decode(data.slice(offset + 66, offset + 68));
    if (!SUBJECTS[short]) continue;
    const key = `${row}/${col}`;
    if (seen.has(key)) throw new Error(`동일 좌표의 과목 레코드가 중복되었습니다: ${key}`);
    seen.add(key);
    const day = Math.floor((col - 9) / 8);
    const period = ((col - 9) % 8) + 1;
    if (day > 4) continue;
    const rawColor = colorHex(data, offset + 30);
    cells.push({
      week: row - 3,
      day,
      period,
      short,
      subject: SUBJECTS[short],
      color: COLORS[rawColor] || "other",
      rawColor
    });
  }
  if (!cells.length) throw new Error("연간시간표 과목 레코드를 찾지 못했습니다.");
  return cells.sort((a, b) => a.week - b.week || a.day - b.day || a.period - b.period);
}

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

async function readZipEntry(arrayBuffer, wantedName) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const nameDecoder = new TextDecoder("utf-8");
  let eocd = -1;
  for (let offset = Math.max(0, bytes.length - 65557); offset <= bytes.length - 22; offset++) {
    if (u32(view, offset) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw new Error("HWPX ZIP 끝 레코드를 찾지 못했습니다.");
  const entryCount = u16(view, eocd + 10);
  let cursor = u32(view, eocd + 16);
  for (let index = 0; index < entryCount; index++) {
    if (u32(view, cursor) !== 0x02014b50) throw new Error("HWPX ZIP 중앙 디렉터리가 손상되었습니다.");
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const name = nameDecoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (name === wantedName) {
      if (u32(view, localOffset) !== 0x04034b50) throw new Error("HWPX ZIP 로컬 레코드가 손상되었습니다.");
      const localNameLength = u16(view, localOffset + 26);
      const localExtraLength = u16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed;
      if (method !== 8) throw new Error(`지원하지 않는 HWPX 압축 방식입니다: ${method}`);
      if (typeof DecompressionStream !== "function") throw new Error("Chrome 버전이 HWPX 압축 해제를 지원하지 않습니다.");
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`HWPX 안에서 ${wantedName} 파일을 찾지 못했습니다.`);
}

function localElements(node, localName) {
  return [...node.getElementsByTagNameNS("*", localName)];
}

function xmlCellInfo(cell) {
  const address = localElements(cell, "cellAddr")[0];
  if (!address) return null;
  return {
    row: Number(address.getAttribute("rowAddr")),
    col: Number(address.getAttribute("colAddr")),
    text: localElements(cell, "t").map(node => node.textContent || "").join("").trim(),
    runs: localElements(cell, "run").map(run => ({
      charPr: run.getAttribute("charPrIDRef") || "",
      text: localElements(run, "t").map(node => node.textContent || "").join("").trim()
    }))
  };
}

function parseHwpxTable(table, greenCharPrIds, redCharPrIds) {
  const infos = localElements(table, "tc").map(xmlCellInfo).filter(Boolean);
  const heading = infos.map(cell => cell.text).join(" ");
  const semesterMatch = heading.match(/(\d{4})학년도\s*([12])학기/);
  if (!semesterMatch) return null;
  const academicYear = Number(semesterMatch[1]);
  const semester = Number(semesterMatch[2]);
  const lookup = new Map(infos.map(cell => [`${cell.row}/${cell.col}`, cell]));
  const dayHeaders = infos.filter(cell => cell.row === 2 && DAYS.includes(cell.text));
  if (dayHeaders.length !== 5) throw new Error(`${semester}학기 HWPX 요일 머리글이 5개가 아닙니다: ${dayHeaders.length}`);
  const periodHeaders = infos.filter(cell => cell.row === 3 && /^[1-8]$/.test(cell.text));
  const cells = [];
  const unknown = new Set();
  const weekRanges = new Map();
  for (const weekCell of infos.filter(cell => cell.col === 0 && /^\d+$/.test(cell.text))) {
    const week = Number(weekCell.text);
    if (week < 1 || week > 40) continue;
    const rangeText = lookup.get(`${weekCell.row}/1`)?.text || "";
    const rangeMatch = rangeText.match(/(\d{1,2})\.\s*(\d{1,2})\s*-\s*(\d{1,2})\.\s*(\d{1,2})/);
    if (rangeMatch) {
      weekRanges.set(week, {
        text: rangeText.replace(/\s+/g, " ").trim(),
        startMonth: Number(rangeMatch[1]), startDay: Number(rangeMatch[2]),
        endMonth: Number(rangeMatch[3]), endDay: Number(rangeMatch[4])
      });
    }
    for (let day = 0; day < 5; day++) {
      const start = dayHeaders.find(cell => cell.text === DAYS[day]).col;
      const nextStarts = dayHeaders.filter(cell => cell.col > start).map(cell => cell.col);
      const end = nextStarts.length ? Math.min(...nextStarts) : 34;
      const headers = periodHeaders.filter(cell => cell.col >= start && cell.col < end)
        .sort((a, b) => a.col - b.col);
      for (const header of headers) {
        const sourceCell = lookup.get(`${weekCell.row}/${header.col}`);
        const short = (sourceCell?.text || "").trim();
        if (!short) continue;
        if (!SUBJECTS[short]) { unknown.add(short); continue; }
        const subjectRun = sourceCell.runs.find(run => run.text.includes(short));
        // 휴업일 문구가 '대-체-휴-일'처럼 여러 셀에 나뉘어 있을 때
        // 빨간 '체'를 체육 수업으로 잘못 읽지 않는다.
        if (subjectRun && redCharPrIds.has(subjectRun.charPr)) { unknown.add(short); continue; }
        const period = Number(header.text);
        const green = Boolean(subjectRun && greenCharPrIds.has(subjectRun.charPr));
        const color = green ? "specialist" : "normal";
        cells.push({ week, day, period, short, subject: SUBJECTS[short], color, rawColor: green ? "#008000" : "non-green" });
      }
    }
  }
  if (!cells.length) throw new Error(`${semester}학기 HWPX 연간시간표에서 교과 셀을 찾지 못했습니다.`);
  cells.unknownLabels = [...unknown].sort();
  cells.sort((a, b) => a.week - b.week || a.day - b.day || a.period - b.period);
  const specialistCount = cells.filter(cell => cell.color === "specialist").length;
  return { academicYear, semester, cells, weekRanges, specialistCount, noSpecialistConfirmed: false };
}

async function parseHwpx(arrayBuffer) {
  const headerBytes = await readZipEntry(arrayBuffer, "Contents/header.xml");
  const headerXml = new DOMParser().parseFromString(new TextDecoder("utf-8").decode(headerBytes), "application/xml");
  if (headerXml.querySelector("parsererror")) throw new Error("HWPX 글자 속성을 읽지 못했습니다.");
  const greenCharPrIds = new Set(localElements(headerXml, "charPr")
    .filter(item => (item.getAttribute("textColor") || "").toUpperCase() === "#008000")
    .map(item => item.getAttribute("id")));
  const redCharPrIds = new Set(localElements(headerXml, "charPr")
    .filter(item => (item.getAttribute("textColor") || "").toUpperCase() === "#FF0000")
    .map(item => item.getAttribute("id")));
  const semesterTables = [];
  for (let sectionIndex = 0; sectionIndex < 10; sectionIndex++) {
    let sectionBytes;
    try { sectionBytes = await readZipEntry(arrayBuffer, `Contents/section${sectionIndex}.xml`); }
    catch (error) {
      if (sectionIndex === 0) throw error;
      break;
    }
    const xmlText = new TextDecoder("utf-8").decode(sectionBytes);
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    if (xml.querySelector("parsererror")) throw new Error(`HWPX section${sectionIndex}.xml을 읽지 못했습니다.`);
    for (const table of localElements(xml, "tbl").filter(item => {
      const cells = localElements(item, "tc").map(xmlCellInfo).filter(Boolean);
      const allText = cells.map(cell => cell.text).join(" ");
      return Number(item.getAttribute("colCnt")) >= 30 &&
        allText.includes("교육과정 연간시간운영계획") && /\d{4}학년도\s*[12]학기/.test(allText);
    })) {
      const parsed = parseHwpxTable(table, greenCharPrIds, redCharPrIds);
      if (parsed) semesterTables.push(parsed);
    }
  }
  if (!semesterTables.length) throw new Error("HWPX에서 1학기 또는 2학기 연간시간표 표를 찾지 못했습니다.");
  const unique = new Map(semesterTables.map(item => [`${item.academicYear}/${item.semester}`, item]));
  return [...unique.values()].sort((a, b) => a.academicYear - b.academicYear || a.semester - b.semester);
}

function populateSemesterSelect() {
  const row = $("#semesterSelectRow");
  const select = $("#semesterSelect");
  select.innerHTML = "";
  row.hidden = state.semesterTables.length < 2;
  if (state.semesterTables.length < 2) return;
  const pending = document.createElement("option");
  pending.value = "";
  pending.textContent = "나이스 화면 점검 후 자동 선택";
  select.append(pending);
  for (const item of state.semesterTables) {
    const option = document.createElement("option");
    option.value = `${item.academicYear}/${item.semester}`;
    option.textContent = `${item.academicYear}학년도 ${item.semester}학기`;
    select.append(option);
  }
}

function confirmNoSpecialist() {
  const dialog = $("#noSpecialistDialog");
  const proceedButton = $("#noSpecialistProceed");
  const cancelButton = $("#noSpecialistCancel");
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      proceedButton.removeEventListener("click", proceed);
      cancelButton.removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", nativeCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const proceed = () => finish(true);
    const cancel = () => finish(false);
    const nativeCancel = event => { event.preventDefault(); finish(false); };
    proceedButton.addEventListener("click", proceed);
    cancelButton.addEventListener("click", cancel);
    dialog.addEventListener("cancel", nativeCancel);
    dialog.showModal();
  });
}

async function selectSemesterTable(item, source = "선택") {
  if (item.specialistCount === 0 && !item.noSpecialistConfirmed) {
    const proceed = await confirmNoSpecialist();
    if (!proceed) return false;
    item.noSpecialistConfirmed = true;
    appendLog(`${item.semester}학기 전담 수업 없음 확인`);
  }
  state.selectedSemester = item;
  $("#semesterSelect").value = `${item.academicYear}/${item.semester}`;
  loadState(item.cells, state.fileName, item);
  appendLog(`${item.academicYear}학년도 ${item.semester}학기 시간표 ${source}`);
  return true;
}

function clearLoadedTimetable() {
  state.cells = [];
  state.byWeek = new Map();
  state.maxWeek = 0;
  state.fileName = "";
  state.selectedSemester = null;
  state.semesterTables = [];
  state.screenChecked = false;
  $("#weekSelect").innerHTML = "";
  $("#weekSelect").disabled = true;
  $("#fileSummary").classList.add("muted");
  $("#fileSummary").textContent = "아직 파일을 선택하지 않았습니다.";
  $("#preview").classList.add("muted");
  $("#preview").textContent = "HWPX를 선택하면 표시됩니다.";
  populateSemesterSelect();
  updateSemesterButton();
}

function waitForSemesterSelection(fileName) {
  state.cells = [];
  state.byWeek = new Map();
  state.maxWeek = 0;
  state.fileName = fileName;
  state.selectedSemester = null;
  $("#weekSelect").innerHTML = "";
  $("#weekSelect").disabled = true;
  $("#fileSummary").classList.remove("muted");
  $("#fileSummary").textContent = `${fileName} · ${state.semesterTables.map(item => `${item.semester}학기`).join("·")} 포함 · 나이스 화면 점검 시 자동 선택`;
  $("#preview").classList.add("muted");
  $("#preview").textContent = "나이스 화면을 점검하거나 위에서 입력할 학기를 선택하세요.";
  updateSemesterButton();
  refreshTutorial();
}

function dateKey(year, month, day, semester) {
  const actualYear = semester === 2 && month <= 2 ? year + 1 : year;
  return actualYear * 10000 + month * 100 + day;
}

function verifyFirstWeekRange(item, neisText) {
  const hwpx = item?.weekRanges.get(1);
  if (!hwpx || !neisText) return null;
  const dates = [...neisText.matchAll(/(\d{4})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2})/g)]
    .map(match => Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]));
  if (dates.length < 2) return null;
  const hwpxStart = dateKey(item.academicYear, hwpx.startMonth, hwpx.startDay, item.semester);
  const hwpxEnd = dateKey(item.academicYear, hwpx.endMonth, hwpx.endDay, item.semester);
  const overlaps = hwpxStart <= dates[1] && hwpxEnd >= dates[0];
  if (!overlaps) {
    throw new Error(
      `HWPX와 나이스의 1주차 날짜가 다릅니다.\n` +
      `HWPX: ${hwpx.text}\n나이스: ${neisText}\n\n` +
      `학년도·학기와 파일이 맞는지 확인해 주세요.`
    );
  }
  return hwpx.text;
}

function loadState(cells, fileName, semesterTable = null) {
  state.cells = cells;
  state.fileName = fileName;
  state.byWeek = new Map();
  for (const cell of cells) {
    if (!state.byWeek.has(cell.week)) state.byWeek.set(cell.week, []);
    state.byWeek.get(cell.week).push(cell);
  }
  state.maxWeek = Math.max(...cells.map(cell => cell.week));
  const select = $("#weekSelect");
  select.innerHTML = "";
  for (const week of [...state.byWeek.keys()].sort((a, b) => a - b)) {
    const option = document.createElement("option");
    option.value = week;
    option.textContent = `${week}주차`;
    select.append(option);
  }
  select.disabled = false;
  updateSemesterButton();
  $("#fileSummary").classList.remove("muted");
  const semesterText = semesterTable ? ` · ${semesterTable.academicYear}학년도 ${semesterTable.semester}학기` : "";
  const firstRange = semesterTable?.weekRanges.get(1)?.text;
  $("#fileSummary").textContent = `${fileName}${semesterText} · ${cells.length}차시 · ${state.maxWeek}주차${firstRange ? ` · 1주차 ${firstRange}` : ""}`;
  renderPreview();
  refreshTutorial();
}

function getWeekCells() {
  return state.byWeek.get(Number($("#weekSelect").value)) || [];
}

function semesterReady() {
  return state.cells.length > 0 && state.screenChecked && $("#teacherOrderConfirmed").checked;
}

function updateSemesterButton() {
  $("#fillSemesterButton").disabled = !semesterReady();
}

function payloadForWeek(week) {
  return (state.byWeek.get(Number(week)) || [])
    .map(cell => ({ ...cell, teacherOptionIndex: teacherOptionIndex(cell) }))
    .sort((a, b) => a.period - b.period || a.day - b.day);
}

function renderPreview() {
  const cells = getWeekCells();
  const lookup = new Map(cells.map(cell => [`${cell.day}/${cell.period}`, cell]));
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const title of ["교시", ...DAYS]) {
    const th = document.createElement("th"); th.textContent = title; head.append(th);
  }
  const body = table.createTBody();
  for (let period = 1; period <= 8; period++) {
    const row = body.insertRow();
    const label = row.insertCell(); label.textContent = period;
    for (let day = 0; day < 5; day++) {
      const td = row.insertCell();
      const cell = lookup.get(`${day}/${period}`);
      td.dataset.day = day; td.dataset.period = period;
      if (cell) { td.textContent = cell.short; td.classList.add(cell.color); td.title = `${cell.subject} · ${cell.color}`; }
    }
  }
  const preview = $("#preview");
  preview.classList.remove("muted"); preview.replaceChildren(table);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url?.startsWith("https://goe.neis.go.kr/"))
    throw new Error("나이스 학급시간표 관리 탭을 활성화해 주세요.");
  return tab;
}

async function send(message) {
  const tab = await activeTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    const disconnected = String(error?.message || error).includes("Receiving end does not exist") ||
      String(error?.message || error).includes("Could not establish connection");
    if (!disconnected) throw error;
    appendLog("화면 분석 코드가 없어 현재 나이스 탭에 다시 연결합니다.");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    response = await chrome.tabs.sendMessage(tab.id, message);
  }
  if (!response?.ok) throw new Error(response?.error || "나이스 화면에서 응답하지 않았습니다.");
  return response;
}

function teacherOptionIndex(cell) {
  const specialistFirst = $("#teacherOrderSelect").value === "specialist-first";
  if (cell.color === "specialist") return specialistFirst ? 0 : 1;
  return specialistFirst ? 1 : 0;
}

const tutorialSteps = [
  {
    target: "#datFile",
    title: "연간시간표 불러오기",
    text: "EasyEdu에서 출력한 HWPX 연간시간표를 선택하세요.",
    ready: () => state.cells.length > 0 || state.semesterTables.length > 0,
    done: "연간시간표를 불러왔습니다."
  },
  {
    target: "#inspectSection",
    title: "나이스 화면 확인",
    text: "나이스 [시간표 관리] → [학급시간표관리]에서 학기를 조회한 뒤 ‘현재 화면 점검’을 누르세요.",
    ready: () => state.screenChecked,
    done: "나이스 화면을 확인했습니다."
  },
  {
    target: "#teacherSection",
    title: "교사 순서 확인",
    text: "과목 입력칸을 마우스 오른쪽 클릭하세요. 과목을 선택할 때 나오는 교사 순서를 확인한 뒤, 체크 버튼을 누르세요.",
    ready: () => $("#teacherOrderConfirmed").checked,
    done: "교사 순서를 확인했습니다."
  },
  {
    target: "#semesterSection",
    title: "학기 전체 입력",
    text: "‘학기 전체 시간표 입력’을 누르세요.",
    ready: () => semesterReady(),
    done: "전체 입력을 시작할 수 있습니다."
  }
];

let tutorialIndex = 0;

function clearTutorialFocus() {
  document.querySelectorAll(".tutorial-focus").forEach(element => element.classList.remove("tutorial-focus"));
}

function refreshTutorial() {
  const panel = $("#tutorialPanel");
  if (!panel || panel.hidden) return;
  const step = tutorialSteps[tutorialIndex];
  clearTutorialFocus();
  const target = $(step.target);
  target?.classList.add("tutorial-focus");
  $("#tutorialStep").textContent = `사용 방법 ${tutorialIndex + 1} / ${tutorialSteps.length}`;
  $("#tutorialTitle").textContent = step.title;
  $("#tutorialText").textContent = step.text;
  const ready = step.ready();
  $("#tutorialStatus").textContent = ready ? `✓ ${step.done}` : "반짝이는 부분에서 이 단계를 진행하세요.";
  $("#tutorialStatus").className = ready ? "tutorial-status success" : "tutorial-status";
  $("#tutorialPrev").disabled = tutorialIndex === 0;
  $("#tutorialNext").hidden = tutorialIndex === tutorialSteps.length - 1;
  $("#tutorialNext").disabled = !ready;
  setTimeout(() => target?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
}

function openTutorial() {
  tutorialIndex = 0;
  $("#tutorialPanel").hidden = false;
  refreshTutorial();
}

function closeTutorial() {
  $("#tutorialPanel").hidden = true;
  clearTutorialFocus();
}

$("#datFile").addEventListener("change", async event => {
  try {
    const file = event.target.files?.[0]; if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension === "hwp") {
      throw new Error("HWP 파일은 읽을 수 없습니다.\n한글에서 파일을 연 뒤 파일 → 다른 이름으로 저장 → HWPX로 저장해 주세요.");
    }
    if (!["hwpx", "dat"].includes(extension)) throw new Error("HWPX 또는 DAT 파일을 선택해 주세요.");
    clearLoadedTimetable();
    const buffer = await file.arrayBuffer();
    state.fileName = file.name;
    state.screenChecked = false;
    if (extension === "hwpx") {
      state.semesterTables = await parseHwpx(buffer);
      populateSemesterSelect();
      if (state.semesterTables.length === 1) {
        if (!await selectSemesterTable(state.semesterTables[0], "자동 선택")) {
          event.target.value = "";
          clearLoadedTimetable();
          appendLog("전담 수업 확인을 취소해 파일을 불러오지 않았습니다.");
          return;
        }
      } else {
        waitForSemesterSelection(file.name);
      }
      const total = state.semesterTables.reduce((sum, item) => sum + item.cells.length, 0);
      appendLog(`HWPX 분석 완료: ${state.semesterTables.map(item => `${item.semester}학기 ${item.cells.length}차시`).join(" · ")} (합계 ${total}차시)`);
      const unknown = [...new Set(state.semesterTables.flatMap(item => item.cells.unknownLabels || []))];
      if (unknown.length) appendLog(`HWPX에서 건너뛴 비교과·휴업 표기: ${unknown.join(", ")}`);
    } else {
      state.semesterTables = [];
      state.selectedSemester = null;
      populateSemesterSelect();
      const cells = parseDat(buffer);
      loadState(cells, file.name);
      appendLog(`DAT 분석 완료: ${cells.length}차시`);
    }
  } catch (error) {
    event.target.value = "";
    clearLoadedTimetable();
    appendLog(`오류: ${error.message}`); alert(error.message);
  }
});

$("#semesterSelect").addEventListener("change", async event => {
  const item = state.semesterTables.find(candidate => `${candidate.academicYear}/${candidate.semester}` === event.target.value);
  if (item && !await selectSemesterTable(item, "직접 선택")) {
    event.target.value = state.selectedSemester
      ? `${state.selectedSemester.academicYear}/${state.selectedSemester.semester}`
      : "";
  }
});

$("#weekSelect").addEventListener("change", renderPreview);
$("#teacherOrderConfirmed").addEventListener("change", () => {
  updateSemesterButton();
  refreshTutorial();
});
$("#teacherOrderSelect").addEventListener("change", () => {
  $("#teacherOrderConfirmed").checked = false;
  updateSemesterButton();
  refreshTutorial();
});

$("#helpButton").addEventListener("click", openTutorial);
$("#tutorialClose").addEventListener("click", closeTutorial);
$("#tutorialPrev").addEventListener("click", () => {
  if (tutorialIndex > 0) { tutorialIndex--; refreshTutorial(); }
});
$("#tutorialNext").addEventListener("click", () => {
  if (tutorialSteps[tutorialIndex].ready() && tutorialIndex < tutorialSteps.length - 1) {
    tutorialIndex++;
    refreshTutorial();
  }
});

$("#inspectButton").addEventListener("click", async () => {
  try {
    const result = await send({ type: "inspect" });
    if (state.semesterTables.length) {
      if (!result.academicYear || !result.semester)
        throw new Error("나이스 화면에서 학년도·학기 선택값을 읽지 못했습니다.");
      const matched = state.semesterTables.find(item =>
        item.academicYear === result.academicYear && item.semester === result.semester
      );
      if (!matched) {
        const available = state.semesterTables.map(item => `${item.academicYear}학년도 ${item.semester}학기`).join(", ");
        throw new Error(`현재 나이스는 ${result.academicYear}학년도 ${result.semester}학기이지만 HWPX에는 ${available}만 있습니다.`);
      }
      if (state.selectedSemester !== matched && !await selectSemesterTable(matched, "나이스 화면에 맞춰 자동 선택")) {
        throw new Error("전담 수업 여부 확인을 취소했습니다.");
      }
      const verifiedRange = verifyFirstWeekRange(matched, result.firstWeekText);
      if (verifiedRange) appendLog(`1주차 날짜 일치 확인: HWPX ${verifiedRange}`);
    }
    $("#screenSummary").classList.remove("muted");
    const filterText = result.academicYear && result.semester
      ? `${result.academicYear}학년도 ${result.semester}학기 · ${result.grade || "?"}학년 ${result.className || "?"}반 · `
      : "";
    $("#screenSummary").textContent = `${filterText}주차목록 ${result.weekRows}개 · 시간표 ${result.timetableRows}교시 · 현재 ${result.selectedWeek || "미선택"}주차`;
    state.screenChecked = true;
    appendLog("나이스 화면 구조 확인 완료");
    refreshTutorial();
  } catch (error) { appendLog(`화면 점검 실패: ${error.message}`); alert(error.message); }
});

$("#fillSemesterButton").addEventListener("click", async () => {
  const button = $("#fillSemesterButton");
  const originalText = button.textContent;
  try {
    if (!semesterReady()) throw new Error("나이스 화면과 교사 선택 기준을 먼저 확인해 주세요.");
    const weeks = [...state.byWeek.keys()].sort((a, b) => a - b);
    const totalCells = weeks.reduce((sum, week) => sum + payloadForWeek(week).length, 0);
    button.disabled = true;
    button.textContent = "기존 시간표 조사 중…";
    appendLog(`학기 전체 사전 충돌 검사 시작: ${weeks.length}주, ${totalCells}차시`);
    const conflicts = [];
    for (const week of weeks) {
      const check = await send({ type: "preflight", week, cells: payloadForWeek(week) });
      conflicts.push(...check.conflicts.map(item => `${week}주차 ${item}`));
      appendLog(`${week}주차 검사 완료 · 기존 입력 ${check.conflicts.length}칸`);
    }

    const examples = conflicts.slice(0, 10).join("\n");
    const more = conflicts.length > 10 ? `\n외 ${conflicts.length - 10}칸` : "";
    const conflictText = conflicts.length
      ? `\n\n기존 입력 ${conflicts.length}칸:\n${examples}${more}\n\n기존 입력은 HWPX 시간표로 변경됩니다.`
      : "\n\n기존 입력은 없습니다.";
    const confirmed = confirm(
      `${weeks.length}주 전체 ${totalCells}차시를 입력합니다.${conflictText}\n\n각 주차 입력 후 자동으로 저장하고, 저장 완료를 확인한 뒤 다음 주차로 이동합니다.\n계속하시겠습니까?`
    );
    if (!confirmed) { appendLog("학기 전체 입력을 취소했습니다."); return; }

    button.textContent = "학기 전체 입력 중…";
    let completedWeeks = 0;
    let completedCells = 0;
    for (const week of weeks) {
      const cells = payloadForWeek(week);
      appendLog(`${week}주차 입력 시작 (${cells.length}차시)`);
      const result = await send({ type: "fillAndSaveWeek", week, cells, overwrite: conflicts.length > 0 });
      completedWeeks++;
      completedCells += result.completed;
      appendLog(`${week}주차 입력 및 저장 완료 · 누적 ${completedWeeks}/${weeks.length}주, ${completedCells}/${totalCells}차시`);
    }
    appendLog(`학기 전체 입력 및 주차별 저장 완료: ${completedCells}차시`);
    alert(`학기 전체 ${completedCells}차시 입력과 주차별 저장이 완료되었습니다.\n나이스 화면에서 결과를 확인해 주세요.`);
  } catch (error) {
    appendLog(`학기 전체 입력 중지: ${error.message}`);
    alert(error.message);
  } finally {
    button.textContent = originalText;
    updateSemesterButton();
  }
});
