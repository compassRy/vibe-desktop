# Vibe Desktop

Mistral Vibe（`vibe` CLI) をターミナルなしで使えるデスクトップアプリです。Claude Code みたいな感覚で、チャット画面から Vibe に指示できます。

Electron 製の GUI が、Vibe 公式の `vibe-app-server` と JSON-RPC (stdio, 1行1メッセージ) で直接通信します。ターミナルの TUI をパースしないので、ツール実行・承認・セッション履歴まですべて正規のプロトコルで動きます。

## スクリーンショット

`screenshot.png` を参照（配布フォルダに同梱)。

## 使い方

### 起動

```bat
start.bat
```

またはビルド済みのポータブル版:

```
dist\Vibe Desktop 0.1.0.exe
```

初回は `start.bat` が自動で `npm install` します。

### 要件

- `vibe` CLI がインストール済みで、API キー設定済みであること
  - `vibe-app-server` は `~/.local/bin/vibe-app-server.exe` 等から自動検出します（`VIBE_APP_SERVER_BIN` 環境変数で上書き可)
  - API キーが未設定の場合、アプリ上部に `vibe --setup` の案内が出ます
- Node.js（開発時のみ。ビルド済み exe は不要)

### 基本操作

- 左サイドバー: プロジェクト（フォルダ) 一覧 → 「＋ フォルダを開く」で追加
- セッション一覧から過去のスレッドを開く («続き» はそのフォルダの最新セッションを再開、`vibe -c` と同じ semantics)
- 「新規」で新しいチャット
- ヘッダーのドロップダウンで **モデル切替**（セッションに即反映＆デフォルトとして保存) と **思考レベル** を変更
- エージェント（Ask / Accept Edits / Smart Approve / Auto Approve) の切替と自動承認（YOLO）
- 入力欄: `Enter` で送信、`Shift+Enter` で改行、`@` でプロジェクト内ファイル補完、画像貼り付け可
- ツール実行のうち承認が必要なものはチャット内に承認カードが出るので、「許可 / このセッションで許可 / 常に許可 / 拒否」を選択
- 実行中はヘッダーの「割り込み」で中断
- **完了通知**: 回答が終わると Windows のトースト通知が出ます（クリックでアプリにフォーカス)。サイドバーの「通知」で オン/オフ切替可
  - **音**: 「音を鳴らす」のオン/オフと、音声の種類を選択可能（システム標準 / `notify.wav` / `chimes.wav` / `ding.wav` / `chord.wav` / カスタム音声ファイル）
- **使用量の表示**: ヘッダーに「使用量 xx%」（今月の使用量と残り、リセット日をツールチップで表示) と「ctx 9.5k/800k」のコンテキスト量をミニバー付きで表示（75%で黄、90%で赤)

### ローカルファイルの編集

セッションの cwd（開いたフォルダ) 配下のファイルはそのまま読み書きできます（`read_file` / `write_file` / `edit` / `bash` 等)。Accept Edits エージェントならファイル編集は自動承認、それ以外（シェル等) は承認カードで確認します。

## 自動化インターフェース（エージェントからGUIを操作)

アプリ起動中は 127.0.0.1 限定の HTTP サーバーが立ち、ポートとトークンが `%APPDATA%\vibe-desktop\automation.json` に書き出されます。

| エンドポイント | 内容 |
|---|---|
| `GET /health?token=…` | 生存確認 |
| `GET /state?token=…` | UI の状態を JSON で取得 |
| `POST /eval {"js": "…"}` | レンダラー内で JS を実行（クリック・入力・送信など) |
| `GET /screenshot?token=…` | ウィンドウを PNG(base64) で取得 |

CLI からの例:

```bash
node tools/gui.js health
node tools/gui.js state
node tools/gui.js eval "document.querySelector('#btn-new-chat').click()"
node tools/gui.js eval @myscript.js
node tools/gui.js screenshot out.png
```

## 開発

```bash
npm install
npm start          # 開発起動
npm run smoke      # 実機スモークテスト（サーバー接続〜送信〜承認〜描画まで自動検証)
npm run dist       # dist\Vibe Desktop 0.1.0.exe をビルド
node tools/make-icon.js   # assets/icon.png と icon.ico を生成（ビルド前に一度実行)
```

## 構成

```
vibe-desktop/
├── main.js                  # Electron メイン: vibe-app-server の起動・JSON-RPC・IPC・自動化サーバー
├── preload.js               # contextBridge
├── src/
│   ├── server-client.js     # vibe-app-server との newline-JSON-RPC クライアント
│   └── automation.js        # 127.0.0.1 + token の自動化 HTTP サーバー
├── renderer/
│   ├── index.html           # 画面構造
│   ├── styles.css           # ダーク/ライトのデザインシステム
│   ├── app.js               # チャット描画・入力・承認UI・モデル切替
│   └── vendor/marked.umd.js # Markdown レンダラ
├── tools/                   # gui.js（自動化CLI)、make-icon.js など
└── start.bat                # 起動スクリプト
```

## プロトコルメモ（自分で拡張したい人向け）

- ハンドシェイク: `initialize` → 通知 `initialized`（params 空オブジェクト必須）
- セッション: `session/start`（`agentConfig.cwd` で作業フォルダ指定、`trustWorkspace: true`)、`session/resume`、`session/continue`、`session/list`、`session/read`
- 送信: `turn/start { sessionId, message: [{type:"text",text}] }`、中断は `turn/interrupt`
- イベント: `session/snapshot`、`history/entryAdded/Updated`、`session/updated`、`turn/started/completed` などが通知で流れる。接続は一度に1セッションにしかライブ配信されないため、他セッションは `events/read {afterEventId}` でポーリングして同期
- 承認: サーバーから要求 `callback/call` → `{callbackId, accepted:true}` で応答しつつ、`callback/result {sessionId, result:{callbackId, output:{type:"approval", decision:{type:"approve"}}}}` で決定を返す
- モデル: 一覧は `runtime/read` の `runtime.config.models`、変更は `config/model/write {sessionId, modelAlias, reasoningEffort}`

## ライセンス

MIT
