(() => {
  if (globalThis.__easyEduNeisContentLoaded) return;
  globalThis.__easyEduNeisContentLoaded = true;

  const WEEK_GRID_LABEL = "주차별행사목록 시작";
  const TIMETABLE_GRID_LABEL = "주별학급시간표시작";
  const DAY_NAMES = ["월", "화", "수", "목", "금", "토", "일"];

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function grid(label) {
    return [...document.querySelectorAll(`[role="grid"][aria-label="${label}"]`)].find(visible) || null;
  }

  function allRows(targetGrid) {
    return [...targetGrid.querySelectorAll('[role="row"][data-rowindex]')]
      .filter(row => row.closest('[role="grid"]') === targetGrid);
  }

  function rows(targetGrid) {
    return allRows(targetGrid).filter(visible);
  }

  function rowAt(targetGrid, rowIndex) {
    return allRows(targetGrid).find(row => Number(row.dataset.rowindex) === rowIndex) || null;
  }

  function detailScrollContainer(targetGrid) {
    return targetGrid.querySelector(
      '.cl-grid-detail [data-role="rowgroup"][data-loc="middle"] [data-role="scroll-container"]'
    ) || targetGrid.querySelector('.cl-grid-detail [data-role="scroll-container"]');
  }

  function rowShownInGrid(targetGrid, row) {
    if (!visible(row)) return false;
    const viewport = detailScrollContainer(targetGrid) || targetGrid;
    const rowRect = row.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return rowRect.bottom > viewportRect.top + 1 && rowRect.top < viewportRect.bottom - 1;
  }

  function dispatchWheel(element, deltaY) {
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      view: window,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY
    }));
  }

  async function ensureGridRow(targetGrid, rowIndex, rowLabel) {
    targetGrid.scrollIntoView({ block: "nearest", inline: "nearest" });
    let row = rowAt(targetGrid, rowIndex);
    if (row && rowShownInGrid(targetGrid, row)) return row;
    if (row) {
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(80);
      return rowAt(targetGrid, rowIndex) || row;
    }

    const scroller = detailScrollContainer(targetGrid);
    if (!scroller) throw new Error(`${rowLabel}을 찾을 수 있는 표 스크롤 영역이 없습니다.`);
    const totalRows = Math.max(Number(targetGrid.getAttribute("aria-rowcount")) || 0, rowIndex + 1);
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const estimatedTop = totalRows > 1 ? Math.round(maxScroll * rowIndex / (totalRows - 1)) : 0;
    scroller.scrollTop = estimatedTop;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(150);

    for (let attempt = 0; attempt < 24; attempt++) {
      row = rowAt(targetGrid, rowIndex);
      if (row) {
        row.scrollIntoView({ block: "nearest", inline: "nearest" });
        await sleep(100);
        return rowAt(targetGrid, rowIndex) || row;
      }

      const renderedIndexes = allRows(targetGrid).map(item => Number(item.dataset.rowindex));
      const highest = renderedIndexes.length ? Math.max(...renderedIndexes) : -1;
      const lowest = renderedIndexes.length ? Math.min(...renderedIndexes) : Number.MAX_SAFE_INTEGER;
      const direction = rowIndex > highest ? 1 : rowIndex < lowest ? -1 : (rowIndex >= totalRows / 2 ? 1 : -1);
      const step = Math.max(120, Math.round(scroller.clientHeight * 0.7));
      scroller.scrollTop += direction * step;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      dispatchWheel(scroller, direction * step);
      dispatchWheel(targetGrid, direction * step);
      await sleep(120);
    }
    throw new Error(`${rowLabel}이 자동 스크롤 후에도 나타나지 않았습니다.`);
  }

  function selectedWeek() {
    const target = grid(WEEK_GRID_LABEL);
    if (!target) return null;
    const row = allRows(target).find(item => item.getAttribute("aria-selected") === "true" || item.classList.contains("cl-selected"));
    return row ? Number(row.dataset.rowindex) + 1 : null;
  }

  function selectedFilter(label) {
    const target = [...document.querySelectorAll('[role="combobox"][aria-label]')]
      .find(item => visible(item) && new RegExp(`^${label}\\s*,`).test(item.getAttribute("aria-label") || ""));
    if (!target) return null;
    return (target.getAttribute("aria-label") || "").replace(new RegExp(`^${label}\\s*,\\s*`), "").trim() || null;
  }

  function timetableCell(day, period) {
    const target = grid(TIMETABLE_GRID_LABEL);
    if (!target) throw new Error("주별 학급시간표를 찾지 못했습니다.");
    const row = rowAt(target, period - 1);
    if (!row) throw new Error(`${period}교시 행을 찾지 못했습니다.`);
    const cell = [...row.querySelectorAll('[role="gridcell"][data-cellindex]')]
      .find(item => Number(item.dataset.cellindex) === day + 1);
    if (!cell) throw new Error(`${DAY_NAMES[day]}요일 ${period}교시 셀을 찾지 못했습니다.`);
    return cell;
  }

  function cellValue(cell) {
    const label = cell.getAttribute("aria-label") || "";
    const prefix = new RegExp(`^\\d+행\\s+${DAY_NAMES[Number(cell.dataset.cellindex) - 1]}\\s*`);
    const fromLabel = label.replace(prefix, "")
      .replace(/(?:<br\s*\/?>|&lt;br\s*\/?&gt;)/gi, " ")
      .trim();
    if (fromLabel) return fromLabel;
    return cell.textContent.replace(/\s+/g, " ").trim();
  }

  function dispatchMouse(element, type, button = 0, contextMenuOrder = false) {
    const rect = element.getBoundingClientRect();
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      button, buttons: button === 2 ? 2 : 1,
      detail: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    });
    if (button === 2) {
      try { Object.defineProperty(event, "which", { value: 3 }); } catch (_) {}
    }
    element.dispatchEvent(event);
  }

  function dispatchPointer(element, type, button = 0) {
    if (typeof PointerEvent !== "function") return;
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, view: window,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
      button, buttons: button === 2 ? 2 : 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }));
  }

  function leftClick(element) {
    dispatchMouse(element, "mousedown", 0);
    dispatchMouse(element, "mouseup", 0);
    dispatchMouse(element, "click", 0);
  }

  function rightClick(element) {
    element.focus?.({ preventScroll: true });
    dispatchMouse(element, "mouseover", 0);
    dispatchMouse(element, "mousemove", 0);
    dispatchPointer(element, "pointerdown", 2);
    dispatchMouse(element, "mousedown", 2);
    dispatchMouse(element, "contextmenu", 2);
    dispatchPointer(element, "pointerup", 2);
    dispatchMouse(element, "mouseup", 2);
    dispatchMouse(element, "auxclick", 2);
  }

  function rightClickAlternate(element) {
    element.focus?.({ preventScroll: true });
    dispatchMouse(element, "mousedown", 2);
    dispatchMouse(element, "mouseup", 2);
    dispatchMouse(element, "contextmenu", 2);
  }

  async function waitFor(predicate, timeout = 5000, interval = 80, timeoutMessage = "나이스 화면 응답을 기다리다 시간이 초과되었습니다.") {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = predicate();
      if (value) return value;
      await sleep(interval);
    }
    throw new Error(timeoutMessage);
  }

  function hasPeriodRow(period) {
    const timetable = grid(TIMETABLE_GRID_LABEL);
    return Boolean(timetable && rowAt(timetable, period - 1));
  }

  async function ensureTimetableRow(period) {
    const timetable = grid(TIMETABLE_GRID_LABEL);
    if (!timetable) throw new Error("주별 학급시간표를 찾지 못했습니다.");
    return ensureGridRow(timetable, period - 1, `${period}교시 행`);
  }

  async function chooseWeek(week, requiredPeriod = 1) {
    if (selectedWeek() === week && hasPeriodRow(requiredPeriod)) return;
    const target = grid(WEEK_GRID_LABEL);
    if (!target) throw new Error("주차 목록을 찾지 못했습니다.");
    const row = await ensureGridRow(target, week - 1, `${week}주차 행`);
    const firstCell = row.querySelector('[role="gridcell"][data-cellindex="0"]') || row;
    leftClick(firstCell);
    await waitFor(() => selectedWeek() === week, 5000, 80, `${week}주차 선택이 화면에 반영되지 않았습니다.`);
    await ensureTimetableRow(requiredPeriod);
    await sleep(150);
  }

  function menuButtons(subject) {
    const compactSubject = subject.replace(/\s+/g, "");
    return [...document.querySelectorAll('.cl-aside [role="button"]')]
      .filter(visible)
      .filter(button => {
        const text = button.textContent.replace(/\s+/g, " ").trim();
        const compactText = text.replace(/\s+/g, "");
        return compactText === compactSubject || compactText.startsWith(`${compactSubject}(`);
      });
  }

  function allSubjectMenuButtons() {
    const subjects = ["국어", "사회", "도덕", "수학", "과학", "체육", "음악", "미술", "영어", "실과", "바른 생활", "슬기로운 생활", "즐거운 생활", "자율·자치활동", "동아리활동", "진로활동"]
      .map(subject => subject.replace(/\s+/g, ""));
    return [...document.querySelectorAll('.cl-aside [role="button"]')]
      .filter(visible)
      .filter(button => {
        const text = button.textContent.replace(/\s+/g, "");
        return subjects.some(subject => text === subject || text.startsWith(`${subject}(`));
      });
  }

  async function openSubjectMenu(cell, subject) {
    const trigger = cell.querySelector(".cl-control") || cell;
    rightClick(trigger);
    try {
      await waitFor(() => allSubjectMenuButtons().length > 0, 1800, 60, "");
    } catch (_) {
      rightClickAlternate(trigger);
      await waitFor(
        () => allSubjectMenuButtons().length > 0,
        2500,
        60,
        "셀의 오른쪽 클릭 과목 선택창이 열리지 않았습니다."
      );
    }
    const options = menuButtons(subject);
    if (!options.length) {
      const detected = [...new Set(allSubjectMenuButtons().map(button => button.textContent.trim().split("(")[0]))];
      throw new Error(`${subject} 선택지를 찾지 못했습니다. 확인된 과목: ${detected.join(", ")}`);
    }
    return options;
  }

  async function fillCell(cellData, overwrite = false) {
    await ensureTimetableRow(cellData.period);
    const target = timetableCell(cellData.day, cellData.period);
    const existing = cellValue(target);
    if (existing && !overwrite) throw new Error(`${DAY_NAMES[cellData.day]}${cellData.period}교시에 이미 '${existing}'이 있습니다.`);
    const options = await openSubjectMenu(target, cellData.subject);
    let option;
    if (options.length === 1 || cellData.teacherMode === "only") option = options[0];
    else if (Number.isInteger(cellData.teacherOptionIndex)) option = options[cellData.teacherOptionIndex];
    else if (cellData.teacherMode === "homeroom") option = options[0];
    else if (cellData.teacherMode === "specialist") option = options[1];
    if (!option) throw new Error(`${cellData.subject} 교사 선택지를 결정하지 못했습니다. 선택지 수=${options.length}`);
    option.scrollIntoView({ block: "nearest" });
    leftClick(option);
    await waitFor(
      () => cellValue(timetableCell(cellData.day, cellData.period)).replace(/\s+/g, "")
        .startsWith(cellData.subject.replace(/\s+/g, "")),
      5000,
      80,
      `${cellData.subject} 선택 후 셀 값이 화면에 반영되지 않았습니다.`
    );
    await sleep(120);
    return `${DAY_NAMES[cellData.day]}${cellData.period} ${cellData.subject}`;
  }

  async function preflight(week, cells) {
    const requiredPeriod = Math.max(1, ...cells.map(item => item.period));
    await chooseWeek(week, requiredPeriod);
    const conflicts = [];
    // 주차 선택 직후 필요한 마지막 교시가 이미 표시되어 있으므로 아래에서 위로
    // 점검한다. 점검이 1교시에서 끝나 실제 입력도 곧바로 시작할 수 있다.
    const periods = [...new Set(cells.map(item => item.period))].sort((a, b) => b - a);
    for (const period of periods) {
      await ensureTimetableRow(period);
      for (const item of cells.filter(cell => cell.period === period)) {
        const value = cellValue(timetableCell(item.day, item.period));
        if (value) conflicts.push(`${DAY_NAMES[item.day]}${item.period} '${value}'`);
      }
    }
    return conflicts;
  }

  function normalizedText(element) {
    return element?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function visibleDialogContaining(text) {
    return [...document.querySelectorAll('[role="dialog"]')]
      .find(dialog => visible(dialog) && normalizedText(dialog).includes(text)) || null;
  }

  function dialogButton(dialog, text) {
    return [...dialog.querySelectorAll('[role="button"]')]
      .find(button => visible(button) && normalizedText(button) === text) || null;
  }

  async function saveCurrentWeek() {
    const saveButton = [...document.querySelectorAll('[role="button"][aria-label="저장"]')].find(visible);
    if (!saveButton) throw new Error("나이스 저장 버튼을 찾지 못했습니다.");

    leftClick(saveButton);
    const confirmDialog = await waitFor(
      () => visibleDialogContaining("저장하시겠습니까?"),
      5000,
      80,
      "저장 확인창이 나타나지 않았습니다. 다음 주차로 이동하지 않습니다."
    );
    const confirmButton = dialogButton(confirmDialog, "확인");
    if (!confirmButton) throw new Error("저장 확인창의 확인 버튼을 찾지 못했습니다. 다음 주차로 이동하지 않습니다.");
    leftClick(confirmButton);

    const successDialog = await waitFor(
      () => visibleDialogContaining("저장되었습니다."),
      15000,
      100,
      "저장 완료 알림을 확인하지 못했습니다. 다음 주차로 이동하지 않습니다."
    );
    const successButton = dialogButton(successDialog, "확인");
    if (!successButton) throw new Error("저장 완료 알림의 확인 버튼을 찾지 못했습니다. 다음 주차로 이동하지 않습니다.");
    leftClick(successButton);
    await waitFor(
      () => !visibleDialogContaining("저장되었습니다."),
      5000,
      80,
      "저장 완료 알림이 닫히지 않았습니다. 다음 주차로 이동하지 않습니다."
    );
    await sleep(200);
  }

  async function fillWeek(message) {
    const conflicts = await preflight(message.week, message.cells);
    if (conflicts.length && !message.overwrite)
      throw new Error(`기존 입력 ${conflicts.length}칸이 있어 변경 확인이 필요합니다.`);
    let completed = 0;
    const ordered = [...message.cells].sort((a, b) => a.period - b.period || a.day - b.day);
    for (const item of ordered) { await fillCell(item, Boolean(message.overwrite)); completed++; }
    return completed;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message.type === "inspect") {
        const weekGrid = grid(WEEK_GRID_LABEL);
        const timetable = grid(TIMETABLE_GRID_LABEL);
        if (!weekGrid || !timetable) throw new Error("학급시간표 관리 화면의 표를 찾지 못했습니다.");
        const firstWeekRow = await ensureGridRow(weekGrid, 0, "1주차 행");
        return {
          weekRows: Number(weekGrid.getAttribute("aria-rowcount")) || rows(weekGrid).length,
          timetableRows: Number(timetable.getAttribute("aria-rowcount")) || rows(timetable).length,
          selectedWeek: selectedWeek(),
          academicYear: Number(selectedFilter("학년도")) || null,
          semester: Number(selectedFilter("학기")) || null,
          grade: Number(selectedFilter("학년")) || null,
          className: Number(selectedFilter("반")) || null,
          firstWeekText: (firstWeekRow.textContent || firstWeekRow.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim()
        };
      }
      if (message.type === "preflight") {
        const conflicts = await preflight(message.week, message.cells); return { conflicts };
      }
      if (message.type === "fillWeek") {
        const completed = await fillWeek(message);
        return { completed };
      }
      if (message.type === "fillAndSaveWeek") {
        const completed = await fillWeek(message);
        await saveCurrentWeek();
        return { completed, saved: true };
      }
      throw new Error("알 수 없는 요청입니다.");
    })().then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
