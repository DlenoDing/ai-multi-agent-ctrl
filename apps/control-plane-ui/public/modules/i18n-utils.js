/*
 * 控制台国际化公共工具。
 * 挂到 window 上，便于浏览器直接加载，也便于现有 VM 行为门按脚本方式注入。
 */
(function initI18nUtils(global) {
  const I18N = global.AIMAC_I18N || {t: (value) => String(value ?? "-")};
  const t = (value) => I18N.t(value);

  // 失败原因常常是 "code:detail" 形态：先整串查词表，查不到就翻译冒号前的错误码。
  function explainCoded(value) {
    if (value === null || value === undefined || value === "") return "-";
    const text = String(value);
    const dict = I18N.dict || {};
    if (Object.prototype.hasOwnProperty.call(dict, text)) return t(text);
    const at = text.indexOf(":");
    const prefix = at > 0 ? text.slice(0, at) : "";
    if (prefix && Object.prototype.hasOwnProperty.call(dict, prefix)) return `${t(prefix)}：${text.slice(at + 1)}`;
    return t(text);
  }

  global.AIMAC_CONSOLE_I18N_UTILS = {I18N, t, explainCoded};
})(window);
