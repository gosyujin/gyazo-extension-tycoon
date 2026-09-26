# gyazo-extension-tycoon

ブラウザの画面キャプチャ用 Chrome Extension の仕様検討・実装プロジェクト。

## 開発の進め方

- Claude(このリポジトリで作業するAIアシスタント)は作業開始前に必ずこの README を読むこと。
- チャット内で決めた実装方針や仕様変更の経緯は、実装完了時にこの README(主に「実装ログ / 意思決定の経緯」セクション)に書き残し、push すること。
- Claude 向けの作業指示・注意点は [CLAUDE.md](CLAUDE.md) にまとめる。

## 概要

Chrome Extension (Manifest V3) として、ブラウザの画面を PNG / GIF でキャプチャする。ビルドツールは使わず、プレーンな JS/HTML/CSS のみで構成している(npm はライブラリ取得にのみ使用)。

## 現在実装済みの機能(最低限セット)

- **PNG**
  - 矩形選択で選んだ範囲を保存
  - HTML 要素(クリックした要素の `getBoundingClientRect()` 範囲)を保存
  - 表示中のビューポートをそのまま保存
  - ページ全体(スクロールしながら分割撮影して結合)を保存
- **GIF(パラパラ漫画)**
  - ツールバーの popup から「録画開始」→ 好きなタイミングで「停止」すると GIF としてダウンロードされる
- **保存**
  - すべて `chrome.downloads.download` でダウンロードフォルダ配下 `GyazoExtensionTycoon/` に保存

Gyazo / Imgur へのアップロードは未実装(将来の拡張ポイント。下記「今後の拡張」参照)。

## アーキテクチャ

| コンポーネント | 役割 |
|---|---|
| [background/service-worker.js](background/service-worker.js) | 全体のオーケストレーター。popup / content script / offscreen document 間のメッセージ中継、`chrome.tabs.captureVisibleTab` / `chrome.scripting` / `chrome.tabCapture` / `chrome.offscreen` の呼び出しを一元管理。Blob や canvas は一切扱わない。 |
| [content/content-script.js](content/content-script.js) | ページ内に注入され、矩形選択・要素選択のオーバーレイ UI と、フルページ/大きい要素向けの「スクロールしながら分割撮影」ループを担当。 |
| [offscreen/offscreen.js](offscreen/offscreen.js) | Canvas によるトリミング/タイル結合、`MediaStream` を使った GIF 用フレームサンプリング、GIF エンコード、`chrome.downloads.download` の呼び出しを担当。 |
| [popup/popup.html](popup/popup.html) / [popup.js](popup/popup.js) | ツールバーのボタン UI。 |
| [vendor/gifenc](vendor/gifenc) | GIF エンコード用に [gifenc](https://github.com/mattdesl/gifenc)(MIT License)の配布用 ESM バンドルをそのまま同梱。ビルド不要で `import` できるため採用。 |

Manifest V3 のサービスワーカーは DOM を持たないため、Canvas / `MediaStream` / `URL.createObjectURL` / GIF エンコードなど DOM 依存の処理はすべて [`chrome.offscreen`](offscreen/offscreen.js) 内に閉じ込めている。

### GIF 実装方針についての経緯

当初案として「`chrome.tabs.captureVisibleTab` を連続呼び出しして静止画列から GIF を作る」方式も検討したが、同 API には呼び出しレート制限があり実質 2fps 程度が上限になるため、`chrome.tabCapture` + `getUserMedia` で取得したタブのライブ `MediaStream` を offscreen document 内の `<video>` に流し込み、一定間隔(`GIF_FRAME_INTERVAL_MS`)でフレームを直接サンプリングして [gifenc](vendor/gifenc/gifenc.esm.js) にストリーミングでエンコードする方式を採用した。

`MediaRecorder` で録画してから WebM を後処理で読み直す方式も検討したが、Chrome が生成する WebM は `duration` が正しく書き込まれないことがあり、シークが不安定になる既知の問題があるため避けた。ライブストリームから直接サンプリングする方式はその問題を回避でき、実装もシンプルになる。

## 既知の制限・今後調整が必要な暫定値

- `GIF_FRAME_INTERVAL_MS`(GIFのフレーム間隔、現在 150ms 固定)と `GIF_MAX_FRAMES`(最大フレーム数、現在 300 = 約45秒)は暴走防止のための暫定値。画質・ファイルサイズ・CPU負荷を見ながら今後調整する([offscreen/offscreen.js](offscreen/offscreen.js) 冒頭の定数)。
- フルページ/大きい要素のタイル撮影は、スクロール後に固定ディレイ(`SCROLL_SETTLE_MS` = 300ms)を待つだけの素朴な実装。`position: fixed/sticky` 要素がタイルごとに重複して写り込む、遅延読み込み画像に対応できない、といった既知の制限がある。
- アイコンは仮の単色プレースホルダー(`icons/`、`vendor` 同様に本物のデザインは未着手)。
- 拡張機能のロード・実際の操作確認は、このセッションで使えるプレビューブラウザ(サンドボックス化されており `chrome://extensions` や拡張機能の読み込みに対応していない)では検証できない。**実機の Chrome で動作確認する必要がある**(下記「セットアップ」「うまく動かないとき」参照)。

## セットアップ(開発用に読み込む)

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」でこのリポジトリのルートフォルダを選択

## うまく動かないとき(ログの見方)

矩形選択・要素選択・フルページ・GIF録画は、保存の成功/失敗を **Chrome の通知(`chrome.notifications`)** で表示する(「表示中のページを保存」も含め、保存系アクションはすべて通知が出る想定)。まず通知の文言を確認する。

より詳しいログは 3 箇所の DevTools コンソールに分かれて出力される。

| 見たいログ | 開き方 |
|---|---|
| `background/service-worker.js` (`[service-worker]` ログ) | `chrome://extensions` → このカードの「Service Worker」リンク(青字)をクリック |
| `offscreen/offscreen.js` (`[offscreen]` ログ) | `chrome://extensions` → 「詳細」→ 「ビューを検査」に出てくる `offscreen.html` を開く(録画/保存を一度も実行していないとまだ存在しない) |
| `content/content-script.js` (`[content-script]` ログ) | 実際にキャプチャ操作をしたページ自体の DevTools(F12)→ Console |

いずれも問題があれば `console.error` で赤字表示される。バグ報告してもらう際はここのログをコピーしてもらえると特定しやすい。

## 今後の拡張(未実装)

- 保存先を Gyazo / Imgur アップロードに切り替えられるようにする(現状は [background/service-worker.js](background/service-worker.js) の `downloadUrl()` がローカルダウンロードの唯一の保存先実装。保存先を複数用意する段階になったら、ここを差し替え可能な形に切り出す。抽象化を先取りして作り込むと使われない設計になりがちなので、今は意図的に作っていない)。
- GIF のフレームレート/最大時間/解像度を設定可能にする(popup からの設定 UI など)。
- ツールバーアイコンの用意。

## 実装ログ / 意思決定の経緯

<!-- 機能を実装するたびに、日付・決定事項・理由を追記していく -->

### 2026-09-26
- プロジェクトを開始。README / CLAUDE.md による運用ルールを整備。
- 最低限の機能セット(PNG: 矩形選択/要素選択/表示中ページ/フルページ、GIF: 録画→ダウンロード)を実装。
  - 画像フォーマットは PNG(無劣化・透過対応)を採用、JPEG は劣化・透過非対応のため不採用。
  - アニメーション形式は GIF を採用(互換性重視)。実装方式は `captureVisibleTab` 連投ではなく `tabCapture` のライブストリームからのフレームサンプリングを選択(理由は上記「GIF 実装方針についての経緯」を参照)。
  - 解像度は `devicePixelRatio` を考慮する方針のため、`captureVisibleTab` が返す実ピクセル解像度の画像をそのまま使い、クロップ/結合時の座標計算にも dpr を掛けて対応した。
  - GIF エンコードには自前実装ではなく [gifenc](https://github.com/mattdesl/gifenc)(MIT)を採用。ビルド不要な単一 ESM ファイルとして配布されており、このプロジェクトのビルドツールなし方針に合致するため。

### 2026-09-27
- 実機での動作確認で「表示中のページを保存」だけ成功し、矩形選択・要素選択・GIF録画はファイルが生成されない(かつログも見えない)との報告を受け、以下を修正。
  - **録画状態のバグ**: `background/service-worker.js` は MV3 サービスワーカーで、アイドルで破棄されると再起動時にトップレベルの `let` 変数がリセットされる。録画中フラグをサービスワーカー側の変数だけで持っていたため、録画中にサービスワーカーが再起動すると「録画中ではない」という誤った状態になり、以後ずっと開始/停止のトグルが噛み合わなくなるバグがあった。録画の実体を持つ offscreen document 側に `GET_RECORDING_STATE` を問い合わせて真の状態を都度確認する方式に変更した。
  - **エラーが一切表面化しない問題**: 矩形選択・要素選択・フルページはユーザー操作(content script)からの一方通行の通知(`CROP_SELECTION_READY` 等)で、失敗しても background 内で `console.error` されるだけで誰も見ていなかった。`chrome.notifications` で成功/失敗を画面に通知するようにした。
  - `offscreen/offscreen.js` の gifenc の import を静的 import から動的 import(`startRecording` 内でのみ読み込み)に変更。PNG系の機能が GIF 側の問題(あれば)に引きずられて全滅しないよう分離。
  - background/content-script/offscreen の主要な処理ステップに `console.log` を追加(DevTools での追跡用。README「うまく動かないとき」参照)。
  - クロップ/タイル結合で範囲が不正(幅・高さが0以下)な場合に無言で失敗せず、明示的にエラーを投げるようにした。
  - 仮のツールバーアイコン(単色PNG)を追加。

### 2026-09-27 (続き: 実機ログから2つの実バグを特定して修正)
- 上記の対応後、実機のDevToolsコンソールログを見せてもらい、2つの具体的なバグが判明した。
  - **バグ1: `chrome.downloads` が offscreen document では `undefined`。** 矩形選択/要素選択で `{ok:false, error:"Cannot read properties of undefined (reading 'download')"}` というエラーが返っていた。原因は [offscreen/offscreen.js](offscreen/offscreen.js) 内で直接 `chrome.downloads.download()` を呼んでいたこと。offscreen document には(意図的な制限か既知の挙動か)`chrome.downloads` が生えていない。**対応**: ダウンロードの実行自体は background 側に戻し、offscreen 側は `Blob` を `URL.createObjectURL()` で Blob URL 化して返すだけにした(`blobToObjectUrl()`)。Blob URL は同一オリジン(拡張機能)であれば offscreen document が生きている間は background からも参照できるため、この分担で成立する。GIF の自動停止時に生の `Blob` を `chrome.runtime.sendMessage` で送ろうとしていた箇所(JSONシリアライズできず壊れる)も同時に修正。
  - **バグ2: `chrome.tabs.captureVisibleTab` のレート制限に引っかかっていた。** フルページ撮影のログで `dataUrlLength: undefined` になるタイルが定期的に出ており(実測: 40タイル中14タイルが失敗)、後続の結合処理がその `undefined` を `fetch()` しようとして `Failed to fetch` になっていた。同 API は実質 2 回/秒程度までしか呼べない制限があり、当時のループ間隔(300ms待機)では超えていた。**対応**: [background/service-worker.js](background/service-worker.js) に `captureActiveTabPng()` の呼び出し間隔を最低 550ms 空けるレートリミッターを追加し、失敗時(戻り値が空)は例外にして呼び出し元に伝わるようにした。[content/content-script.js](content/content-script.js) 側でも `CAPTURE_NOW` が失敗した場合に最大4回までバックオフ再試行する `captureNowWithRetry()` を追加(background 側の対策だけでは環境によっては足りない可能性があるため二重の防御)。
  - この2つは矩形選択・要素選択・フルページ・GIF録画のすべてに共通する原因だったため、まとめて直った可能性が高い。**未検証(実機での再確認が必要)。**
- ユーザーから「修正するごとにバージョンバンプしてほしい」との要望があり、以降のルールとして [CLAUDE.md](CLAUDE.md) に明記。あわせて `manifest.json` の `version` を `0.1.0` → `0.1.1` に更新(直近のバグ修正2件分)。
