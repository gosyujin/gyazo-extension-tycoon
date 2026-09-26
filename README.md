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
- アイコン画像は未設定(`manifest.json` に `icons` 未指定。ツールバーは既定のパズルピースアイコンになる)。
- 拡張機能のロード・実際の操作確認は、このセッションで使えるプレビューブラウザ(サンドボックス化されており `chrome://extensions` や拡張機能の読み込みに対応していない)では検証できなかった。**実機の Chrome で下記手順により動作確認が必要。**

## セットアップ(開発用に読み込む)

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」でこのリポジトリのルートフォルダを選択

## 今後の拡張(未実装)

- 保存先を Gyazo / Imgur アップロードに切り替えられるようにする(現状は [offscreen/offscreen.js](offscreen/offscreen.js) の `downloadBlob()` がローカルダウンロードの唯一の保存先実装。保存先を複数用意する段階になったら、ここを差し替え可能な形に切り出す。抽象化を先取りして作り込むと使われない設計になりがちなので、今は意図的に作っていない)。
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
