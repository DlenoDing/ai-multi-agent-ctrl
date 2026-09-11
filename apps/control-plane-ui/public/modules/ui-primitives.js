(function () {
  "use strict";

  const {esc} = window.AIMAC_CONSOLE_DOM_UTILS;

  function progressBar(percent, extra = "") {
    const safe = Math.max(0, Math.min(100, Number(percent || 0)));
    return `<div class="progress ${extra}" aria-label="进度 ${safe}%"><span style="width:${safe}%"></span></div>`;
  }

  function progressLine(percent) {
    const safe = Math.max(0, Math.min(100, Number(percent || 0)));
    return `<div class="progress-line">${progressBar(safe)}<em>${safe}%</em></div>`;
  }

  function quotaLine(used, max, reserved = 0) {
    const total = Math.max(1, Number(max || 1));
    const held = Number(used || 0) + Number(reserved || 0);
    const percent = Math.round((held / total) * 100);
    const tone = percent >= 100 ? "quota-full" : percent >= 80 ? "quota-warn" : "quota-ok";
    // 上限被调到当前用量以下（例如成员 2/1）：不会移除已有的，但在降到上限以下前不能再新增 —— 这一行要说出来，
    // 不然人只看到一个 2/1，不知道是数错了还是出了什么事（09-12 系统管理员调配额走查）。
    const over = Number(max) > 0 && held > Number(max);
    return `<div class="progress-line">${progressBar(percent, tone)}<em>${used ?? 0}/${max ?? 0}`
      + `${Number(reserved) > 0 ? `（另有 ${esc(reserved)} 张未使用的加入令牌占着位，合计 ${held}/${max ?? 0}）` : ""}</em></div>`
      + `${over ? `<div class="small warn-text">已超出上限：不会移除已有的，但降到上限以下前不能再新增</div>` : ""}`;
  }

  function panel(title, body, options = {}) {
    return `
      <article class="panel ${options.wide ? "wide" : ""}">
        <div class="panel-header"><h2>${esc(title)}</h2>${options.headerSide ? `<div class="header-side">${options.headerSide}</div>` : ""}</div>
        <div class="panel-body">${body}</div>
      </article>
    `;
  }

  function cell(item) {
    if (item && typeof item === "object" && "v" in item) {
      const titleAttr = (item.c && item.c.includes("text-clip") && !/[<>]/u.test(String(item.v))) ? ` title="${item.v}"` : "";
      return `<td class="${item.c || ""}"${titleAttr}>${item.v}</td>`;
    }
    return `<td>${item}</td>`;
  }

  function row(items) {
    return `<tr>${items.map(cell).join("")}</tr>`;
  }

  window.AIMAC_CONSOLE_UI_PRIMITIVES = {progressBar, progressLine, quotaLine, panel, cell, row};
})();
