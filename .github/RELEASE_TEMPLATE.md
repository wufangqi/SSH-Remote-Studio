# SSH Remote Studio {version}

> SSH 隧道工作台：图形化管理本地 `-L`、远程 `-R` 与动态 SOCKS `-D` 转发，隧道可保存、断线可恢复、流量可观测；无需在远端安装任何 agent。

发布日期：{date}

## 亮点

- {highlight_1}
- {highlight_2}

## 修复与改进

- {fix_1}
- {fix_2}

## 平台与产物

| 平台 | 状态 | 产物 |
|---|---|---|
| Windows | 优先支持 | NSIS 安装包 / 便携版 |
| macOS | beta | `.dmg` / `.zip`（需在 macOS 构建验证） |
| Linux | beta | AppImage / `.deb`（需在 Linux 构建验证） |

## 已知限制

- 当前不提供远程终端（shell），不替代 VS Code 或其他 IDE。
- `~/.ssh/config` 的 `Include` / `Match` 暂不展开；导入的跳板机认证沿用私钥 / Agent。
- 自动重连与健康检查尚未实现。
- 安装包尚未配置代码签名。
- macOS / Linux 为 beta，需在对应平台完成构建与真机验证。

## 升级提示

- 转发定义随连接保存；升级后如遇异常，可在「端口转发」页手动停止并重新启动隧道。
- 反馈与问题：https://github.com/wufangqi/SSH-Remote-Studio/issues
