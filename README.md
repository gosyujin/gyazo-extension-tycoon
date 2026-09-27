# gyazo-extension-tycoon

ブラウザの画面キャプチャ用 Chrome Extension の仕様検討・実装プロジェクト。

## 開発の進め方

- Claude(このリポジトリで作業するAIアシスタント)は作業開始前に必ずこの README を読むこと。
- チャット内で決めた実装方針や仕様変更の経緯は、実装完了時にこの README(主に「実装ログ / 意思決定の経緯」セクション)に書き残し、push すること。
- Claude 向けの作業指示・注意点は [CLAUDE.md](CLAUDE.md) にまとめる。

## 概要

Chrome Extension (Manifest V3) として、ブラウザの画面を PNG / GIF でキャプチャする。ビルドツールは使わず、プレーンな JS/HTML/CSS のみで構成している(npm はライブラリ取得にのみ使用)。

## 現在実装済みの機能(最低限セット)

- **範囲を選んで操作(矩形選択・要素選択)**
  - 「範囲を選ぶ」と「その範囲に対して何をするか」を分離している。矩形選択・要素選択のいずれも、選ぶとその場に「画像保存」「録画開始/停止」ボタンが並んだツールバーが表示され、Escで選択を解除するまで同じ範囲を保持する。
  - 保持している間は「画像保存」を何度でも押して連続保存できる(いわゆる連射)。「録画開始」を押すとその範囲だけを毎フレーム切り出してGIF録画を開始し、「録画停止」を押すとその都度GIFとして保存できる。
  - 要素選択でビューポートより大きい/画面外にはみ出す要素を選んだ場合、画像保存はPNGのフルページ撮影と同じタイル分割撮影で対応するが、GIF録画はスクロールしながらの撮影に対応できないため録画ボタンは無効化される。
- **PNG(直接保存)**
  - 表示中のビューポートをそのまま保存
  - ページ全体(スクロールしながら分割撮影して結合)を保存
- **GIF(パラパラ漫画、直接録画)**
  - 表示中のページ(タブ全体)を録画開始/停止。停止すると GIF としてダウンロードされる。
  - 録画中はツールバーアイコンに `REC` バッジを表示する(矩形/要素選択のツールバーから録画を開始した場合は popup が閉じているため、録画中であることが見た目でわかるようにするため)。
- **キーボードショートカット**
  - 上記の操作はすべて `chrome://extensions/shortcuts`(Chrome標準のショートカット設定画面)からキー割り当てできる。popup 最下部の「⌨ キーボードショートカットを設定」から直接開ける。独自の設定UIは作らず、割り当てそのものはChromeに任せる方針(理由は下記「実装ログ」参照)。
- **保存**
  - すべて `chrome.downloads.download` でダウンロードフォルダ配下 `GyazoExtensionTycoon/` に保存

Gyazo / Imgur へのアップロードは未実装(将来の拡張ポイント。下記「今後の拡張」参照)。

## アーキテクチャ

| コンポーネント | 役割 |
|---|---|
| [background/service-worker.js](background/service-worker.js) | 全体のオーケストレーター。popup / content script / offscreen document 間のメッセージ中継、`chrome.tabs.captureVisibleTab` / `chrome.scripting` / `chrome.tabCapture` / `chrome.offscreen` の呼び出しを一元管理。Blob や canvas は一切扱わない。 |
| [content/content-script.js](content/content-script.js) | ページ内に注入され、矩形選択・要素選択のオーバーレイ UI(選択確定後の「画像保存/録画開始」ツールバーを含む)と、フルページ/大きい要素向けの「スクロールしながら分割撮影」ループを担当。 |
| [offscreen/offscreen.js](offscreen/offscreen.js) | Canvas によるトリミング/タイル結合、`MediaStream` を使った GIF 用フレームサンプリング、GIF エンコード、`chrome.downloads.download` の呼び出しを担当。 |
| [popup/popup.html](popup/popup.html) / [popup.js](popup/popup.js) | ツールバーのボタン UI。 |
| [vendor/gifenc](vendor/gifenc) | GIF エンコード用に [gifenc](https://github.com/mattdesl/gifenc)(MIT License)の配布用 ESM バンドルをそのまま同梱。ビルド不要で `import` できるため採用。 |

Manifest V3 のサービスワーカーは DOM を持たないため、Canvas / `MediaStream` / `URL.createObjectURL` / GIF エンコードなど DOM 依存の処理はすべて [`chrome.offscreen`](offscreen/offscreen.js) 内に閉じ込めている。

### GIF 実装方針についての経緯

当初案として「`chrome.tabs.captureVisibleTab` を連続呼び出しして静止画列から GIF を作る」方式も検討したが、同 API には呼び出しレート制限があり実質 2fps 程度が上限になるため、`chrome.tabCapture` + `getUserMedia` で取得したタブのライブ `MediaStream` を offscreen document 内の `<video>` に流し込み、一定間隔(`GIF_FRAME_INTERVAL_MS`)でフレームを直接サンプリングして [gifenc](vendor/gifenc/gifenc.esm.js) にストリーミングでエンコードする方式を採用した。

`MediaRecorder` で録画してから WebM を後処理で読み直す方式も検討したが、Chrome が生成する WebM は `duration` が正しく書き込まれないことがあり、シークが不安定になる既知の問題があるため避けた。ライブストリームから直接サンプリングする方式はその問題を回避でき、実装もシンプルになる。

## 既知の制限・今後調整が必要な暫定値

- `GIF_FRAME_INTERVAL_MS`(GIFフレームサンプリングの目標間隔、現在 60ms)、`GIF_PALETTE_REFRESH_INTERVAL`(パレット再計算間隔、現在 5フレームに1回)、`GIF_MAX_DIMENSION`(エンコード解像度の長辺上限、現在 960px。これを超える場合は縮小してからエンコードする)、`GIF_MAX_FRAMES`(暴走防止用の最大フレーム数、現在 1500 = 目標間隔通りなら約90秒)は容量よりなめらかさを優先する方針の暫定値。画質・ファイルサイズ・CPU負荷を見ながら今後調整する([offscreen/offscreen.js](offscreen/offscreen.js) 冒頭の定数)。
- GIF録画の矩形選択・要素選択は、選択した範囲を毎フレーム切り出す都合上、ビューポートに収まる範囲のみ対応。ビューポートより大きい/画面外にはみ出す要素は録画できない(PNGのフルページ撮影のようなスクロールしながらのタイル結合は、録画中にスクロール位置を動かすと録画内容自体が乱れるため未対応)。
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
- GIF のフレームレート/最大時間/解像度を設定可能にする(popup からの設定 UI など)。現状は [offscreen/offscreen.js](offscreen/offscreen.js) 冒頭の定数で固定。
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
  - この2つは矩形選択・要素選択・フルページ・GIF録画のすべてに共通する原因だった。**実機で再検証済み: すべての機能でファイルダウンロードができることを確認**(ユーザーが `chrome://extensions` で再読み込みし、バージョン表示が `0.1.1` に更新されたことも合わせて確認)。
- ユーザーから「修正するごとにバージョンバンプしてほしい」との要望があり、以降のルールとして [CLAUDE.md](CLAUDE.md) に明記。あわせて `manifest.json` の `version` を `0.1.0` → `0.1.1` に更新(直近のバグ修正2件分)。バージョン表示が拡張機能の再読み込み確認にも使えることを確認。
- 「最低限の機能セット」としてはここで一区切り。各機能(フルページの重複写り込み対策、GIFのフレームレート調整、要素選択の精度など)の詰めは別セッションで継続する。

### 2026-09-27 (続き: GIF録画の機能整理 — 矩形/要素選択への対応と早送りバグの修正)
- ユーザーから「GIF録画も矩形選択・要素選択・表示中ページの3方式で開始できるようにしたい(PNGと同じ)」「保存されるGIFがかなり早送りに見える。容量は度外視でできるだけなめらかにしてほしい」との要望を受けて対応。
  - **早送りに見えるバグの原因**: [offscreen/offscreen.js](offscreen/offscreen.js) の `captureGifFrame()` は、gifenc の `writeFrame()` に渡す各フレームの `delay`(表示時間)を `GIF_FRAME_INTERVAL_MS` 固定値で記録していた。一方、実際のフレーム間隔は `quantize()`(256色パレットの再計算、全ピクセルを見るため重い)を含む処理時間ぶん、目標値より長くなることがある。つまり「実際に録画した時間」と「GIFに記録した合計delay(=再生時間)」がずれ、実際より短い再生時間で記録されるため、再生すると早送りに見える。**対応**: `performance.now()` で直前フレームからの実測経過時間を計算し、`delay` にはその実測値を使うよう変更した。これにより、実際の間隔が伸びた場合でも再生速度が録画時の実時間からずれなくなる。
  - **なめらかさの改善**: 上記の `quantize()` の重さ自体がフレーム間隔を伸ばす主要因だったため、パレットは毎フレームではなく `GIF_PALETTE_REFRESH_INTERVAL`(=5)フレームに1回だけ再計算し、間のフレームは同じパレットを `applyPalette()` で使い回す方式に変更(色の正確さより滑らかさを優先)。これにより実際に達成できるフレームレートが上がるため、目標間隔 `GIF_FRAME_INTERVAL_MS` も 150ms → 60ms に短縮し、暴走防止用の `GIF_MAX_FRAMES` も 300 → 1500 に合わせて調整した(容量は度外視という要望のため)。
  - **矩形選択・要素選択からのGIF録画対応**: これまでGIF録画は「表示中のページ(タブ全体)」のみ対応だった。PNGの矩形選択・要素選択と同じUXで録画も開始できるよう、以下の設計で対応した。
    - popup / content script 間の `START_RECT_SELECT` / `START_ELEMENT_SELECT` メッセージに `mode`("capture" | "record")を追加。選択完了時、`mode: "record"` なら PNG用の `CROP_SELECTION_READY` の代わりに新設した `RECT_READY_FOR_RECORDING` を送る。
    - background は `RECT_READY_FOR_RECORDING` を受けたら `chrome.tabCapture.getMediaStreamId()` でストリームIDを取り、offscreen の `START_RECORDING` に `rect`/`dpr` を渡す。
    - offscreen 側は `rect`/`dpr` が渡された場合、PNGのクロップ処理(`processCrop`)と同じ考え方(CSS pxのrectにdprを掛けて実ピクセル座標に変換)で、tabCaptureの映像(`<video>`)から毎フレーム該当範囲だけを `drawImage()` で切り出してcanvasに描く。canvas自体をクロップ後のサイズで確保するため、エンコードされるGIFも録画範囲のサイズになる。
    - 要素選択でビューポートに収まらない要素が選ばれた場合は、PNGのようなスクロールタイル結合はGIF録画では行わない(録画中にスクロール位置を動かすと映像自体が乱れて破綻するため)。その場合は録画を開始せず、理由を通知して終了する。
  - **UI変更**: popup の GIFセクションを、単一の「録画開始/停止」トグルボタンから、開始3ボタン(矩形/要素/表示中ページ)+停止1ボタンの構成に変更([popup/popup.html](popup/popup.html)・[popup.js](popup/popup.js))。矩形/要素選択で録画を開始するとpopup自体は(選択操作のため)一度閉じるので、録画中であることが見た目でわかるよう、ツールバーアイコンに `chrome.action.setBadgeText()` で `REC` バッジを出すようにした([background/service-worker.js](background/service-worker.js) の `setRecordingBadge()`)。
  - 旧 `TOGGLE_RECORDING` メッセージは、開始経路が3つに増えたことで「録画中かどうかで開始/停止を振り分ける」設計が合わなくなったため廃止し、`START_RECORDING_VISIBLE` / `RECT_READY_FOR_RECORDING` / `STOP_RECORDING` の3メッセージに分割した。
  - **未検証の注意点**: このセッションでは静的チェック(`node --check` での構文確認)のみ行っており、実機のChromeでの動作確認はできていない。特に以下は実機での確認が必要:
    - 矩形選択・要素選択からの録画で、tabCapture映像内のクロップ座標(dpr換算)がPNGクロップと同様に正しく合っているか。
    - GIFの再生速度が実際の録画時間と一致するようになったか(早送りバグが解消したか)、および目標間隔60msがCPU的に無理なく回るか(重ければ`GIF_FRAME_INTERVAL_MS`を大きくする調整が必要になる可能性がある)。
    - `chrome.tabCapture.getMediaStreamId()` を、popupのボタン押下(直接のユーザー操作)経由ではなく、content scriptからのメッセージ(矩形/要素選択完了)経由で呼び出しても問題なく動作するか(ユーザージェスチャー起点の要件に引っかからないか)。
  - → 上記の1点目・2点目について実機検証で問題が見つかった。詳細と対応は次のエントリを参照。

### 2026-09-27 (続き: 実機検証で判明した2つの不具合を修正 — 録画範囲のズレ / まだガタガタする)
- 実機のChromeで上記の対応を試したユーザーから、「『ページを録画』は正常だが、矩形選択・要素選択は指定した範囲からズレて記録・保存される」「まだ録画したGIFがガタガタ(コマ落ちがひどい)している」との報告があり、以下を修正。
  - **バグ: 矩形選択・要素選択の録画範囲がズレる。** 前回の対応で、rect(CSS px)を `devicePixelRatio` 倍して tabCapture 映像内のクロップ座標に変換していたが、これは誤った前提だった。`chrome.tabs.captureVisibleTab`(PNG側)は仕様上 devicePixelRatio 込みの実ピクセル解像度の画像を返すことが保証されているが、`chrome.tabCapture` の `getUserMedia` 映像(GIF録画側)の解像度が devicePixelRatio と同じ倍率になるとは限らない(実機ログで確認した実際の映像解像度が dpr 倍の想定と食い違っていた)。**対応**: dpr 倍する代わりに、「録画開始時の映像の実解像度 ÷ 選択時のビューポートCSS pxサイズ」を実測して倍率(scaleX/scaleY)を求め、それを rect に掛けてクロップ座標にするよう変更した([offscreen/offscreen.js](offscreen/offscreen.js) の `startRecording()`)。ビューポートのCSS pxサイズは content script から `RECT_READY_FOR_RECORDING` メッセージの `viewportWidth`/`viewportHeight` として渡すようにした([content/content-script.js](content/content-script.js))。この方式なら tabCapture 側の実解像度がどんな倍率であっても(dpr倍でなくても)正しくクロップできる。
  - **バグ: 依然としてガタガタする(コマ落ちが目立つ)。** 前回、各フレームのdelayを実測値にする対応(再生速度のズレ=早送りの解消)と、パレット再計算の間引き(処理コスト削減)を行ったが、これらは「記録した再生時間が正しくなる」「1フレームあたりの処理が多少軽くなる」効果はあっても、そもそも撮れる実フレーム数を大きく増やすには不十分だった。原因は `getImageData`/`quantize`/`applyPalette` の処理コストがピクセル数に比例することで、高dpr環境のフルページ録画では映像が実質4Kクラスの解像度になり、1フレームの処理だけで目標間隔(60ms)を大きく超えてしまい、結果的に実際に撮れるフレーム数が少なく(=フレーム間の絵の変化が大きく)ガタガタして見えていた。**対応**: エンコード解像度そのものに上限(`GIF_MAX_DIMENSION` = 960px、長辺基準)を設け、これを超える場合は縮小してからGIFにエンコードするようにした([offscreen/offscreen.js](offscreen/offscreen.js))。ピクセル数が減ることで `getImageData`/`quantize`/`applyPalette` のコストが下がり、実際に撮れるフレームレートが目標値に近づくことを期待している(画質より滑らかさを優先する今回の方針に合致)。
  - **この2件も実機での再検証が必要**(このセッションでは構文確認のみ)。特に、①矩形/要素選択の録画範囲が今度は正しく合っているか、②960px縮小後もまだガタガタするなら`GIF_MAX_DIMENSION`をさらに下げる/`GIF_FRAME_INTERVAL_MS`を伸ばす調整が必要になる可能性がある。

### 2026-09-27 (続き: キーボードショートカット対応 / 「選択」と「操作」の分離)
- ユーザーから2つの要望を受けて対応した。
  1. 「機能呼び出しのショートカットを登録したい。独自オプション画面 vs Chrome標準のショートカット画面、いずれにせよワンアクションで起動したい」
  2. 「矩形選択を例にすると、『矩形選択で画像保存』『矩形選択で録画開始』を先に選ぶのではなく、まず矩形を描いてから、その下に表示される『画像保存』『録画開始』ボタンでどうするか選びたい。選択はEscで解除するまで保持し、保存ボタンを押せば連射できるようにしたい」
- **ショートカットの実装方針**: 独自のオプション画面(キー入力を捕捉して保存するUI)は作らず、Chrome標準の `chrome.commands` API(`chrome://extensions/shortcuts` でユーザーが割り当てる画面)に任せることにした。理由: (a) 独自実装は content script 側でのキー捕捉(ページにフォーカスがある時しか効かない)や重複バインドの検知など作り込みが多く、(b) `chrome.commands` はブラウザ側でグローバルに効き、キー割り当てUIも標準で提供されるため「ワンアクションで起動」の要件を満たしつつ実装コストが小さい。`manifest.json` に `commands`(`capture-rect` / `capture-element` / `capture-visible` / `capture-fullpage` / `record-visible` / `record-stop` の6個、いずれも `suggested_key` は指定せずユーザーの手動割り当てに委ねる)を追加し、[background/service-worker.js](background/service-worker.js) に `chrome.commands.onCommand` リスナーを追加した。popup のボタンクリックとショートカット実行が同じ処理(`captureVisiblePage()` / `startRectSelectOnActiveTab()` 等の共通関数)を呼ぶようにリファクタリングし、二重実装を避けた。popup 最下部に `chrome://extensions/shortcuts` を開くボタンを追加し、ユーザーがそこからすぐ割り当てられるようにした。
  - 矩形選択・要素選択の録画開始(旧 `record-rect` / `record-element` 相当)はショートカットの対象にしていない。後述の「選択」と「操作」の分離により、範囲を選ぶこと自体はドラッグ/クリックという手動操作が必須で、1キー操作には収まらないため。ショートカットで一発起動できるのは「矩形選択を始める」「要素選択を始める」ところまで。
- **「選択」と「操作」の分離**: これまでは「矩形選択で保存」と「矩形選択で録画」が別々の入り口(ボタン)になっていて、選ぶ前にどちらの目的か決める必要があった。これを、まず範囲を選び、選んだ範囲に対して後から「画像保存」「録画開始/停止」を選べる構成に変更した([content/content-script.js](content/content-script.js) を大きく書き直し)。
  - 矩形選択・要素選択とも、選択が確定すると選択枠はそのまま残し(Escで解除するまで)、選択枠のそば(下端、画面下端からはみ出す場合は上)に操作ツールバー(`showActionToolbar()`)を表示する。ツールバーの「画像保存」ボタンは押すたびに `CROP_SELECTION_READY`(または要素がビューポート外なら `TILES_READY` 相当のタイル撮影)を送るだけなので、何度でも連射できる。「録画開始/停止」ボタンは押した時点の `GET_RECORDING_STATE` を見て開始/停止を振り分けるトグルとして実装した。
  - 矩形選択のドラッグ用の全面オーバーレイ(暗い背景、ページ操作をブロックする)は選択確定後は不要になるため外し、選択枠(`selectionBoxEl`)とツールバーだけを残す設計にした。これによりページ自体は選択確定後も通常どおり操作できる(録画中にページをスクロール/操作したい場合もあるため)。
  - 要素選択でビューポートに収まらない要素を選んだ場合は、録画ボタンを最初から `disabled` にして理由を `title` ツールチップで示す方式にした(以前は録画ボタンを押した後に失敗を通知していたが、選んだ時点でわかるようにする方が親切なため)。
  - 矩形選択で小さすぎるドラッグ(誤クリック)をした場合、以前は選択自体を中断してpopupから再度呼び直す必要があったが、選択待機状態を維持して再ドラッグできるようにした(「Escで解除するまで保持する」という新しいモデルに合わせた小さな改善)。
  - この変更に伴い、popup の GIF録画ボタンは「表示中のページを録画開始」「録画停止してGIF保存」の2つだけになった(矩形/要素選択からの録画開始は、popupではなく選択後のツールバーから行う)。矩形選択・要素選択のPNG保存専用ボタンも、それぞれ「矩形選択をする」「要素選択をする」という中立的な文言に変更した。
- **未検証の注意点**: このセッションでは構文チェック(`node --check`)のみ行っており、実機のChromeでの動作確認はできていない。特に以下は実機での確認が必要:
  - `manifest.json` の `commands` に6個登録しているが、`chrome://extensions/shortcuts` に正しく一覧表示され、割り当て・発火できるか(Chromeの同時割り当て可能数に関する制約に引っかからないか)。
  - 選択確定後にオーバーレイ(全面の暗い背景)を外してページ操作を解放する変更により、ツールバー・選択枠の `z-index` が意図通り最前面に出るか(特に `selectionBoxEl` は以前 `overlayEl` の子要素だったが、独立した要素として `document.documentElement` に直接追加する形に変えたため `z-index` を明示的に指定し直した)。
  - ツールバーの位置決め(`positionToolbar()`)が、選択範囲が画面の端(特に下端)にある場合でも画面内に収まるか。
  - `chrome.tabs.create({ url: "chrome://extensions/shortcuts" })` が権限エラーなく動作するか(`tabs` permission は追加していない。ドキュメント上は `chrome.tabs.create` 自体に `tabs` permission は不要なはずだが未検証)。

### 2026-09-27 (続き: 要素選択GIF録画の2つの不具合を修正 — 横方向のズレ / 選択枠の写り込み)
- ユーザーから、要素選択でのGIF録画で「要素で囲った領域より広く横にはみ出る」「要素選択の青枠が残っている(録画に写り込む)」との報告(GIFのスクリーンショット添付)を受けて調査・修正した。
  - **バグ1: 選択枠(青枠)が録画映像に写り込む。** 前回(「選択」と「操作」の分離)の変更で、矩形選択・要素選択とも選択確定後は `cleanupOverlay()` を呼ばず選択枠(`selectionBoxEl`/`highlightEl`)を意図的に残すようにした(Escで解除するまで保持し、ツールバーから連射・録画できるようにするため)。これ自体は狙い通りだが、その結果、選択枠(ちょうど選択範囲の境界に重なる位置に描画される、2px幅などの枠線)がページ上に存在したまま録画されるようになり、録画映像にも枠線がそのまま写り込むようになっていた(以前の設計では選択後すぐに `cleanupOverlay()` していたため気づいていなかった)。**対応**: [content/content-script.js](content/content-script.js) の `showActionToolbar()` に `outlineEl`(選択枠の要素)を渡せるようにし、ツールバーの「録画開始」ボタンを押した瞬間に `outlineEl.style.visibility = "hidden"` で非表示にし、「録画停止」を押した(または開始自体に失敗した)ときに元に戻すようにした。選択枠は録画中も要素自体として存在はし続ける(位置・サイズの追従自体は不要なので問題ない)。
  - **バグ2: 要素選択のGIF録画が横方向にだけズレて広い範囲を録ってしまう。** [offscreen/offscreen.js](offscreen/offscreen.js) の `startRecording()` は、tabCapture映像の実解像度(`videoWidth`/`videoHeight`)と、選択時に content script から渡された `viewportWidth`/`viewportHeight`(選択範囲の rect と同じ座標系のビューポートCSS pxサイズ)から `scaleX`/`scaleY` を実測して rect をクロップ座標に変換している。ところが [content/content-script.js](content/content-script.js) 側は `viewportHeight` には `window.innerHeight` を使う一方、`viewportWidth` には `document.documentElement.clientWidth`(縦スクロールバーの幅を除いた幅)を使っており、基準が縦横で食い違っていた。tabCapture の映像はページの描画領域全体(スクロールバー部分を含む `window.innerWidth` 相当)を捉えているため、`clientWidth` を使うと実際より小さい値で割ることになり `scaleX` が実際より大きく算出され、結果としてクロップ範囲が横方向にだけ本来より広く(かつ右にずれた位置で)切り出されていた(縦スクロールバーが存在するページで顕在化する)。**対応**: `lockRectSelection()`/`lockElementSelection()` の録画用 `viewportWidth` を `window.innerWidth` に変更し、`scaleX`/`scaleY` が同じ基準(スクロールバー込みの実際の描画領域)で計算されるようにした。要素選択の `fitsInViewport`(要素がビューポート内に収まっているかの判定、録画ボタンの有効/無効に使う)はこれまで通り `document.documentElement.clientWidth` を基準にしている(要素が実際に描画されうる範囲との比較であり、これは変更不要なため)。
  - **未検証の注意点**: このセッションも構文チェック(`node --check`)のみで、実機での再検証はできていない。特に、縦スクロールバーがあるページでの要素選択録画のズレが解消したか、および選択枠を録画中に隠す対応でチラつきなど見た目の違和感がないかは実機で確認が必要。

### 2026-09-27 (続き: 要素選択で「見た目より広い範囲」が録画される問題への対応 — 実は座標計算のバグではなかった)
- ユーザーから上記の修正後も改めて「まだ要素選択外の横幅が含まれているっぽい(要素としてリストしか選んでいない)」との報告(GIF添付)があり、選択直前の状態を追加のスクリーンショットで確認してもらったところ、**選択時に表示されるハイライト枠自体が、最初から録画結果と同じ幅(コメント一覧の行いっぱいの幅)で表示されていた**ことが分かった。つまりこれは録画側のクロップ座標計算のバグではなく、`document.elementFromPoint()` で拾った要素(コメント一覧の `<li>` 相当)が、CSSレイアウト上もともと親コンテナいっぱいの幅を持つブロック要素で、中の文字はその一部しか占めていない(短いコメントだと右側が地の余白になる)ために起きていた、想定通りの挙動だった。
- ただし、ユーザーの要望は「要素選択で選択した領域=視覚で認識できている通りに切り抜きたい」というものだったため、これに対応する機能を追加した。**方針**: 要素自体に見た目上の区切り(背景色/背景画像/枠線のいずれか)があるかどうかで場合分けする。
  - 区切りが**ある**場合(カード状のUIなど): これまで通りその要素の `getBoundingClientRect()` をそのまま使う(枠線や背景そのものが「視覚的に認識できる範囲」なので、狭める理由がない)。
  - 区切りが**ない**場合(今回のような、素の `<li>` など): 要素の中身を再帰的に走査し、実際に表示されているテキスト(`Range.getBoundingClientRect()` で計測)や `<img>`/`<svg>`/`<canvas>`/`<video>` 等の置換要素の外接矩形をすべて集めて union した範囲まで狭める。ただし、走査の途中で「見た目の区切りを持つ子要素」(例: 内側のバッジやサムネイルの背景付きボックス)に当たったら、そこはその子要素の箱ごと採用し、それ以上中身には潜らない(その子要素自身が視覚的な単位として認識されるべきため)。
  - 実装は [content/content-script.js](content/content-script.js) の `computeVisualRect()`(要素選択のセクションに追加)。要素選択のホバー中のプレビュー枠(`onMouseMove`)と、選択確定時の `lockElementSelection()` の両方で、`target.getBoundingClientRect()` の代わりにこの関数を使うよう変更した。プレビューの時点で「実際に録画・保存される範囲」がそのまま見えるようにするのが狙い。
  - 画像保存(`CROP_SELECTION_READY`/タイル撮影)・GIF録画(`RECT_READY_FOR_RECORDING`)はどちらも同じ `rect` 変数を使い回している(コード構造上の既存の設計)ため、この変更だけで両方の保存経路に反映される。
  - **既知の限界**: 「見た目の区切り」の判定は背景色・背景画像・枠線のみを見ており、`box-shadow` だけで縁取りを表現しているUIなどは区切りなし判定になり中身基準で狭められる。また大きなコンテナ(大量の子孫を持つ要素)を選択すると再帰走査のコストがかかる可能性があるが、要素選択は基本的にカードやリスト行程度の小さい単位を選ぶ用途を想定しているため、現時点では許容範囲とした。
  - **未検証**: このセッションも構文チェックのみ。実機で、今回報告のあったリストのようなケース(背景/枠線なし要素)で余白が除外されるか、逆にカード状の要素(背景/枠線あり)で従来通りの範囲が維持されるか、の両方を確認する必要がある。

### 2026-09-27 (続き: 上記の「見た目の区切り」判定が甘く、実際には狭まっていなかった不具合を修正)
- 0.4.0 をユーザーに試してもらったところ「やっぱり変わっていない」との報告(別のコメント一覧での選択・録画結果のスクリーンショット添付)。原因を再検討し、`hasVisibleBoxDecoration()` の判定が実際のサイトでは常に真になりがちで、狭める分岐にほぼ入っていなかったことが分かった。
  - **原因1**: 判定が「`backgroundColor` が `transparent` でなければ区切りあり」という単純な条件だったが、実際のサイトはリストの各行に(周囲の背景と同じ色であっても)明示的な `background-color` を指定していることが非常に多い(CSSリセットや hover 対応でよくあるパターン)。この場合、周囲と視覚的に区別できないにもかかわらず「区切りあり」と誤判定され、常に元の(余白込みの)全体矩形にフォールバックしていた。
  - **原因2**: 判定が上下左右いずれかの枠線があれば「区切りあり」としていたが、実際のコメント一覧のようなリストは行の区切りとして `border-bottom` のみを引いていることが多い。この上下だけの区切り線は横幅には無関係なのに、横方向まで含めて「区切りあり」と判定され、狭められなくなっていた。
  - **対応**: [content/content-script.js](content/content-script.js) の判定ロジックを以下のように修正した。
    - 背景色は「transparent でないか」ではなく、祖先を遡って実際に透けて見える実効背景色(`getEffectiveBackgroundColor()`)と比較し、**周囲と異なる色のときだけ**「見た目の区切りあり」とする(`hasDistinctBackground()`)。
    - 枠線は左右(`Left`/`Right`)のみを見る(`hasVisibleBorder(el, ["Left", "Right"])`)。上下の区切り線は無視する。
    - この2つを合わせた `hasHorizontalBoxDecoration()` で「横方向に区切りがあるか」を判定し、区切りがある場合のみ元の全体矩形(左右)を維持、無い場合は中身(テキスト/画像等)の外接矩形まで左右を狭める。
    - 合わせて、狭める対象を**横幅のみ**に限定するよう明確化した(縦方向は常に要素自体の高さをそのまま使う)。これまで報告された不具合がすべて横方向のものだったため、縦方向まで狭めることによる副作用(行区切り線とのズレ等)のリスクを避けるため。
  - **未検証**: 引き続き構文チェックのみ。今回添付されたコメント一覧(各行に行区切りの `border-bottom` のみで背景色は周囲と同じ、というありがちな構成)で正しく横幅が狭まるか、実機での確認が必要。
