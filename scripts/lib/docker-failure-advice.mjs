// 【环境把 docker 挡住】时该说的话。抽成单独一份是为了它能被真的验一遍：
// 这类故障在本机复现不了（镜像一旦缓存下来就不再走那条路），而"复现不了"不该等于"不验"。
// 判别依据是 docker 自己吐的那句话；认不出来的返回 null，由调用方原样抛 —— 不假装懂。
export function dockerFailureAdvice(said = "") {
  if (/docker-credential-\S+": executable file not found/u.test(said)) {
    return "docker 的凭据助手不在 PATH 上，拉基础镜像这一步就失败了 —— 本仓的代码没有问题。"
      + "这台机器上 Docker Desktop 的 docker-credential-* 没进 PATH（常见于从非登录 shell 起的进程）。"
      + "出路二选一：把 Docker Desktop 的 bin 目录加进 PATH 后重开终端；"
      + "或者先手动把 postgres:16-alpine 与 node:22-alpine 拉到本地，这道门就不需要再联网取镜像了。";
  }
  if (/unable to resolve docker endpoint|Cannot connect to the Docker daemon|failed to connect to the docker API/u.test(said)) {
    return "连不上 docker 守护进程 —— 本仓的代码没有问题。"
      + "要么 Docker Desktop 没启动，要么 DOCKER_CONFIG 被指到了一个缺 contexts/ 的目录。";
  }
  return null;
}
