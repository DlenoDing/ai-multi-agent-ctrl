import { unique } from "./collection-utils.mjs";

// 不改成超长即拒（规则编辑器那套）：那会让一次完整的互审因为超长整个丢掉，代价比截断更大。
export function clampVisibleText(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  const marker = "…（已截断）";
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

export function canUseGitPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("artifacts/") && !path.startsWith(".runtime/") && !path.startsWith("tmp/") && !path.includes("..");
}

// 分支/引用名会被原样交给 git。以 - 开头会被当成选项，空白与 ^~:?*[\\ 是 git 的引用语法字符。
// 控制面这一侧收严到白名单字符集；agent 运行时是【单文件、只依赖 node 内置】的孪生实现，
// 它自带一份检查（runtime.mjs 的 content_bundle_git_transfer_unsafe_ref），
// 两份不能共用代码，但对危险形态的判断必须一致 —— 由 verifyGitRefGuardsAgree 交叉核对。
export function isSafeGitRef(ref) {
  const value = String(ref || "");
  if (!value) return false;
  if (value.startsWith("-") || value.includes("..")) return false;
  return /^[A-Za-z0-9._/-]+$/u.test(value);
}

export function pathAllowlistValid(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(canUseGitPath);
}

export function pathMatchesAllowlist(path, allowlist) {
  if (!canUseGitPath(path)) return false;
  return (allowlist || []).some((pattern) => {
    if (!canUseGitPath(pattern)) return false;
    // 「前缀/**」这条快路只有在前缀是【字面量】时才成立。原先它对 apps/*/src/** 也照走，
    // 拿字符串 "apps/*/src/" 去 startsWith —— 一个真实路径都匹配不上，于是这条允许路径
    // 匹配不到任何东西。表现是【守卫过头且不出声】：人按规则写了它，agent 照它写文件，
    // 却被判成「写到批准范围之外」，而报文只说越界，不会说「你这条规则本身没生效」。
    if (pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*")) {
      return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2));
    }
    if (!pattern.includes("*")) return path === pattern;
    return globPathMatches(pattern.split("/"), path.split("/"));
  });
}

function globPathMatches(patternSegments, pathSegments) {
  let patternIndex = 0;
  let pathIndex = 0;
  let starPatternIndex = -1;
  let starPathIndex = -1;
  while (pathIndex < pathSegments.length) {
    if (patternIndex < patternSegments.length && patternSegments[patternIndex] === "**") {
      starPatternIndex = patternIndex;
      starPathIndex = pathIndex;
      patternIndex += 1;
    } else if (patternIndex < patternSegments.length && globSegmentMatches(patternSegments[patternIndex], pathSegments[pathIndex])) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (starPatternIndex !== -1) {
      patternIndex = starPatternIndex + 1;
      starPathIndex += 1;
      pathIndex = starPathIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < patternSegments.length && patternSegments[patternIndex] === "**") patternIndex += 1;
  return patternIndex === patternSegments.length;
}

function globSegmentMatches(patternSegment, pathSegment) {
  const escaped = patternSegment.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(pathSegment);
}

// 原先每个生产者各写一份默认值（`request.pathDenylist || [...]`），于是两件事同时成立：
// 调用方传个空数组就能把禁区整个抹掉；而 REST 那条创建路径【根本没有写这个字段】——
// 服务端的禁区判据 `target.pathDenylist || []` 随之恒为空集，执行侧同理。
// 结果是一个具备任务组写作用域的用户可以建一个 pathAllowlist 含 ".github/workflows/**" 的目标，
// agent 改掉 CI 配置、推上去，CI 拿仓库凭据执行 —— 两侧都没有禁区。
// 每条都带 `**/` 前缀：禁区的语义是「这些名字在【任何深度】都禁」，而不是「只在仓库根禁」。
// 本仓是 monorepo，子目录里的 .env / node_modules / 子模块 .git / 各 app 自己的 CI 配置极常见 ——
// 根锚模式（".env" 只等于根 .env、"node_modules/**" 只匹配根 node_modules）会让 apps/x/.env、
// apps/x/node_modules/**、services/api/Jenkinsfile 全部逃过禁区。而禁区是【唯一的服务端强制点】
// （执行方自查不算），配一个宽 allowlist（apps/**）子目录密钥/CI 配置就被接受提交。
// `**/.env` + `**/.env.*` 覆盖所有 env 变体（.env / .env.local / .env.staging …）且精确：
// 不误伤 foo.env、environment.ts（段必须以 .env 起头）。
export const MANDATORY_PATH_DENYLIST = Object.freeze([
  "**/.runtime/**", "**/.git/**", "**/node_modules/**", "**/.env", "**/.env.*",
  // CI 配置等于"仓库凭据可执行的代码"：允许改它，等于把写代码的权限升级成执行权限。
  "**/.github/workflows/**", "**/.github/actions/**", "**/.gitlab-ci.yml", "**/Jenkinsfile"
]);

// 使用点求取：已经落库的旧目标（含那些完全没有该字段的）也要拿到这个下限，
// 只在生产者补齐是不够的 —— 生产者可以再多一个，而判据只有这一处。
// 产出目标指向的仓库必须是【本项目登记过的】那一个。原先 repositoryUrl 直接取调用方入参，
// 覆盖项目登记的地址，没有任何交叉校验 —— 而写入只被授权在任务组作用域上。于是一个对任务组
// 有写权限的人可以把目标指向宿主机上另一个仓库（isSafeGitRemoteUrl 放行 file:// 与裸本地路径），
// agent 在其中改动并 push，写进一个与本任务毫无关系的仓库。
// 这是"守卫作用域没有覆盖实际被变更的资源"那一类：授权针对 A，改动落在 B。
export function normalizeRepositoryUrl(url) {
  // 先剥尾斜杠再剥 .git —— 反过来的话 "…/repo.git/" 里的 .git 剥不掉（它不在结尾），
  // 于是同一个仓库的两种写法被判成两个仓库。顺序错了不会报错，只会静默拒绝合法地址。
  return String(url || "").trim().replace(/\/+$/u, "").replace(/\.git$/u, "").replace(/\/+$/u, "").toLowerCase();
}

// 项目的仓库登记在【两个地方】：顶层 project.repositories（只有种子写过）与
// project.config.repositories（界面那个"仓库与访问凭据"表单写的、建项目时也写这里）。
// 而准入判定、提交目标、URL 白名单读的都是顶层 —— 于是经界面建的项目永远"没登记仓库"：
// 单元被 project_repository_not_registered 挡住，人去项目设置里加一条仓库，那条改动
// 落在另一个字段上，挡的那道判定一动不动。界面上有入口，接的却不是这根线。
// 统一从这里取：先看配置层（人能改的那份），没有再退回顶层（老数据/种子）。
export function projectRepositories(project) {
  const configured = project?.config?.repositories;
  if (Array.isArray(configured) && configured.length) return configured;
  return Array.isArray(project?.repositories) ? project.repositories : [];
}

export function repositoryUrlRegisteredForProject(project, url) {
  const registered = projectRepositories(project).map((item) => normalizeRepositoryUrl(item.url)).filter(Boolean);
  // 项目一个仓库都没登记时不拦（本地部署/引导期），此时地址由服务端从工作区推导，不是调用方给的。
  if (!registered.length) return true;
  return registered.includes(normalizeRepositoryUrl(url));
}

export function effectivePathDenylist(target) {
  const declared = Array.isArray(target?.pathDenylist) ? target.pathDenylist
    : Array.isArray(target?.forbiddenPathRules) ? target.forbiddenPathRules : [];
  return unique([...MANDATORY_PATH_DENYLIST, ...declared]);
}
