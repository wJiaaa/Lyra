# 编辑文件的格式

`edit` 用行锚定的补丁，不是 `old_string`/`new_string`。

先 `read` 拿到文件头上的 `[路径#TAG]`，编辑时把那个 tag 带上：

```
REPLACE 12-14
+新的第一行
+新的第二行

INSERT AFTER 40
+插在第 40 行后面

DELETE 7-9
```

tag 对不上就说明文件在你读完之后被改过了，这时编辑会被拒绝而不是覆盖。
重新 `read` 再按新的行号来。
