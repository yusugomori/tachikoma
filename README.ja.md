# Tachikoma

[English](README.md)

![Tachikoma live terminal demo: three Claude agents and three Codex agents split one weather request across a six-pane tmux session](https://raw.githubusercontent.com/yusugomori/tachikoma/main/assets/tachikoma-multi-agent-weather-demo.gif)

Tachikoma は、同じリポジトリで並行して動く named coding agent のための realtime agent workspace です。

`loki`、`musashi`、`triton`、`tomoe` のように、いくつかの session に名前を付けて起動します。Codex、Claude、その他の supported runtime のどれで動いていても構いません。Tachikoma にとって runtime はどう届けるかという実装上の詳細にすぎず、shared workspace は named live agent を中心に動きます。各 agent は別の TUI から呼ばれ、同じ thread で reply し、複数の会話を同時に動かせます。

その workspace には session の外側からも入れます。terminal の command から任意の named agent に指示を送ると、agent が live なら directive はその TUI に届きます。まだ起動していなければ、その名前の inbox に作業として残ります。人、script、外部 tool が、どれか1つの会話に入っていなくても同じ workspace に作業を送り込めます。

Tachikoma は単なる CLI wrapper でも、memory file でもありません。すでに起動している複数の agent session が realtime に呼び合い、その裏で永続的な project の事実を記録する multi-agent workspace です。

Tachikoma の中心はチャット履歴ではなく、永続的な project の調整です。message は別の agent へ注意を移すために使えますが、長く信頼すべき事実は、タスク、アサイン、実装 claim、レビュー指摘、検証結果、意思決定、handoff、report として記録します。

## Tachikoma がやること

- 1つのリポジトリで作業する coding agent のための local-first な調整レイヤー。
- runtime に依存せず、名前付き TUI session 間で realtime に message を届ける path。
- live agent の間で並行して進む複数の open conversation thread。
- session の外側から agent workspace に指示を送り、runtime session の起動や TUI attach を行う CLI control plane。
- リポジトリ単位の、構造化された project state。
- 起動中または後から起動する agent session に向けた名前付き routing。
- TUI 内から primary coordination、optional relay、sync、boot、stale inbox cleanup を行う Codex/Claude の生成 skill。
- Codex app-server worker と Claude hooks / Monitor による realtime TUI-to-TUI delivery。
- CLI、MCP、hook、report の背後にある共通の command/event layer。
- handoff、review、verification の状態を明示する仕組み。

## Tachikoma がやらないこと

- cloud coordination service ではありません。
- Codex、Claude、その他の agent runtime そのものを置き換えるものではありません。
- 汎用 chat app ではありません。
- raw transcript recorder ではありません。
- MCP-first architecture ではありません。MCP は local service/store contract の adapter の1つです。
- 状態を Markdown の中に隠す report generator ではありません。

## 機能

Tachikoma には、local CLI、SQLite-backed event store、projection、MCP server、named session、directed conversation、realtime delivery、structured review record、verification record、report generation が含まれます。

設計の中心は、明示的な command と inspectable な state です。message は agent 間で注意を移し、後続 session が信頼すべき事実は structured record として残します。

## 前提条件

- Node.js 22 以降。
- source checkout は pnpm、global install script は npm を使用。
- live な agent session 用に Codex CLI または Claude Code。

## 5分 quickstart

source checkout で開発する場合:

```bash
pnpm install
pnpm build
pnpm tachikoma init
pnpm tachikoma status
```

GitHub から CLI を global install します（npm レジストリのアカウント不要）。

```bash
curl -fsSL https://raw.githubusercontent.com/yusugomori/tachikoma/main/install.sh | sh
tachikoma init
tachikoma status
```

installer は最新の GitHub release から build 済み tarball を取得し、`npm install -g` します。そのため `node`・`npm` だけあればよく、build 環境は不要です。`TACHIKOMA_VERSION`（例: `TACHIKOMA_VERSION=v0.2.0`）で特定 release を固定でき、`TACHIKOMA_PACKAGE` に npm 名・git spec・tarball を渡せば install 元を上書きできます。

`init` は project state に加えて、local agent integration も入れます。`.tachikoma/project.toml`、`.tachikoma/agent-instructions.md`、managed `.gitignore` block、生成 skill、`.mcp.json`、Codex/Claude の host hook activation file が対象です。初期化後は Codex または Claude を再起動し、プロンプトが出たら **project を trust し hook を承認**してから（Codex では必須。「Codex の project trust と hook approval」を参照）`/mcp` を確認します。Codex CLI の session によっては repository-local な `.mcp.json` だけでは読み込まれないため、`/mcp` に `tachikoma` が出ない場合は下の `codex mcp add` で登録してから Codex を再起動します。

生成 skill と CLI は補完関係です。skill は live agent が自分の TUI の中から会話するための in-workspace control です。CLI は外側の control plane で、integration setup、runtime session の起動や attach、同じ workspace への指示投入を行います。prefix は入力している TUI を表すだけで、送信先 agent の種類を表すものではありません。

| Runtime | Skills |
| --- | --- |
| Codex | `$tachikoma`, `$tachikoma-relay`, `$tachikoma-sync`, `$tachikoma-boot`, `$tachikoma-dismiss` |
| Claude | `/tachikoma`, `/tachikoma-relay`, `/tachikoma-sync`, `/tachikoma-boot`, `/tachikoma-dismiss` |

`$tachikoma` と `/tachikoma` が TUI 内の primary control です。named agent への送信、thread への reply、delivery された work の sync、structured state の記録に使います。relay は、作業実行や structured state の記録をせずに send/reply だけしたい時の optional shortcut です。boot は明示的な manual join に、dismiss は stale inbox cleanup に使います。session の外側から作業を送る・state を inspect する・runtime を起動するといった操作には CLI を使います。

各 runtime entry には、他の agent や user が依頼先を指定できるように名前を付けます。realtime TUI session は必要に応じて別 terminal または host session で動かします。

```bash
tachikoma claude
tachikoma codex
```

どちらの runtime 起動 command も、起動情報の前に小さな Tachikoma banner を表示します。
TTY では色付きで、`NO_COLOR` に従い、`FORCE_COLOR=1` で強制できます。

`tachikoma codex` は Codex app-server worker を起動または再利用し、その worker に attach した Codex TUI を開き、TUI attach 中に delivery loop も動かします。
TUI なしの worker として待機したい場合は `tachikoma codex --watch` を使います。より低レベルに制御したい場合は `codex start`、`codex attach`、`codex deliver`、`codex stop` subcommand を使います。

`tachikoma claude` は named Tachikoma session に join し、Tachikoma identity を hook 環境に入れた Claude TUI を開き、`--no-auto-boot` がない限り Claude 起動 trigger として裸の `/tachikoma-boot` を自動投入します。agent name と role は boot prompt ではなく `tachikoma claude --name ... --role ...` から決まります。`tachikoma claude` で起動していない既存の Claude TUI では、`/tachikoma` を使う前に `/tachikoma-boot <name>` で明示的に manual join します。Claude Monitor は `tachikoma hook monitor --name <name> --watch` で realtime delivery を監視します。

live TUI の中では、生成 skill から他の named agent をその場で work に呼び込めます。

```text
# Codex TUI から任意の named agent へ
$tachikoma Send musashi: "Implement the current task and report blockers."
$tachikoma Send triton: "Verify the fix in parallel."
$tachikoma-sync

# Claude TUI から任意の named agent へ
/tachikoma Send tomoe: "Take the docs side of this."
/tachikoma Send loki: "Please review my latest claim."
/tachikoma-sync
```

send/reply だけの narrow shortcut が必要な場合は、`$tachikoma-relay` または `/tachikoma-relay` を使います。

Tachikoma は各 message を agent name で routing します。Codex app-server delivery と Claude host hooks / Monitor は、directive を live TUI に入れるための transport です。agent が thread に reply すると、Tachikoma は follow-up を他の participant に送り返します。これは route matrix ではなく、人が `tachikoma inbox` を手動で確認しなくても、名前付き agent 群が複数の会話を動かし続ける仕組みです。

どの TUI の外側からでも、CLI で同じ workspace に work を投げ込めます。

```bash
tachikoma ask musashi "Implement the current task and report blockers."
tachikoma ask triton "Verify the fix in parallel."
tachikoma thread list
tachikoma inbox --as musashi
tachikoma memory
```

target agent が live delivery path に attach されていれば、指示はその TUI に表示されます。offline の場合は、その named endpoint の pending work として残ります。CLI は `tachikoma codex start`、`tachikoma codex attach`、`tachikoma codex deliver`、`tachikoma claude` のような runtime delivery path も制御します。

同じ role の agent が複数いる場合は、role ではなく名前で送ります。Tachikoma は複数候補から勝手に選ぶべきではありません。

## 現在の session に名前を付ける

Agent name は project-local な routing handle です。global identity ではありません。
Role は optional な project-local routing label です。role 宛ての Tachikoma routing には効きますが、Codex TUI や Claude TUI の振る舞いを切り替えるものではありません。

よくある例:

- `loki`: Codex の reviewer session。
- `musashi`: Claude の implementer session。
- `triton`: Codex の QA / verification session。

通常は runtime command を使います。

```bash
tachikoma codex --name loki --role reviewer
tachikoma claude --name musashi --role implementer
```

Codex TUI を開かず headless worker として待機したい場合は `tachikoma codex --watch --name loki` を使います。

`join` はこれらの背後にある低レベル primitive として残ります。MCP 接続済みの agent session 内から低レベルに扱いたい場合は、同じ name、runtime、任意の role で `tachikoma_session_join` を呼びます。

その名前に pending inbox work がある場合、session join 時に claim できます。後から起動した session も同じ named endpoint に join して、Tachikoma state から pending work を復元できます。

## Codex と Claude の integration setup

source checkout を使う場合は、まず local CLI を build します。

```bash
pnpm build
```

標準の local setup は次の command です。

```bash
pnpm tachikoma init
```

これは local integration file を default で書きます。MCP と skill は入れたいが automatic hook delivery は避けたい場合だけ、`--no-host-hooks` を使います。

setup command の挙動は次の通りです。

| Command | 挙動 |
| --- | --- |
| `tachikoma init` | event store を作成または開き、local repository integration を入れます。 |
| `tachikoma init --store-only` | event store だけを作成または開き、repository integration file は書きません。 |
| `tachikoma init --dry-run` | store 作成も file 書き込みもせず、init と bootstrap の plan だけを表示します。 |
| `tachikoma install` | event store を作らず、repository integration だけを再適用します。tracked integration file が変わる場合は、書き込み前に失敗します。 |
| `tachikoma install --dry-run` | file を書かず、blocked tracked write でも失敗せずに repository integration plan を表示します。 |
| `tachikoma install --skills` | project identity、`.gitignore`、host hooks、MCP config を書き換えず、生成 Tachikoma skill だけを再生成します。 |
| `tachikoma reset --dry-run` | local Tachikoma state の破壊的な reset を、file を消さず store も作り直さずに preview します。 |
| `tachikoma reset --force` | local event store と runtime binding state を削除し、空の initialized store を作り直します。repository integration file（`project.toml`、`AGENTS.md`、`CLAUDE.md`、`.mcp.json`、skill、hook）はそのまま残します。 |

よく使う setup option:

| Option | 対象 command | 挙動 |
| --- | --- | --- |
| `--runtime codex` / `--runtime claude` | `tachikoma init`, `tachikoma install` | runtime-specific な生成 skill と host hook を指定 runtime に限定します。 |
| `--all` | `tachikoma init`, `tachikoma install` | supported runtime すべての runtime-specific integration を入れます。 |
| `--no-host-hooks` | `tachikoma init`, `tachikoma install` | `.codex/hooks.json` と `.claude/settings.local.json` を skip します。 |
| `--no-codex-trust` | `tachikoma init`, `tachikoma install` | user-global な Codex `config.toml` への project trust 登録を skip します。 |
| `--no-mcp` | `tachikoma init`, `tachikoma install` | `.mcp.json` を skip します。 |
| `--force` | `tachikoma init`, `tachikoma install` | tracked な Tachikoma integration file への書き込みを許可します。 |

global option の `--store <path>` は event store の場所を指定するだけです。repository integration は skip しません。repository に何も書きたくない場合は `init --store-only` を使います。

global install 済みの CLI では、同じ setup を `pnpm` なしで実行します。

```bash
tachikoma init
tachikoma install --dry-run
```

non-destructive な repository integration plan は次の command で確認または再適用できます。

```bash
pnpm tachikoma install --dry-run
```

### Codex の project trust と hook approval（必須）

Codex は project-local な config・hooks・exec policy を、**2 段階の承認**で gate します。両方が揃うまで `.codex/hooks.json` は **実行されず**、launcher identity が skill context に届かないため、`tachikoma codex` の session が *「launcher identity is not visible in this skill context」* を報告します。

1. **Project trust** — Codex は *trusted* な directory でのみ project-local hook を実行します。trust は完全一致の path 単位で、親が trusted でも subdirectory には継承されません。`tachikoma init` / `tachikoma install` は、user-global な Codex config（`~/.codex/config.toml`、または `$CODEX_HOME/config.toml`）に次を追記して、これを自動登録します。

   ```toml
   [projects."/absolute/path/to/your/project"]
   trust_level = "trusted"
   ```

   skip したい場合は `--no-codex-trust` を渡します。`tachikoma doctor` で確認できます（`codex trust: ok`）。

2. **Hook approval** — trust 後に初めて Codex TUI で project を開くと、Codex が *「Hooks need review — N hooks are new or changed」* を表示します。これは `.codex/hooks.json` に定義された 4 つの Tachikoma delivery hook（`SessionStart`・`UserPromptSubmit`・`PostToolUse`・`Stop`）です。**「Trust all and continue」** を選びます（先に review してもOK）。この承認は意図的に interactive で `tachikoma init` から自動化できず、hook の内容が変わったときだけ再表示されます。

*「Continue without trusting」* を選ぶと hook は無効のままで、identity binding error が解消しません。

Codex では、`.mcp.json` が生成済みでも user-level な MCP 登録が必要な場合があります。`/mcp` に `tachikoma` が出ない場合だけ手動登録します。`TACHIKOMA_CWD` は Tachikoma の install 先ではなく、Tachikoma state を読む対象 project repository を指します。

global install 済み CLI では、Codex を次のように登録します。

```bash
PROJECT=/path/to/your/project
codex mcp add \
  --env TACHIKOMA_CWD="$PROJECT" \
  tachikoma \
  -- tachikoma mcp
```

Claude Code も同様です。

```bash
PROJECT=/path/to/your/project
claude mcp add tachikoma \
  --scope local \
  -e TACHIKOMA_CWD="$PROJECT" \
  -- tachikoma mcp
```

Tachikoma source checkout で開発している場合だけ、`tachikoma mcp` を `pnpm --dir "$TACHIKOMA_CHECKOUT" tachikoma mcp` に置き換えます。`TACHIKOMA_CWD` は引き続き対象 project repository を指します。

登録後、Codex または Claude を再起動して、agent session 内で `/mcp` を確認します。`tachikoma` が MCP server として見えるはずです。

登録されているかは、再起動前に次の command でも確認できます。

```bash
codex mcp list
claude mcp list
```

## よくある review loop

典型的には Claude に実装を依頼し、Codex に review を依頼します。

```bash
pnpm tachikoma codex --name loki --role reviewer
pnpm tachikoma claude --name musashi --role implementer
pnpm tachikoma ask musashi "Implement the open review findings."
```

実装後は、結果を chat にだけ残さず structured state として記録します。

```bash
pnpm tachikoma claim record \
  --summary "Implemented requested changes" \
  --expect "pnpm test" \
  --request-review \
  --reviewer loki

pnpm tachikoma review finding \
  --summary "Missing cleanup path" \
  --to musashi

pnpm tachikoma verification record \
  --status passed \
  --summary "pnpm test passed" \
  --command "pnpm test"
```

conversation thread には message が流れます。一方で、claim、finding、verification record が事実として扱われます。

## Claude monitor delivery check

Claude Monitor delivery だけを集中して確認するため、この例では2つの named Claude runtime を使います。一般形はあくまで任意の named agent から任意の named agent への routing です。integration を初期化し、Claude Code を再起動して hooks を review/trust してから、session を起動します。

```bash
pnpm tachikoma init --force
pnpm tachikoma claude --name max --role reviewer
pnpm tachikoma claude --name musashi --role implementer
# from max
/tachikoma Send musashi: "ping"
```

すでに `tachikoma claude` 以外で起動した Claude TUI の中にいる場合は、`/tachikoma` または optional な `/tachikoma-relay` shortcut を使う前に `/tachikoma-boot <name>` で明示的に manual join します。

期待する挙動は、`musashi` が Claude TUI 内で Monitor delivery 経由の ping を受け取り、人が `tachikoma inbox` を実行しなくても reply または structured state の記録を行うことです。

Monitor delivery が使えない場合の fallback command:

```bash
pnpm tachikoma hook monitor --name musashi --watch
pnpm tachikoma hook receive --runtime claude --name musashi --format text --event UserPromptSubmit
pnpm tachikoma inbox --as musashi
```

届かない場合は `pnpm tachikoma doctor` を使います。TUI または monitor command が動き続けているか、session が存在するか、Claude hook trust が承認済みか、agent name が別の live session に取られていないか、使っている経路を delivery mode が support しているかを確認します。

## Codex app-server diagnostics

通常の Codex realtime delivery は `tachikoma codex` を使います。app-server probe は local Codex install を分類するための diagnostic command です。

```bash
pnpm tachikoma codex probe \
  --app-server-stdio \
  --cwd "$PWD" \
  --agent loki \
  --message "Tachikoma remote-control probe. Reply with exactly: PONG" \
  --wait-ms 120000
```

probe は Tachikoma message を delivered 扱いにはしません。

## Reports と handoffs

Report と handoff は event log の projection から再生成されます。読みやすい artifact ですが、source of truth ではありません。

```bash
pnpm tachikoma report export .tachikoma/reports/project.md --format markdown
pnpm tachikoma report export .tachikoma/reports/project.json --format json
pnpm tachikoma report handoff .tachikoma/reports/handoff.md --summary "Ready for review"
```

状態を短く共有したいときは report を使います。別の agent や未来の session が特定地点から続行する必要があるときは handoff を使います。

## リファレンス

コマンド全体と各コマンドの option は、組み込みの help で確認します。

```bash
pnpm tachikoma --help
pnpm tachikoma <command> --help
```

`tachikoma init` は `.tachikoma/agent-instructions.md` も生成します——coordination 中に agent が読む、リポジトリ内の guidance file です。

## Uninstall

`tachikoma uninstall` は `init` がリポジトリに書き込んだものを元に戻します。`.tachikoma/`（state・store・project config）、生成された `.claude` / `.codex` の skill、Tachikoma の host-hook と MCP エントリ、`.gitignore` / `AGENTS.md` / `CLAUDE.md` の managed block、そして user-global な Codex `config.toml` 内の当該 project の trust エントリを削除します。編集は外科的で、他の hook・MCP server・他の trusted project・あなた自身の instructions は残し、空になった `.claude` / `.codex` ディレクトリだけ削除します。

```bash
tachikoma uninstall --dry-run   # 何も変更せず、対象をすべて preview
tachikoma uninstall --force     # 実際に削除を適用
```

uninstall が触るのはリポジトリ内の integration だけです。グローバルの CLI は `npm rm -g @yusugomori/tachikoma` で別途削除してください。リポジトリ外に移動した store（`--data-root` や `TACHIKOMA_HOME`）は、削除せず場所だけ報告します。

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

便利な local command:

```bash
pnpm tachikoma --help
pnpm tachikoma doctor
pnpm tachikoma memory
```

## Local-first safety notes

- core state は local かつ repository-scoped です。
- default store は `.tachikoma/state` 配下の local SQLite です。`--data-root`、`--store`、`TACHIKOMA_HOME` で移動できます。
- event log が canonical です。projection は rebuild 可能です。
- bootstrap は default で non-destructive であるべきです。
- raw transcript は default では ingest しません。
- Tachikoma は Codex / Claude の wrapper runtime を起動できますが、host tool の UI/process behavior は host 側が持ちます。attached TUI session は host UI で終了し、Tachikoma が起動した Codex app-server worker は `tachikoma codex stop` で停止します。
