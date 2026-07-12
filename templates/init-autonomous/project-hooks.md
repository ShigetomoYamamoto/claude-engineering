# init-autonomous テンプレート: プロジェクト側hook（settings配線・debug-output-detector.py・品質ガード）

> `/init-autonomous` のステップ4が読み込む生成テンプレート集。`{{ }}` を収集情報で
> 置換し、検出スタックに該当する分だけ生成する。元は `commands/init-autonomous.md` に
> 埋め込まれていたものを保守性のため外出し（ADR: テンプレート外出し / 要件 Issue #1）。

---

### 4-10. プロジェクト側 hook（スタック別デバッグ出力検知）

検出スタックに応じて `.claude/hooks/debug-output-detector.py` を生成し、編集直後に言語固有のデバッグ出力（`console.log` / `print()` / `var_dump()` 等）を検知する。グローバル側ではスタック非依存の検知ができないため、プロジェクト側で対応する設計。

#### `.claude/settings.json` への配線追加

**Step 1: `/tmp/` でマージ**

```bash
python3 << 'PYEOF'
import json, os

existing = {}
if os.path.exists(".claude/settings.json"):
    with open(".claude/settings.json") as f:
        existing = json.load(f)

new_hook = {
    "matcher": "Edit|Write|MultiEdit",
    "hooks": [{"type": "command", "command": "bash -c 'for d in \"$CLAUDE_PROJECT_DIR\" \"$PWD\"; do p=\"$d/.claude/hooks/debug-output-detector.py\"; [ -n \"$d\" ] && [ -f \"$p\" ] && exec python3 \"$p\"; done; exit 0'"}]
}

hooks = existing.setdefault("hooks", {})
post_tool = hooks.setdefault("PostToolUse", [])
if new_hook["matcher"] not in [h.get("matcher") for h in post_tool]:
    post_tool.append(new_hook)

with open("/tmp/claude_settings.json", "w") as f:
    json.dump(existing, f, indent=2)

print("✓ /tmp/claude_settings.json に hooks を追加しました")
PYEOF
```

**Step 2: プロジェクトに配置**

```bash
mkdir -p .claude && cp /tmp/claude_settings.json .claude/settings.json && echo "✓ 配置しました"
```

cp がブロックされた場合:

```
! mkdir -p .claude && cp /tmp/claude_settings.json .claude/settings.json
```

#### `.claude/hooks/debug-output-detector.py`

**Step 1: `/tmp/` に生成**（不要な言語の行は削除すること）

```bash
cat > /tmp/debug-output-detector.py << 'HEREDOC'
#!/usr/bin/env python3
"""PostToolUse(Edit|Write|MultiEdit): 言語別デバッグ出力を即時警告"""
import json, sys, re

try:
    data = json.load(sys.stdin)
    path = data.get('tool_input', {}).get('file_path', '')
    if not path:
        sys.exit(0)

    PATTERNS = {
        ('.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'): [r'console\.log', r'console\.debug', r'\bdebugger\b'],
        ('.py',):  [r'\bprint\(', r'\bbreakpoint\(', r'pdb\.set_trace'],
        ('.php',): [r'\bvar_dump\(', r'\bprint_r\(', r'\bdd\(', r'\bdie\('],
        ('.rb',):  [r'\bbinding\.pry\b', r'\bbyebug\b'],
        ('.go',):  [r'fmt\.Println\('],
        ('.rs',):  [r'\bdbg!', r'\bprintln!'],
    }

    matched = next((ps for exts, ps in PATTERNS.items() if any(path.endswith(e) for e in exts)), None)
    if not matched:
        sys.exit(0)

    try:
        content = open(path).read()
    except Exception:
        sys.exit(0)

    found = []
    for n, line in enumerate(content.splitlines(), 1):
        if any(re.search(p, line) for p in matched):
            found.append((n, line.strip()))

    if found:
        print(f'⚠️  デバッグ出力を検出: {path}')
        for n, line in found[:5]:
            print(f'  {n}: {line}')
except SystemExit:
    raise
except Exception:
    sys.exit(0)
HEREDOC
```

**Step 2: プロジェクトに配置**

```bash
mkdir -p .claude/hooks && cp /tmp/debug-output-detector.py .claude/hooks/debug-output-detector.py && echo "✓ 配置しました"
```

cp がブロックされた場合:

```
! mkdir -p .claude/hooks && cp /tmp/debug-output-detector.py .claude/hooks/debug-output-detector.py
```

**設計原則**: 100 行以下・単一責務・予期せぬエラーは `exit 0`・ネットワーク通信禁止（グローバル hook と同じ規約）。

---

### 4-11. スタック固有の品質ガード設定

検出スタックに応じて、品質ガード用の追加設定をプロジェクトに生成する。

#### Web フロントエンド検出時（Next.js / React / Vue / Nuxt）

`eslint.config.js`（または既存の設定）にアクセシビリティチェックを追加:

```js
// React 系
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default [
  // ...
  {
    plugins: { 'jsx-a11y': jsxA11y },
    rules: jsxA11y.configs.recommended.rules,
  },
]
```

devDependencies に追加: `eslint-plugin-jsx-a11y`（React 系）または `eslint-plugin-vuejs-accessibility`（Vue 系）。

#### Web プロジェクト検出時（フロント or バック問わず HTTP サービス）

`package.json` に Lighthouse CI スクリプトを追加（テンプレートのみ・実 URL は後でユーザーが記入）:

```json
{
  "scripts": {
    "lighthouse": "lhci autorun"
  },
  "devDependencies": {
    "@lhci/cli": "^0.13.0"
  }
}
```

`.github/workflows/lighthouse.yml` のテンプレートも生成（プレビュー URL 取得後にユーザーが有効化）。

#### API サーバー検出時（Express / FastAPI / Laravel など）

`package.json` または `pyproject.toml` などにベンチマークツールを追加（テンプレート）:
- Node.js: `autocannon`
- Python: `pytest-benchmark`
- PHP: `phpbench`

これらは初期生成のみ。実際の測定対象・閾値はプロジェクトで決める。

---

