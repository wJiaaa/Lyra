# 地址空间

这些地址在 `read` 里跟普通路径一样用：

- `skill://<名字>` 技能正文；`skill://<名字>/<路径>` 技能目录里的文件；以 `/` 结尾（`skill://<名字>/references/`）列出那一层目录，`ls skill://<名字>/references` 也行
- `scratch://<路径>` 本次会话的临时目录，**可写**（`write`、`edit` 都能用），随会话删除一起清掉
- `plume://<主题>` Plume 自己的使用说明

末尾可以跟行范围：`read skill://pdf:10-40`。
只给 scheme（`read skill://`）会列出这个命名空间里有什么。
