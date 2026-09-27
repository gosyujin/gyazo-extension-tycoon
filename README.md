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
  - ツールバーの popup から、以下の3つの方法で録画を開始できる。好きなタイミングでツールバー popup の「録画停止してGIF保存」を押すと GIF としてダウンロードされる。
    - 矩形選択で録画開始(選択した範囲だけを毎フレーム切り出して録画)
    - 要素選択で録画開始(クリックした要素の範囲だけを毎フレーム切り出して録画。ビューポートに収まる要素のみ対応。画面外にはみ出す要素は録画不可)
    - 表示中のページを録画開始(タブ全体を録画)
  - 録画中はツールバーアイコンに `REC` バッジを表示する(矩形/要素選択で開始した場合は popup が一度閉じるため、録画中であることが見た目でわかるようにするため)。
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
