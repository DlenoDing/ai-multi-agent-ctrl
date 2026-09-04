/*
 * 控制台时间、时区与字节格式化工具。
 */
(function initTimeFormat(global) {
  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

  let serverClockSkewMs = 0;

  function noteServerClock(response) {
    const header = response?.headers?.get?.("date");
    if (!header) return;
    const serverNowMs = new Date(header).getTime();
    if (!Number.isFinite(serverNowMs)) return;
    serverClockSkewMs = Date.now() - serverNowMs;
  }

  function serverNow() {
    return Date.now() - serverClockSkewMs;
  }

  function clockSkewNote() {
    const minutes = Math.round(serverClockSkewMs / 60000);
    if (Math.abs(minutes) < 2) return "";
    return `本机时钟比服务器${minutes > 0 ? "快" : "慢"} ${Math.abs(minutes)} 分钟`;
  }

  function localZoneLabel() {
    const minutes = -new Date().getTimezoneOffset();
    if (!Number.isFinite(minutes)) return "UTC";
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    const rest = abs % 60;
    return `UTC${sign}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
  }

  function fmtTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return esc(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fmtBytes(value) {
    const bytes = Number(value || 0);
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function durationText(ms) {
    const minutes = Math.floor(Number(ms) / 60000);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} 小时`;
    return `${Math.round(hours / 24)} 天`;
  }

  global.AIMAC_CONSOLE_TIME = {
    noteServerClock,
    serverNow,
    clockSkewNote,
    localZoneLabel,
    fmtTime,
    fmtBytes,
    durationText
  };
})(window);
