/*
 * 控制台国际化公共工具。
 * 挂到 window 上，便于浏览器直接加载，也便于现有 VM 行为门按脚本方式注入。
 */
(function initI18nUtils(global) {
  const I18N = global.AIMAC_I18N || {t: (value) => String(value ?? "-")};
  const t = (value) => I18N.t(value);

  // 失败原因常常是 "code:detail" 形态：先整串查词表，查不到就逐段翻译 —— 原因会一层套一层
  // （"checkpoint_replay_recover_required: changed_paths_outside_repository_target_allowlist: 409"），
  // 只翻第一段等于把后面真正说明原因的那段英文码原样甩给人；末尾纯数字的 HTTP 状态对人没有信息，去掉。
  function explainCoded(value) {
    if (value === null || value === undefined || value === "") return "-";
    const text = String(value);
    const dict = I18N.dict || {};
    const known = (part) => Object.prototype.hasOwnProperty.call(dict, part);
    if (known(text)) return t(text);
    const parts = text.split(":").map((part) => part.trim());
    if (parts.length > 1 && known(parts[0])) {
      const rest = parts.slice(1).filter((part, index, all) => !(index === all.length - 1 && /^\d{3}$/u.test(part)));
      return [t(parts[0]), ...rest.map((part) => (known(part) ? t(part) : part))].filter(Boolean).join("：");
    }
    return t(text);
  }

  global.AIMAC_CONSOLE_I18N_UTILS = {I18N, t, explainCoded};
})(window);
