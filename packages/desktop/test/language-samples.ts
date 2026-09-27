/**
 * One short sample per highlighted language, for `language-coverage.test.ts`.
 *
 * Each sample exists to put something on every colour a theme declares, which is why nearly all
 * of them carry a comment, a string and a keyword. `key` is the grammar key, as `GRAMMARS` in
 * `src/lib/code/highlight.ts` spells it.
 */

export const LANGUAGE_SAMPLES: { key: string; label: string; sample: string }[] = [
	{
		key: "ts",
		label: "TypeScript",
		sample: `// 取一个用户，取不到就报错
export async function findUser(id: string): Promise<User> {
	const found = await db.users.findOne({ id });
	if (!found) throw new Error(\`没有这个用户：\${id}\`);
	return found;
}`,
	},
	{
		key: "tsx",
		label: "TSX / React",
		sample: `export function Badge({ count }: { count: number }) {
	// 超过 99 就不再数了
	const label = count > 99 ? "99+" : String(count);
	return <span className="rounded-full bg-accent px-1.5">{label}</span>;
}`,
	},
	{
		key: "js",
		label: "JavaScript",
		sample: `// 取一个用户，取不到就报错
export async function findUser(id) {
	const found = await db.users.findOne({ id });
	if (!found) throw new Error(\`没有这个用户：\${id}\`);
	return found;
}`,
	},
	{
		key: "jsx",
		label: "JSX",
		sample: `export const Empty = ({ title, hint }) => (
	<div className="flex flex-col items-center gap-1">
		<strong>{title}</strong>
		<span className="text-ink-faint">{hint}</span>
	</div>
);`,
	},
	{
		key: "json",
		label: "JSON",
		sample: `{
	"name": "@lyra/desktop",
	"version": "0.8.32",
	"private": true,
	"scripts": { "dev": "electron-vite dev", "test": "node --test" }
}`,
	},
	{
		key: "jsonc",
		label: "JSON with Comments",
		sample: `{
	// 编译目标：跟着 Electron 走
	"compilerOptions": {
		"target": "ES2023",
		"strict": true
	}
}`,
	},
	{
		key: "md",
		label: "Markdown",
		sample: `# 标题

正文里可以有 **粗体**、*斜体*、\`行内代码\` 和 [链接](https://example.com)。

> 引用里也可以写东西。

1. 有序的一条
2. 有序的两条

\`\`\`ts
const answer = 42;
\`\`\``,
	},
	{
		key: "css",
		label: "CSS",
		sample: `/* 卡片，浮在页面之上一点点 */
.card {
	background: var(--color-card);
	border-radius: 10px;
	box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
}`,
	},
	{
		key: "scss",
		label: "SCSS",
		sample: `$radius: 10px;

.card {
	border-radius: $radius;
	&:hover { background: rgba(0, 0, 0, 0.04); }
}`,
	},
	{
		key: "less",
		label: "Less",
		sample: `@radius: 10px;

.card {
	border-radius: @radius;
	&:hover { background: fade(#000, 4%); }
}`,
	},
	{
		key: "html",
		label: "HTML",
		sample: `<!doctype html>
<html lang="zh">
	<head>
		<!-- 字符集要在最前面 -->
		<meta charset="utf-8" />
		<title>Lyra</title>
	</head>
	<body>
		<main id="root" data-ready="false"></main>
		<script type="module" src="/src/main.ts"></script>
	</body>
</html>`,
	},
	{
		key: "vue",
		label: "Vue SFC",
		sample: `<template>
	<button :class="{ on }" @click="on = !on">{{ label }}</button>
</template>

<script setup lang="ts">
const on = ref(false);
const label = computed(() => (on.value ? "开" : "关"));
</script>

<style scoped>
button { border-radius: 6px; }
</style>`,
	},
	{
		key: "xml",
		label: "XML / SVG",
		sample: `<!-- 一个圆 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
	<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" />
</svg>`,
	},
	{
		key: "py",
		label: "Python",
		sample: `# 取一个用户，取不到就报错
async def find_user(id: str) -> User:
    found = await db.users.find_one({"id": id})
    if not found:
        raise LookupError(f"没有这个用户：{id}")
    return found`,
	},
	{
		key: "go",
		label: "Go",
		sample: `package main

import "fmt"

// findUser 取一个用户，取不到就报错。
func findUser(id string) (*User, error) {
	found, err := db.users.FindOne(id)
	if err != nil {
		return nil, fmt.Errorf("没有这个用户：%s", id)
	}
	return found, nil
}`,
	},
	{
		key: "rs",
		label: "Rust",
		sample: `/// 取一个用户，取不到就报错。
pub async fn find_user(id: &str) -> Result<User, Error> {
    let found = db.users.find_one(id).await?;
    match found {
        Some(user) => Ok(user),
        None => Err(Error::NotFound(format!("没有这个用户：{id}"))),
    }
}`,
	},
	{
		key: "java",
		label: "Java",
		sample: `package com.lyra;

/** 一个用户。 */
public record User(String id, String name) {
	public String greet() {
		return "你好，" + name;
	}
}`,
	},
	{
		key: "kt",
		label: "Kotlin",
		sample: `// 一个用户
data class User(val id: String, val name: String = "匿名") {
    fun greet(): String = "你好，$name"
}`,
	},
	{
		key: "c",
		label: "C",
		sample: `#include <stdio.h>

/* 打个招呼 */
int main(void) {
	const char *name = "世界";
	printf("你好，%s\\n", name);
	return 0;
}`,
	},
	{
		key: "cpp",
		label: "C++",
		sample: `#include <string>

// 一个用户
struct User {
	std::string id;
	std::string name{"匿名"};

	[[nodiscard]] std::string greet() const { return "你好，" + name; }
};`,
	},
	{
		key: "cs",
		label: "C#",
		sample: `namespace Lyra;

// 一个用户
public record User(string Id, string Name = "匿名")
{
    public string Greet() => $"你好，{Name}";
}`,
	},
	{
		key: "swift",
		label: "Swift",
		sample: `// 一个用户
struct User {
    let id: String
    var name: String = "匿名"

    func greet() -> String { "你好，\\(name)" }
}`,
	},
	{
		key: "rb",
		label: "Ruby",
		sample: `# 一个用户
class User
  attr_reader :id, :name

  def initialize(id, name = "匿名")
    @id = id
    @name = name
  end

  def greet = "你好，#{name}"
end`,
	},
	{
		key: "php",
		label: "PHP",
		sample: `<?php

// 一个用户
final class User
{
    public function __construct(
        public readonly string $id,
        public string $name = '匿名',
    ) {}

    public function greet(): string
    {
        return "你好，{$this->name}";
    }
}`,
	},
	{
		key: "sql",
		label: "SQL",
		sample: `-- 最近登录过的用户
SELECT u.id, u.name, COUNT(s.id) AS sessions
FROM users AS u
LEFT JOIN sessions AS s ON s.user_id = u.id
WHERE u.last_seen_at > NOW() - INTERVAL '7 days'
GROUP BY u.id, u.name
ORDER BY sessions DESC
LIMIT 20;`,
	},
	{
		key: "yaml",
		label: "YAML",
		sample: `# 部署
services:
  api:
    image: registry/api:latest
    ports: ["8080:8080"]
    environment:
      NODE_ENV: production`,
	},
	{
		key: "toml",
		label: "TOML",
		sample: `# 包信息
[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = { version = "1", features = ["derive"] }`,
	},
	{
		key: "sh",
		label: "Shell",
		sample: `#!/usr/bin/env bash
set -euo pipefail

# 逐个构建并推送
for name in api web; do
	docker build -t "registry/\${name}:latest" "./\${name}"
	docker push "registry/\${name}:latest"
done`,
	},
	{
		key: "graphql",
		label: "GraphQL",
		sample: `# 取一个用户和他最近的会话
query User($id: ID!) {
	user(id: $id) {
		id
		name
		sessions(last: 5) { id startedAt }
	}
}`,
	},
	{
		key: "proto",
		label: "Protocol Buffers",
		sample: `syntax = "proto3";

// 一个用户
message User {
	string id = 1;
	string name = 2;
	repeated string roles = 3;
}`,
	},
	{
		key: "lua",
		label: "Lua",
		sample: `-- 打个招呼
local function greet(name)
	name = name or "匿名"
	return ("你好，%s"):format(name)
end

return { greet = greet }`,
	},
	{
		key: "scala",
		label: "Scala",
		sample: `// 一个用户
final case class User(id: String, name: String = "匿名"):
  def greet: String = s"你好，$name"`,
	},
	{
		key: "hs",
		label: "Haskell",
		sample: `-- 打个招呼
greet :: Maybe String -> String
greet (Just name) = "你好，" ++ name
greet Nothing     = "你好"`,
	},
	{
		key: "clj",
		label: "Clojure",
		sample: `;; 打个招呼
(defn greet
  ([] (greet "匿名"))
  ([name] (str "你好，" name)))`,
	},
	{
		key: "erl",
		label: "Erlang",
		sample: `%% 打个招呼
-module(greeter).
-export([greet/1]).

greet(Name) ->
	io_lib:format("你好，~s", [Name]).`,
	},
	{
		key: "dart",
		label: "Dart",
		sample: `// 一个用户
class User {
  User(this.id, [this.name = '匿名']);

  final String id;
  final String name;

  String greet() => '你好，$name';
}`,
	},
	{
		key: "m",
		label: "Objective-C",
		sample: `// 一个用户
@interface User : NSObject
@property (nonatomic, copy) NSString *name;
- (NSString *)greet;
@end`,
	},
	{
		key: "perl",
		label: "Perl",
		sample: `# 打个招呼
sub greet {
	my ($name) = @_;
	$name //= "匿名";
	return "你好，$name";
}`,
	},
	{
		key: "cmake",
		label: "CMake",
		sample: `# 最低版本
cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)

add_executable(demo src/main.cpp)
target_compile_features(demo PRIVATE cxx_std_20)`,
	},
	{
		key: "tex",
		label: "LaTeX",
		sample: `% 一份文档
\\documentclass{article}
\\begin{document}
	你好，世界。
\\end{document}`,
	},
];
