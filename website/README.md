# DSH Desktop 下载站

这是一个不依赖构建工具的静态下载页，入口为 `index.html`。

## 本地预览

可以直接打开 `index.html`，也可以在仓库根目录运行一个静态服务器：

```powershell
pnpm exec serve website
```

页面中的安装包入口统一指向同级 `download` 文件夹。把 `.exe` 文件放入
`website/download/` 后，在 `website/download/index.html` 中添加对应链接即可。
