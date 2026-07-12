---
description: package.json・.env.example を正とするドキュメントを同期します。doc-updater エージェントを起動して README・ガイドを更新します。
---

# ドキュメント更新

**doc-updater エージェント**を起動して、コードからドキュメントを最新化します。

## このコマンドが行うこと

- `package.json` のスクリプトを読み込んでリファレンス表を生成する
- `.env.example` を読み込んで環境変数をドキュメント化する
- `docs/CONTRIB.md` と `docs/RUNBOOK.md` を更新する
- 90日以上更新されていないドキュメントをレビュー対象としてフラグを立てる

## いつ使うか

- npm スクリプトや環境変数を追加した後
- セットアップ手順が古くなってきたとき
- 新バージョンのリリース前

## 関連エージェント

`~/.claude/agents/doc-updater.md` を起動します。
