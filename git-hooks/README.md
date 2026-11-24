# Git フック (git ネイティブのガード)

AI エージェントが保護ブランチ (main など) を直接更新するのを、git 自身に止めさせる仕組みです。

- `hooks/` の Claude Code 側フックは、実行前にコマンド文字列を見て判定するベストエフォートの層です (限界は ADR-028 のとおり)。
- こちらは git がフックを実行する時点で判定するので、コマンドの書き方に左右されません。実質的な止め役はこちらです。
- 環境変数 `CLAUDECODE=1` のときだけ作用します。Claude Code は、自分が起動するシェルにこの変数を設定します。人間が端末で操作するとき (未設定、または `1` 以外) は一切影響しません。

## 導入 (リポジトリごと。マシン全体には何も入れません)

```text
python3 install.py install --project /abs/path/to/project
python3 install.py update  --project /abs/path/to/project
```

`install` / `update` は、通常の `.claude/` へのコピーのあとに次を行います。

1. `git-hooks/guard.sh` を、導入先リポジトリの git 共通ディレクトリ (`git rev-parse --git-common-dir`) の `hooks/` に、`pre-commit` / `pre-merge-commit` / `pre-push` の 3 つの名前で置きます。実ファイル (シンボリックリンクではない)、モード 0755 です。
2. リンクされた worktree (`git worktree add`) から実行しても、置き先は本体リポジトリの `hooks/` です (worktree 間で共有されます)。
3. 対象のリポジトリは、導入先プロジェクトのルート (`.claude` の親) から探します。`.claude` 自体が入れ子のリポジトリでも、そこには置きません。環境変数 `GIT_DIR` / `GIT_COMMON_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` は無視します。
4. `git-hooks/` は `.claude/` にはコピーしません (管理対象パスに入っていません)。マニフェストにも載せません。印 (下記) とハッシュで識別します。

`git config --global` や `core.hooksPath` の設定は行いません。導入先リポジトリの外は書き換えません。

## 動作

| フック | 走る場面 | `CLAUDECODE=1` のときの動作 |
|---|---|---|
| `pre-commit` | `git commit` (`--amend` を含む) | 現在のブランチが保護対象なら終了コード 1 で中止します。detached HEAD と、HEAD がまだ無い最初のコミットは許可します |
| `pre-merge-commit` | fast-forward にならないマージがマージコミットを作るとき | 上と同じ判定です |
| `pre-push` | `git push` | リモート側の ref が `refs/heads/<保護ブランチ>` なら、更新・force・削除のどれでも中止します。他のブランチとタグは許可します |

- 既定の保護ブランチは `main` `master` `develop` `development` `staging` `release` `production` `prod` `trunk` と、それぞれの `<名前>/*` です (例: `release/1.0`)。名前は `hooks/git-destructive-blocker.py` の保護リストと同じです。
- `<名前>/*` は、元のフックが push の削除判定で使っている前方一致に合わせたものです。コミットについて元のフックは完全一致だけを見ていたので、コミットの判定は元より少し広くなっています。
- ブロック時の標準エラー出力には、止めた内容・理由・対処 (作業ブランチを作って PR 経由で取り込む) を日本語で出します。
- ガード自身が想定外のエラーを起こしたとき (git の呼び出し失敗など) は、警告を標準エラーに出して許可します。誤って止めることはありません。

### 保護ブランチの変更 (リポジトリごと)

```text
git config claudeguard.protectedBranches "main release/*"   # 空白区切りの glob。既定の一覧を置き換える
git config claudeguard.protectedBranches ""                 # 保護を無効にする
git config --unset claudeguard.protectedBranches            # 既定に戻す
```

## 競合の扱いと終了コード

導入先に先客がいるときは、決して上書きも迂回もせず、止めて知らせます。

| 状況 | 動作 |
|---|---|
| 置き先が無い | 導入します |
| 置き先があり、中身がバイト単位で同じ (実行権限あり) | 何もしません |
| 置き先に私たちの印があり、中身または実行権限が違う | 更新します (新版への入れ替え、実行権限の復元) |
| 置き先に印が無い (他のフック)、シンボリックリンク、`hooks/` 自体がリンク | 触りません。`--force` を付けても同じです。警告を出し、競合に数えます |
| `core.hooksPath` が設定されている (リポジトリ内でもグローバルでも。husky など) | 導入しません。値と「git ネイティブのガードはこのリポジトリで有効ではない」ことを警告し、競合に数えます |
| 書き込めない (読み取り専用のディレクトリなど) | その項目を競合に数え、ほかの項目は続けます。トレースバックは出しません |
| git リポジトリの外 | 案内を 1 行出して飛ばします。失敗ではありません |

- 印は、スクリプトの 2 行目 `# claude-engineering:guard v1` (先頭が `# claude-engineering:guard`) です。
- 競合があっても、ほかの処理 (`.claude/` へのコピーなど) は最後まで適用します。そのあと標準エラーの末尾に `CONFLICT:` から始まる要約を出し、終了コード 3 (`EXIT_CONFLICT`) を返します。
- 終了コード 3 は、これまで「計画に競合があり、何も書き込まなかった」を表していました。git フックの競合では「ほかは適用済みで、git フックだけが未導入または一部未導入」を意味します。要約の文面で区別してください。
- `--dry-run` は、導入・更新・スキップの予定を表示するだけで、何も書きません。実行時と同じ終了コードを返します。
- `--no-git-hooks` を `install` / `update` に付けると、この手順だけを飛ばします (`uninstall` と `verify` でも、git フックを対象から外します)。
- `uninstall` は、印のあるファイルだけを消します。他のフック、シンボリックリンク、3 つ以外の名前のファイルには触りません。`core.hooksPath` が設定されていても、印のあるファイルは消します。
- `verify` は、3 つのフックの状態を `OK: 件数` と、`MODIFIED` / `MISSING` / `FOREIGN` (該当があるときだけ。件数と項目の箇条書き) で出します。1 つでも `OK` でなければ終了コード 1 です。git リポジトリの外は `info:` を出すだけで、失敗にしません。`core.hooksPath` が導入後に設定された場合も終了コードは 0 のままですが、「git ネイティブのガードはこのリポジトリで有効ではない」と明記した `WARNING:` 行を出します。

## リポジトリごとの無効化

- 保護を外す: 人間が端末で `git config claudeguard.protectedBranches ""` を実行します。
- フックごと外す: 3 つのファイルを削除します。以後の `install.py update` は再び導入するので、`update` と `verify` には `--no-git-hooks` を付けてください。

## 止まる経路 / 止まらない経路

`CLAUDECODE=1`、保護ブランチ (main) 上での結果です。`tests/test_git_hooks.py` が、この環境の git 2.50.1 で実測して固定しています。「止まらない」の行は例であり、網羅的ではありません (下の「限界」も参照)。

| 操作 | 結果 | 理由 |
|---|---|---|
| `git commit` | 止まる | `pre-commit` |
| `git commit --amend` | 止まる | `pre-commit` |
| `git merge` (fast-forward にならない。`--no-ff` を含む) | 止まる | `pre-merge-commit` |
| `git merge` (fast-forward) | 止まらない | コミットを作らないのでフックが走らない |
| `git merge --squash` のあとの `git commit` | commit で止まる | `pre-commit` (squash 自体は止まらない) |
| マージ競合を解決したあとの `git commit` | 止まる | `pre-commit` |
| `git cherry-pick` | 止まらない | 対応するフックが走らない |
| `git revert` | 止まらない | 同上 |
| `git rebase` (保護ブランチ上。コミットの再適用を含む) | 止まらない | 最後のブランチ更新でフックが走らない |
| `git reset --hard` / `git branch -f` / `git branch -M` / `git update-ref` | 止まらない | ref を直接動かすのでフックが走らない |
| `git checkout -B main <commit>` / `git switch -C main <commit>` | 止まらない | 同上 |
| `git am` | 止まらない | `pre-commit` を実行せず、コミットを内部で作る |
| `git pull` (fast-forward、`--rebase` とも) | 止まらない | fast-forward のマージと rebase に分解され、どちらもフックが走らない |
| `git fetch origin <ブランチ>:main` | 止まらない | fetch が ref を直接更新する (main をチェックアウトしていないとき) |
| `git filter-branch` | 止まらない | ref を書き換えるだけでフックが走らない |
| `git send-pack` で保護ブランチへ | 止まらない | `git push` の経路を通らないので `pre-push` が走らない |
| `git push` で保護ブランチへ (通常・`--force`・`--force-with-lease`・`HEAD:main`・`:main`・`--delete`) | 止まる | `pre-push` |
| `git push` で他のブランチ・タグへ (force と削除も) | 通る | 対象外 |
| 保護ブランチ以外でのコミット・マージ | 通る | 対象外 |
| detached HEAD でのコミット・マージ | 通る | 対象外 (`pre-commit` / `pre-merge-commit` とも) |
| `main` と同名のタグがあるときの main 上のコミット | 止まる | ブランチは完全な ref 名 (`refs/heads/main`) で判定する |
| 空のリポジトリの最初のコミット | 通る | HEAD がまだ無いので判定しない。2 つ目から止まる |
| `CLAUDECODE` が未設定、または `1` 以外 | 通る | 人間の操作は対象外 |

## 限界 (このガードが守らないもの)

- `core.hooksPath` (リポジトリ内でもグローバルでも。husky など) を設定していると、git は `.git/hooks` を読みません。そのため installer は導入せず、警告して終了コード 3 を返します。
- 他のフックが同じ名前で既にあるときも、上書きせず終了コード 3 を返します。自動では組み込みません。人間が手で組み込む場合は、ガードを呼ぶときのファイル名が `pre-commit` などのフック名になるようにしてください (例: ガードの複製を `pre-push` という名前で別のディレクトリに置き、既存のフックから呼ぶ)。`pre-push` では標準入力もそのまま渡してください。スクリプトは自分のファイル名でフックの種類を判断するので、`guard.sh` という名前のまま呼んでも何もしません (この組み込み方は手元で実測しました)。
- pre-commit フレームワーク (`pre-commit install`) は、`.git/hooks` に自前のスクリプトを置きます。`core.hooksPath` を設定している場合は、フレームワーク側が導入を断る仕様です。本ガードとの共存は、この環境に無いため実測していません (未検証)。
- フックを走らせない ref 更新は止められません。上の表の行は例であり、網羅的ではありません。表にない操作 (実測していないもの) にも、同じ理由で止まらないものがあるはずです。
- git を通らない操作はすべて対象外です。GitHub の Web 画面、`gh api`、GitHub の MCP や API による push・マージ・ブランチ更新は、このガードを経由しません。
- モノレポなど 1 つのリポジトリに複数のプロジェクトを導入した場合、フック用ディレクトリは 1 つを共有します。あるプロジェクトで `uninstall` すると、同じリポジトリの他のプロジェクトのガードも消えます。
- 他のツール (フレームワークなど) がフックを `.legacy` や `.old` などの別名に退避すると、元の名前には別のファイルが置かれ、ガードは働かなくなります。`install.py update` はそのファイルを他のフックとして扱い (競合、終了コード 3)、`verify` は `FOREIGN` と報告します。
- 次の方法はフックそのものを回避します。Claude 側の PreToolUse フック (`hooks/git-destructive-blocker.py`) が、これらの文字列をコマンドから検出して止めます (ベストエフォート。ADR-028)。
  - `--no-verify`
  - `git -c core.hooksPath=…`
  - `git config core.hooksPath …`
  - 環境変数 `GIT_CONFIG_*`
  - `CLAUDECODE` の unset や書き換え
  - `.git/hooks` のファイルの編集・削除
- Edit ツールなどによる `.git/hooks` のファイルの直接編集は、git フック側では防げません。
- エージェントが `git config claudeguard.protectedBranches ""` を実行すると、保護が外れます。ブロックメッセージには、この設定の存在を載せていません。
- `CLAUDECODE=1` を設定しない AI ツールは、人間と同じ扱いで対象外です。
- git 2.31 より古い場合、`--path-format=absolute` が使えず、installer は「git リポジトリの外」と同じ扱いで飛ばします (未検証。この環境の git は 2.50.1 です)。

### 今後の拡張候補

git の `reference-transaction` フックは、保護ブランチの ref を動かす操作全般 (fast-forward のマージ、`cherry-pick`、`revert`、`rebase`、`reset --hard`、`update-ref`) で走ることを、手元の実験で確認しました。表の「止まらない」行を 1 つのフックで塞げる見込みです。今回は対象外で、テストにも含めていません。

## テスト

```text
python3 -m unittest tests.test_git_hooks tests.test_installer_git_hooks
```

どちらも一時ディレクトリの中だけで動きます。空の `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM=1`、一時の `HOME` を使い、実在のリポジトリや git 設定には触れません。
