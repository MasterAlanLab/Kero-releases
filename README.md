# Kero

Kero 是 AI 编程桌面工作台，连接 Codex、Claude Code 与你的本地项目。

本仓库提供 Kero 客户端安装包与版本说明。

**[下载最新版本](https://github.com/MasterAlanLab/Kero-releases/releases/latest)** · [全部版本](https://github.com/MasterAlanLab/Kero-releases/releases) · [官网](https://kero.now) · [使用文档](https://kero.now/docs/)

| 系统 | 安装包 |
| --- | --- |
| macOS · Apple 芯片 | `kero-<版本>-arm64.zip` |
| macOS · Intel 芯片 | `kero-<版本>-x64.zip` |
| Windows · x64 | `kero-<版本>-Setup.exe` |
| Linux · x64（Debian / Ubuntu） | `kero-<版本>-amd64.deb` |
| Linux · x64（Arch、Fedora、openSUSE 等） | 终端运行 `curl -fsSL https://kero.now/install-linux.sh \| bash`，安装到个人目录，不需要 sudo |

请从具体版本的 **Assets** 下载对应安装包。`kero-<版本>-win32-x64-hotfix.zip` 供客户端应用内更新使用，不用于首次安装。GitHub 自动生成的 Source code 归档只是本发布仓库的文件，不能作为客户端安装。

macOS：解压后将 Kero 拖入「应用程序」。当前安装包采用 ad-hoc 签名，尚未经过 Apple 公证；首次启动可能被系统拦截，请核对下载来源后按系统提示处理。Windows 安装包目前未签名，系统可能显示发布者提示。

每个版本附带 `SHA256SUMS`，用于核对下载完整性。例如在 macOS / Linux 上，将校验文件和安装包放在同一目录后执行：

```sh
# macOS（只校验下载的那个文件）
shasum -a 256 kero-<版本>-arm64.zip
# Linux
sha256sum kero-<版本>-amd64.deb
```

将输出与 `SHA256SUMS` 中对应文件的值比较。校验值用于检查文件完整性，不代替代码签名。

维护者发布流程见 [PUBLISHING.md](PUBLISHING.md)。发布仓库结构参考 [Alma Releases](https://github.com/yetone/alma-releases)；Kero 是独立产品。
