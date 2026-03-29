(function () {
  "use strict";

  /* ── Config ── */
  var PROXY = "https://corsproxy.io/?url=";

  /* ── DOM refs ── */
  var urlInput = document.getElementById("urlInput");
  var loadBtn = document.getElementById("loadBtn");
  var exportBtn = document.getElementById("exportBtn");
  var clearBtn = document.getElementById("clearBtn");
  var loadingOverlay = document.getElementById("loadingOverlay");
  var placeholder = document.getElementById("placeholder");
  var frame = document.getElementById("originalFrame");
  var editorFrame = document.getElementById("editorFrame");
  var errorBanner = document.getElementById("errorBanner");
  var clickHint = document.getElementById("clickHint");
  var clickBadge = document.getElementById("clickBadge");
  var statusText = document.getElementById("statusText");
  var charCount = document.getElementById("charCount");
  var divider = document.getElementById("divider");
  var leftPanel = document.getElementById("originalPanel");
  var rightPanel = document.getElementById("editorPanel");
  var workspace = document.getElementById("workspace");

  /* ── Diff state ── */
  var editorSnapshot = null; // path → innerHTML (block elements)
  var diffObserver = null;
  var diffTimer = null;
  var origReady = false;
  var editReady = false;

  /* ── 미러링 클릭 플래그 (제한 핸들러 우회용) ── */
  var isMirrorClick = false;

  // 비교 대상 블록 태그
  var BLOCK = {
    P: 1,
    H1: 1,
    H2: 1,
    H3: 1,
    H4: 1,
    H5: 1,
    H6: 1,
    LI: 1,
    TD: 1,
    TH: 1,
    BLOCKQUOTE: 1,
    PRE: 1,
    DT: 1,
    DD: 1,
    DIV: 1,
    SECTION: 1,
    ARTICLE: 1,
    ASIDE: 1,
    HEADER: 1,
    FOOTER: 1,
    FIGURE: 1,
    FIGCAPTION: 1,
    CAPTION: 1,
  };

  /* ════════════════════════════════
     URL 불러오기 (공통)
  ════════════════════════════════ */
  function loadPage() {
    var url = urlInput.value.trim();
    if (!url) { alert("URL을 입력해주세요."); return; }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    fetchBoth(url);
  }

  function fetchBoth(url) {
    // 상태 초기화
    origReady = false;
    editReady = false;
    editorSnapshot = null;
    if (diffObserver) { diffObserver.disconnect(); diffObserver = null; }

    loadBtn.disabled = true;
    loadBtn.textContent = "로딩 중...";
    loadingOverlay.classList.add("active");
    errorBanner.classList.remove("active");
    placeholder.style.display = "none";
    frame.style.display = "none";
    editorFrame.style.display = "none";

    // 양쪽 패널 모두 같은 프록시 HTML 사용 → 미러링 가능
    fetch(PROXY + encodeURIComponent(url))
      .then(function (res) {
        if (!res.ok) throw new Error("프록시 응답 오류: " + res.status);
        return res.text();
      })
      .then(function (html) {
        if (!html) throw new Error("페이지 내용을 가져오지 못했습니다.");

        // 왼쪽: 미러링 스크립트 + 링크 내비게이션 주입
        frame.onload = function () {
          frame.onload = null;
          try { injectDiffCSS(frame.contentDocument, false); } catch (e) {}
          origReady = true;
          tryInitDiff();
        };
        frame.srcdoc = injectHighlight(html, url);
        frame.style.display = "block";
        clickHint.classList.add("active");
        clickBadge.classList.add("visible");

        // 오른쪽: 편집기
        setupEditorFrame(html, url);

        setStatus("페이지 로드 완료 — 원본 링크 클릭 시 양쪽 동시 이동");
      })
      .catch(function (err) {
        errorBanner.textContent =
          "⚠ " + err.message + " (일부 사이트는 보안 정책으로 불러올 수 없습니다)";
        errorBanner.classList.add("active");
        placeholder.style.display = "flex";
        frame.style.display = "none";
      })
      .finally(function () {
        loadingOverlay.classList.remove("active");
        loadBtn.disabled = false;
        loadBtn.textContent = "불러오기";
      });
  }

  /* ════════════════════════════════
     왼쪽 iframe: 팝업 허용 + 미러링 신호 주입
  ════════════════════════════════ */
  function injectHighlight(html, baseUrl) {
    var base = '<base href="' + baseUrl.replace(/"/g, "&quot;") + '">';
    var script =
      "<" + "script>(function(){" +
      'document.addEventListener("click",function(e){' +
      '  var a=e.target.closest&&e.target.closest("a");' +
      '  if(a&&a.href&&a.href.indexOf("javascript:")<0){' +
      '    e.preventDefault();' +
      // 링크 이동 → 부모에 새 URL 전달 (양쪽 동시 프록시 재로드)
      '    try{window.parent.postMessage({type:"orig-nav",href:a.href},"*");}catch(ex){}' +
      '    return;' +
      '  }' +
      // 일반 클릭 → 미러링
      '  try{window.parent.postMessage({type:"orig-click",path:__gp(e.target)},"*");}catch(ex){}' +
      '},true);' +
      // 윈도우 스크롤 동기화
      'window.addEventListener("scroll",function(){' +
      '  try{window.parent.postMessage({type:"orig-scroll",x:window.scrollX,y:window.scrollY},"*");}catch(ex){}' +
      '});' +
      // 내부 스크롤 컨테이너 동기화
      'document.addEventListener("scroll",function(e){' +
      '  var t=e.target;' +
      '  if(t&&t!==document&&t!==document.documentElement){' +
      '    try{window.parent.postMessage({type:"orig-scroll-el",path:__gp(t),x:t.scrollLeft,y:t.scrollTop},"*");}catch(ex){}' +
      '  }' +
      '},true);' +
      // 요소 경로: body 기준 child-index 배열
      'function __gp(el){' +
      '  var p=[];' +
      '  while(el&&el!==document.body&&el.parentElement){' +
      '    p.unshift(Array.prototype.indexOf.call(el.parentElement.children,el));' +
      '    el=el.parentElement;' +
      '  }' +
      '  return p;' +
      '}' +
      '})();<' + '/script>';

    html = insertBase(html, base);
    html = insertBeforeBodyEnd(html, script);
    return html;
  }

  /* ════════════════════════════════
     오른쪽 iframe: designMode 편집기
  ════════════════════════════════ */
  function setupEditorFrame(html, baseUrl) {
    var base = '<base href="' + baseUrl.replace(/"/g, "&quot;") + '">';
    html = insertBase(html, base);

    editorFrame.onload = function () {
      editorFrame.onload = null;
      try {
        var editDoc = editorFrame.contentDocument;
        injectDiffCSS(editDoc, true);
        restrictEditorInteractions(editDoc);
        editDoc.designMode = "on";
        editorFrame.style.display = "block";
        editDoc.addEventListener("input", updateCharCount);
        editDoc.addEventListener("keyup", updateCharCount);
        updateCharCount();
        editReady = true;
        tryInitDiff();
      } catch (e) {}
    };
    editorFrame.srcdoc = html;
  }

  /* ── HTML 유틸 ── */
  function insertBase(html, base) {
    if (/<head[\s>]/i.test(html))
      return html.replace(/(<head[^>]*>)/i, "$1" + base);
    return base + html;
  }

  function insertBeforeBodyEnd(html, content) {
    if (/<\/body>/i.test(html))
      return html.replace(/<\/body>/i, content + "</body>");
    return html + content;
  }

  /* ════════════════════════════════
     Diff CSS 주입 (각 iframe 문서에 직접)
  ════════════════════════════════ */
  function injectDiffCSS(doc, isEditor) {
    if (!doc || !doc.head) return;
    var old = doc.getElementById("__diff_style__");
    if (old) old.parentNode.removeChild(old);

    var style = doc.createElement("style");
    style.id = "__diff_style__";
    style.textContent = isEditor
      ? "[data-changed]{outline:2px solid #e94560 !important;outline-offset:2px;box-shadow:inset 0 0 0 9999px rgba(233,69,96,.05) !important;}"
      : "[data-changed]{outline:2px dashed #4299e1 !important;outline-offset:2px;box-shadow:inset 0 0 0 9999px rgba(66,153,225,.05) !important;}";
    doc.head.appendChild(style);
  }

  /* ════════════════════════════════
     편집기 폼·링크 상호작용 제한
     — 텍스트 편집만 허용, 폼 기능 비활성화
  ════════════════════════════════ */
  function restrictEditorInteractions(doc) {
    if (!doc || !doc.head) return;

    // 1) 모든 인터랙티브 요소 비활성화 CSS
    var old = doc.getElementById("__editor_restrict_style__");
    if (old) old.parentNode.removeChild(old);

    var style = doc.createElement("style");
    style.id = "__editor_restrict_style__";
    style.textContent =
      "input, textarea, button, select, label[for], a," +
      "[role='button'], [role='checkbox'], [role='radio']," +
      "[role='switch'], [role='tab'], [role='menuitem']," +
      "[onclick], [data-toggle], [data-dismiss], [data-target] {" +
      "  pointer-events: none !important;" +
      "  cursor: text !important;" +
      "}" +
      "input, textarea, select, button {" +
      "  opacity: 0.5 !important;" +
      "}";
    doc.head.appendChild(style);

    // 2) 클릭: 미러링 클릭은 허용, 사용자 직접 클릭만 차단
    doc.addEventListener("click", function (e) {
      // 미러링으로 실행된 클릭 — 제한 없이 통과
      if (isMirrorClick) return;

      var INTERACTIVE = /^(A|BUTTON|INPUT|TEXTAREA|SELECT|LABEL|DETAILS|SUMMARY)$/;
      var cur = e.target;
      while (cur && cur !== doc.body) {
        if (INTERACTIVE.test(cur.tagName) ||
            (cur.hasAttribute && cur.hasAttribute("onclick"))) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        cur = cur.parentElement;
      }
    }, true);

    // 3) 키보드: Tab·Enter·Space 등 폼 탐색 키 차단 (텍스트 입력은 유지)
    doc.addEventListener("keydown", function (e) {
      // Tab — 포커스 이동 방지
      if (e.key === "Tab") { e.preventDefault(); return; }
      // Enter on button/link — 실행 방지
      var tag = doc.activeElement && doc.activeElement.tagName;
      if (e.key === "Enter" && /^(BUTTON|A)$/.test(tag)) {
        e.preventDefault();
      }
    }, true);

    // 4) 폼 제출 완전 차단
    doc.addEventListener("submit", function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    // 5) 컨텍스트 메뉴 차단 (우클릭 기본 동작 — 브라우저 메뉴로 인한 포커스 이탈 방지)
    doc.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    }, true);
  }

  /* ════════════════════════════════
     Diff 초기화 (양쪽 iframe 모두 로드된 후)
  ════════════════════════════════ */
  function tryInitDiff() {
    if (!origReady || !editReady) return;
    initDiffTracking();
  }

  function initDiffTracking() {
    var editDoc = editorFrame.contentDocument;
    if (!editDoc || !editDoc.body) return;

    // 초기 상태 스냅샷
    editorSnapshot = buildSnapshot(editDoc.body);

    // 변경 감지
    diffObserver = new MutationObserver(scheduleDiff);
    diffObserver.observe(editDoc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
  }

  /* ════════════════════════════════
     스냅샷: 블록 요소의 innerHTML 저장
     경로 형식: '0', '0/1', '0/1/2' ...
  ════════════════════════════════ */
  function buildSnapshot(body) {
    var snap = {};
    for (var i = 0; i < body.children.length; i++) {
      (function walk(el, path) {
        if (BLOCK[el.tagName]) snap[path] = el.innerHTML;
        for (var j = 0; j < el.children.length; j++) {
          walk(el.children[j], path + "/" + j);
        }
      })(body.children[i], String(i));
    }
    return snap;
  }

  /* ════════════════════════════════
     Diff 실행 (디바운스)
  ════════════════════════════════ */
  function scheduleDiff() {
    if (diffTimer) clearTimeout(diffTimer);
    diffTimer = setTimeout(runDiff, 350);
  }

  function runDiff() {
    var editDoc = editorFrame.contentDocument;
    var origDoc = frame.contentDocument;
    if (!editDoc || !origDoc || !editorSnapshot) return;

    var eb = editDoc.body;
    var ob = origDoc.body;
    if (!eb || !ob) return;

    // 기존 마커 제거
    clearMarkers(editDoc);
    clearMarkers(origDoc);

    // post-order 탐색: 가장 구체적인 변경 블록을 찾아 마킹
    for (var i = 0; i < eb.children.length; i++) {
      walk(eb.children[i], ob.children[i] || null, String(i));
    }

    function walk(editEl, origEl, path) {
      // 자식 먼저 탐색 (post-order)
      var childMarked = false;
      for (var j = 0; j < editEl.children.length; j++) {
        var oc = origEl ? origEl.children[j] : null;
        if (walk(editEl.children[j], oc, path + "/" + j)) childMarked = true;
      }

      // 이 요소가 스냅샷에 있고, 내용이 바뀌었고, 자식 중 더 구체적인 변경이 없으면 → 마킹
      var snap = editorSnapshot[path];
      if (snap !== undefined && editEl.innerHTML !== snap && !childMarked) {
        editEl.setAttribute("data-changed", "");
        if (origEl) origEl.setAttribute("data-changed", "");
        return true;
      }
      return childMarked;
    }
  }

  function clearMarkers(doc) {
    try {
      var els = doc.querySelectorAll("[data-changed]");
      for (var i = 0; i < els.length; i++)
        els[i].removeAttribute("data-changed");
    } catch (e) {}
  }

  /* ════════════════════════════════
     편집기 서식 (execCommand)
  ════════════════════════════════ */
  function fmt(cmd, val) {
    try {
      editorFrame.contentDocument.execCommand(
        cmd,
        false,
        val !== undefined ? val : null,
      );
    } catch (e) {}
  }

  /* ════════════════════════════════
     HTML 내보내기
  ════════════════════════════════ */
  function exportHTML() {
    var content;
    try {
      content =
        "<!DOCTYPE html>\n" +
        editorFrame.contentDocument.documentElement.outerHTML;
    } catch (e) {
      alert("내보낼 내용이 없습니다.");
      return;
    }
    if (!content) {
      alert("내보낼 내용이 없습니다.");
      return;
    }

    var blob = new Blob([content], { type: "text/html;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download =
      "개인정보동의서_" + new Date().toISOString().slice(0, 10) + ".html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setStatus("HTML 파일로 내보냈습니다");
  }

  /* ════════════════════════════════
     전체 지우기
  ════════════════════════════════ */
  function clearEditor() {
    var body;
    try {
      body = editorFrame.contentDocument.body;
    } catch (e) {
      return;
    }
    if (!body || !body.innerHTML) return;
    if (confirm("편집 내용을 모두 삭제하시겠습니까?")) {
      try {
        body.innerHTML = "";
      } catch (e) {}
      setStatus("편집 내용이 삭제되었습니다");
      updateCharCount();
    }
  }

  /* ════════════════════════════════
     분할선 드래그
  ════════════════════════════════ */
  var dragging = false;

  divider.addEventListener("mousedown", function () {
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    frame.style.pointerEvents = "none";
    editorFrame.style.pointerEvents = "none";
  });

  document.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    var r = workspace.getBoundingClientRect();
    var available = r.width - 5;
    var leftW = Math.min(Math.max(e.clientX - r.left, 200), available - 200);
    leftPanel.style.flex = "none";
    leftPanel.style.width = leftW + "px";
    rightPanel.style.flex = "none";
    rightPanel.style.width = available - leftW + "px";
  });

  document.addEventListener("mouseup", function () {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    frame.style.pointerEvents = "";
    editorFrame.style.pointerEvents = "";
  });

  /* ════════════════════════════════
     유틸
  ════════════════════════════════ */
  function setStatus(msg) {
    statusText.textContent = msg;
  }

  function updateCharCount() {
    var n = 0;
    try {
      n = (editorFrame.contentDocument.body.innerText || "").trim().length;
    } catch (e) {}
    charCount.textContent = n.toLocaleString() + "자";
  }

  /* ════════════════════════════════
     원본 → 편집기 미러링 (scroll + click)
  ════════════════════════════════ */
  function elByPath(doc, path) {
    if (!doc || !doc.body) return null;
    if (!path || !path.length) return doc.body;
    var el = doc.body;
    for (var i = 0; i < path.length; i++) {
      el = el && el.children[path[i]];
      if (!el) return null;
    }
    return el;
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || !d.type) return;

    // 링크 내비게이션 → 양쪽 패널 동시 재로드
    if (d.type === "orig-nav" && d.href) {
      urlInput.value = d.href;
      fetchBoth(d.href);
      return;
    }

    // 윈도우 스크롤 동기화
    if (d.type === "orig-scroll") {
      try { editorFrame.contentWindow.scrollTo(d.x, d.y); } catch (ex) {}
    }

    // 내부 스크롤 컨테이너 동기화
    if (d.type === "orig-scroll-el") {
      try {
        var se = elByPath(editorFrame.contentDocument, d.path);
        if (se) { se.scrollLeft = d.x; se.scrollTop = d.y; }
      } catch (ex) {}
    }

    // 클릭 미러링 (더보기·아코디언·탭 등)
    if (d.type === "orig-click") {
      try {
        var doc = editorFrame.contentDocument;
        if (!doc) return;
        var el = elByPath(doc, d.path);
        if (!el) return;
        var tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        // designMode 잠시 해제 → 미러링 클릭 → 복원
        isMirrorClick = true;
        doc.designMode = "off";
        el.click();
        setTimeout(function () {
          try {
            isMirrorClick = false;
            doc.designMode = "on";
            // 클릭으로 DOM이 바뀌었을 수 있으므로 diff 스냅샷 갱신
            if (editReady) editorSnapshot = buildSnapshot(doc.body);
          } catch (ex) { isMirrorClick = false; }
        }, 120);
      } catch (ex) {}
    }
  });

  /* ════════════════════════════════
     이벤트 연결
  ════════════════════════════════ */
  loadBtn.addEventListener("click", loadPage);
  exportBtn.addEventListener("click", exportHTML);
  clearBtn.addEventListener("click", clearEditor);

  urlInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") loadPage();
  });

  // 툴바 버튼: mousedown+preventDefault로 iframe 포커스 유지
  document.querySelectorAll(".tb-btn[data-cmd]").forEach(function (btn) {
    btn.addEventListener("mousedown", function (e) {
      e.preventDefault();
      fmt(btn.getAttribute("data-cmd"));
    });
  });

  document.getElementById("sizeSelect").addEventListener("change", function () {
    if (!this.value) return;
    fmt("fontSize", this.value);
    this.value = "";
  });

  document.getElementById("fontSelect").addEventListener("change", function () {
    if (!this.value) return;
    fmt("fontName", this.value);
    this.value = "";
  });

  document
    .getElementById("blockSelect")
    .addEventListener("change", function () {
      if (!this.value) return;
      fmt("formatBlock", this.value);
      this.value = "";
    });

  document.getElementById("textColor").addEventListener("input", function () {
    fmt("foreColor", this.value);
  });

  document.getElementById("bgColor").addEventListener("input", function () {
    fmt("hiliteColor", this.value);
  });
})();
