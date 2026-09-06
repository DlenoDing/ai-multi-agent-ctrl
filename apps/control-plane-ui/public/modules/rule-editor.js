(function () {
  "use strict";

  const API_NAME = "AIMAC_RULE_EDITOR";
  const ENHANCED_ATTR = "data-rule-editor-enhanced";
  const TOOL_ATTR = "data-rule-editor-action";
  const SOURCE_ATTR = "data-rule-editor-source";
  const MIRROR_ATTR = "data-rule-editor-mirror";
  const TEXTAREA_SELECTOR = ".rule-row textarea[name='ruleContent']";
  const MANAGED_TEXTAREA_SELECTOR = `textarea[name='ruleContent'][${SOURCE_ATTR}]`;
  const ROW_SELECTOR = ".rule-row[data-rule-row]";
  const FORM_SELECTOR = "form[data-form='project-rules'], form[data-form='tg-rules']";
  const FILTER_SELECTOR = "[data-rule-filter]";
  const DEFAULT_VISIBLE_RULES = 12;
  const FOCUSABLE_SELECTOR = [
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "a[href]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const AUTOSIZE_MIN = 220;
  const AUTOSIZE_MAX = 560;

  let listenersBound = false;
  let queuedFrame = 0;
  const queuedTextareas = new Set();
  const ownerForms = new WeakMap();
  const observedRoots = new WeakSet();
  let activeSession = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isEditable(textarea) {
    return textarea instanceof HTMLTextAreaElement && !textarea.readOnly && !textarea.disabled;
  }

  function dispatchTextareaInput(textarea) {
    textarea.dispatchEvent(new Event("input", {bubbles: true}));
  }

  function dispatchOwnerFormInput(textarea) {
    const form = ownerForms.get(textarea);
    if (form?.isConnected) form.dispatchEvent(new Event("input", {bubbles: true}));
  }

  function syncMirror(session) {
    if (!session?.mirror) return;
    session.mirror.value = session.textarea.value;
  }

  function copyDataset(el) {
    return Object.fromEntries(Object.entries(el?.dataset || {}));
  }

  function queueAutosize(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    queuedTextareas.add(textarea);
    if (queuedFrame) return;
    queuedFrame = requestAnimationFrame(() => {
      queuedFrame = 0;
      const work = [...queuedTextareas];
      queuedTextareas.clear();
      for (const area of work) autosizeNow(area);
    });
  }

  function autosizeNow(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement) || !textarea.isConnected) return;
    const maxHeight = textarea.closest(".rule-editor-fullscreen")
      ? Math.max(180, Math.floor(window.innerHeight * 0.72))
      : AUTOSIZE_MAX;
    textarea.style.height = "auto";
    textarea.style.height = `${clamp(textarea.scrollHeight + 2, AUTOSIZE_MIN, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function contextFor(row) {
    const title =
      row.querySelector("input[name='ruleTitle']")?.value?.trim()
      || row.querySelector(".rule-summary-main strong")?.textContent?.trim()
      || "规则正文";
    const badges = [...row.querySelectorAll(".rule-summary-main .badge, .rule-head .badge")]
      .map((badge) => badge.textContent.trim())
      .filter(Boolean);
    return {title, badges: [...new Set(badges)].slice(0, 4)};
  }

  function updatePreview(textarea) {
    const row = textarea.closest(ROW_SELECTOR);
    const preview = row?.querySelector(".rule-content-view");
    if (!preview) return;
    const normalized = String(textarea.value || "").replace(/\s+/gu, " ").trim();
    preview.textContent = normalized
      ? (normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized)
      : "暂无正文，展开后填写规则内容";
  }

  function enhanceTextarea(textarea) {
    if (
      !(textarea instanceof HTMLTextAreaElement)
      || textarea.dataset.ruleEditorEnhanced === "1"
      || textarea.hasAttribute(MIRROR_ATTR)
    ) return;
    const row = textarea.closest(ROW_SELECTOR);
    const form = textarea.closest(FORM_SELECTOR);
    if (!row || !form) return;

    textarea.dataset.ruleEditorEnhanced = "1";
    textarea.setAttribute(SOURCE_ATTR, "1");
    textarea.classList.add("rule-editor-textarea");
    ownerForms.set(textarea, form);

    const tools = document.createElement("div");
    tools.className = "rule-editor-tools";
    tools.setAttribute(ENHANCED_ATTR, "1");

    const fullscreenButton = document.createElement("button");
    fullscreenButton.type = "button";
    fullscreenButton.className = "icon-button rule-editor-fullscreen-button";
    fullscreenButton.dataset.ruleEditorAction = "open";
    fullscreenButton.title = "全屏编辑规则正文";
    fullscreenButton.setAttribute("aria-label", "全屏编辑规则正文");
    fullscreenButton.textContent = "⛶";

    tools.append(fullscreenButton);
    textarea.before(tools);
    queueAutosize(textarea);
  }

  function enhance(root) {
    bindListeners();
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    scope.querySelectorAll(TEXTAREA_SELECTOR).forEach(enhanceTextarea);
    scope.querySelectorAll(FILTER_SELECTOR).forEach(applyRuleFilter);
    observeRoot(scope);
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root) || typeof MutationObserver !== "function") return;
    observedRoots.add(root);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(TEXTAREA_SELECTOR)) enhanceTextarea(node);
          node.querySelectorAll?.(TEXTAREA_SELECTOR).forEach(enhanceTextarea);
        }
      }
    });
    observer.observe(root, {childList: true, subtree: true});
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;

    document.addEventListener("input", (event) => {
      const filter = event.target.closest?.(FILTER_SELECTOR);
      if (filter) {
        filter.closest(FORM_SELECTOR)?.removeAttribute("data-rule-show-all");
        applyRuleFilter(filter);
        return;
      }
      const textarea = event.target.closest?.(MANAGED_TEXTAREA_SELECTOR);
      if (!textarea) return;
      if (activeSession?.textarea === textarea) activeSession.dirty = true;
      if (activeSession?.textarea === textarea) syncMirror(activeSession);
      queueAutosize(textarea);
      updatePreview(textarea);
      if (textarea.closest(".rule-editor-fullscreen")) dispatchOwnerFormInput(textarea);
    });

    document.addEventListener("toggle", (event) => {
      const row = event.target.closest?.(ROW_SELECTOR);
      if (!row || !event.target.open) return;
      row.querySelectorAll("textarea[name='ruleContent']").forEach(queueAutosize);
    }, true);

    document.addEventListener("click", (event) => {
      const actionEl = event.target.closest?.(`[${TOOL_ATTR}]`);
      if (!actionEl) return;
      const action = actionEl.dataset.ruleEditorAction;
      if (action === "show-all") {
        const form = actionEl.closest(FORM_SELECTOR);
        if (!form) return;
        if (form.dataset.ruleShowAll === "1") form.removeAttribute("data-rule-show-all");
        else form.dataset.ruleShowAll = "1";
        const filter = form.querySelector(FILTER_SELECTOR);
        if (filter) applyRuleFilter(filter);
        return;
      }
      if (action === "open") {
        const row = actionEl.closest(ROW_SELECTOR);
        const textarea = row?.querySelector("textarea[name='ruleContent']");
        if (textarea) openFullscreen(textarea);
        return;
      }
      if (action === "apply") {
        closeFullscreen({apply: true});
        return;
      }
      if (action === "cancel") {
        closeFullscreen({apply: false});
        return;
      }
    });

    document.addEventListener("keydown", (event) => {
      if (!activeSession) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeFullscreen({apply: false});
        return;
      }
      if (event.key === "Tab") trapFocus(event);
    });

    window.addEventListener("resize", () => {
      document.querySelectorAll(MANAGED_TEXTAREA_SELECTOR).forEach(queueAutosize);
    });
  }

  function applyRuleFilter(input) {
    const form = input?.closest(FORM_SELECTOR);
    if (!form) return;
    const rows = [...form.querySelectorAll(ROW_SELECTOR)];
    const needle = String(input.value || "").trim().toLocaleLowerCase();
    const matches = rows.filter((row) => !needle || String(row.textContent || "").toLocaleLowerCase().includes(needle));
    const showAll = form.dataset.ruleShowAll === "1" || Boolean(needle);
    const visible = new Set((showAll ? matches : matches.slice(0, DEFAULT_VISIBLE_RULES)));
    rows.forEach((row) => { row.hidden = !visible.has(row); });
    const count = form.querySelector("[data-rule-filter-count]");
    if (count) count.textContent = needle
      ? `找到 ${matches.length} / ${rows.length} 条`
      : showAll || rows.length <= DEFAULT_VISIBLE_RULES
        ? `共 ${rows.length} 条`
        : `显示前 ${Math.min(DEFAULT_VISIBLE_RULES, rows.length)} / 共 ${rows.length} 条`;
    const toggle = form.querySelector("[data-rule-editor-action='show-all']");
    if (toggle) {
      toggle.hidden = Boolean(needle) || rows.length <= DEFAULT_VISIBLE_RULES;
      toggle.textContent = showAll ? "收起" : "显示全部";
    }
  }

  function openFullscreen(textarea) {
    if (activeSession) closeFullscreen({apply: true});
    const row = textarea.closest(ROW_SELECTOR);
    if (!row) return;
    if (!row.open) row.open = true;

    const {title, badges} = contextFor(row);
    const form = ownerForms.get(textarea) || textarea.closest(FORM_SELECTOR);
    const mirror = createMirror(textarea);
    const previousValue = textarea.value;
    const previousHeight = textarea.style.height;
    const previousOverflow = textarea.style.overflowY;
    const previousActive = document.activeElement;
    const sourceMeta = {
      formDataset: copyDataset(form),
      rowDataset: copyDataset(row),
      textareaName: textarea.name || "ruleContent"
    };

    const overlay = document.createElement("div");
    overlay.className = "rule-editor-fullscreen";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "规则正文全屏编辑");
    overlay.innerHTML = `
      <div class="rule-editor-fullscreen-panel">
        <div class="rule-editor-fullscreen-header">
          <div class="rule-editor-fullscreen-title">
            <span class="rule-editor-title-text"></span>
            <span class="rule-editor-state"></span>
          </div>
          <div class="rule-editor-fullscreen-actions">
            <button type="button" class="secondary-button" data-rule-editor-action="cancel">取消</button>
            <button type="button" class="primary-button" data-rule-editor-action="apply">应用修改</button>
          </div>
        </div>
        <div class="rule-editor-context"></div>
        <div class="rule-editor-fullscreen-body"></div>
      </div>
    `;

    overlay.querySelector(".rule-editor-title-text").textContent = title;
    overlay.querySelector(".rule-editor-state").textContent = isEditable(textarea) ? "未保存" : "只读";
    overlay.querySelector(".rule-editor-context").textContent = badges.join(" / ");
    dispatchOpened({textarea, form, row, sourceMeta, value: previousValue});
    textarea.after(mirror);
    overlay.querySelector(".rule-editor-fullscreen-body").append(textarea);
    document.body.append(overlay);
    document.body.classList.add("rule-editor-fullscreen-open");
    textarea.classList.add("is-fullscreen");

    activeSession = {
      textarea,
      mirror,
      overlay,
      previousValue,
      previousHeight,
      previousOverflow,
      previousActive,
      sourceMeta,
      wasEditable: isEditable(textarea),
      dirty: false
    };
    queueAutosize(textarea);
    textarea.focus({preventScroll: true});
  }

  function closeFullscreen({apply}) {
    if (!activeSession) return;
    const session = activeSession;
    const {textarea, mirror, overlay, previousValue, previousHeight, previousOverflow, previousActive} = session;
    const changedBeforeClose = textarea.value !== previousValue;
    const sourceTarget = resolveSourceTarget(session);

    if (apply && (!sourceTarget || (!session.wasEditable && changedBeforeClose))) {
      session.dirty = true;
      overlay.querySelector(".rule-editor-state").textContent = isEditable(textarea) ? "未保存" : "只读";
      queueAutosize(textarea);
      return;
    }

    if (apply && sourceTarget !== textarea && !isEditable(sourceTarget) && changedBeforeClose) {
      session.dirty = true;
      overlay.querySelector(".rule-editor-state").textContent = "只读";
      queueAutosize(textarea);
      return;
    }

    activeSession = null;

    if (!apply && sourceTarget === textarea) textarea.value = previousValue;
    syncMirror(session);
    let finalTextarea = textarea;
    if (apply && sourceTarget && sourceTarget !== textarea) {
      if (changedBeforeClose) sourceTarget.value = textarea.value;
      copyTextareaState(textarea, sourceTarget);
      textarea.remove();
      session.textarea = sourceTarget;
      finalTextarea = sourceTarget;
    } else if (!apply && sourceTarget && sourceTarget !== textarea) {
      textarea.remove();
      session.textarea = sourceTarget;
      finalTextarea = sourceTarget;
    } else if (mirror.parentNode) {
      mirror.replaceWith(textarea);
    }
    if (mirror.parentNode) mirror.remove();
    finalTextarea.classList.remove("is-fullscreen");
    finalTextarea.style.height = previousHeight;
    finalTextarea.style.overflowY = previousOverflow;
    overlay.remove();
    document.body.classList.remove("rule-editor-fullscreen-open");
    queueAutosize(finalTextarea);
    updatePreview(finalTextarea);

    if (apply && changedBeforeClose) dispatchTextareaInput(finalTextarea);
    dispatchClosed(session, {apply, changed: changedBeforeClose, sourceConnected: finalTextarea.isConnected});
    if (previousActive && typeof previousActive.focus === "function" && previousActive.isConnected) {
      previousActive.focus({preventScroll: true});
    }
  }

  function resolveSourceTarget(session) {
    const {textarea, mirror} = session;
    if (mirror.parentNode?.isConnected) return textarea;
    return findReplacementTextarea(session);
  }

  function findReplacementTextarea(session) {
    const {sourceMeta, textarea} = session;
    const candidates = [...document.querySelectorAll(TEXTAREA_SELECTOR)]
      .filter((candidate) => candidate !== textarea && !candidate.closest(".rule-editor-fullscreen"));
    return candidates.find((candidate) => {
      const row = candidate.closest(ROW_SELECTOR);
      const form = candidate.closest(FORM_SELECTOR);
      if (!row || !form) return false;
      if (!datasetMatches(form.dataset, sourceMeta.formDataset)) return false;
      if (sourceMeta.rowDataset.ruleId && row.dataset.ruleId !== sourceMeta.rowDataset.ruleId) return false;
      if (sourceMeta.rowDataset.ruleCategory && row.dataset.ruleCategory !== sourceMeta.rowDataset.ruleCategory) return false;
      if (sourceMeta.rowDataset.ruleSource && row.dataset.ruleSource !== sourceMeta.rowDataset.ruleSource) return false;
      if (!sourceMeta.rowDataset.ruleId && sourceMeta.rowDataset.origTitle && row.dataset.origTitle !== sourceMeta.rowDataset.origTitle) return false;
      return true;
    }) || null;
  }

  function datasetMatches(dataset, expected) {
    for (const [key, value] of Object.entries(expected || {})) {
      if (dataset[key] !== value) return false;
    }
    return true;
  }

  function copyTextareaState(from, to) {
    to.classList.add("rule-editor-textarea");
    to.dataset.ruleEditorEnhanced = "1";
    to.setAttribute(SOURCE_ATTR, "1");
    ownerForms.set(to, to.closest(FORM_SELECTOR));
  }

  function createMirror(textarea) {
    const mirror = document.createElement("textarea");
    mirror.name = textarea.name;
    mirror.value = textarea.value;
    mirror.hidden = true;
    mirror.setAttribute("aria-hidden", "true");
    mirror.setAttribute("tabindex", "-1");
    mirror.setAttribute(MIRROR_ATTR, "1");
    if (textarea.readOnly) mirror.readOnly = true;
    if (textarea.disabled) mirror.disabled = true;
    return mirror;
  }

  function dispatchOpened(detail) {
    document.dispatchEvent(new CustomEvent("aimac-rule-editor-opened", {
      detail: {
        value: detail.value,
        readOnly: detail.textarea.readOnly || detail.textarea.disabled,
        form: detail.sourceMeta.formDataset,
        row: detail.sourceMeta.rowDataset
      }
    }));
  }

  function dispatchClosed(session, detail) {
    document.dispatchEvent(new CustomEvent("aimac-rule-editor-closed", {
      detail: {
        ...detail,
        value: session.textarea.value,
        previousValue: session.previousValue,
        readOnly: session.textarea.readOnly || session.textarea.disabled,
        form: session.sourceMeta.formDataset,
        row: session.sourceMeta.rowDataset
      }
    }));
  }

  function trapFocus(event) {
    const overlay = activeSession?.overlay;
    if (!overlay) return;
    const focusable = [...overlay.querySelectorAll(FOCUSABLE_SELECTOR)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function isOpen() {
    return Boolean(activeSession);
  }

  window[API_NAME] = {enhance, isOpen};
})();
