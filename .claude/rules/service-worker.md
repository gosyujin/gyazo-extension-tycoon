---
paths:
  - "background/**"
---
# サービスワーカー(background/service-worker.js)

- **MV3 のサービスワーカーの状態は信用しない。** アイドルで破棄され、次のイベントでトップレベル変数がリセットされた状態で再起動される。録画中フラグのように複数メッセージにまたがって保持したい状態を `let` 変数に置くと、長い操作の途中で再起動されて失われる(実際に発生。README 2026-09-27)。真実の情報源は状態を実際に持つコンテキスト(録画なら offscreen document)に置き、サービスワーカーは毎回そこに問い合わせる。
- ファイルのダウンロード(`chrome.downloads.download`)は background 側で行う。offscreen が作った Blob を `URL.createObjectURL()` した Blob URL 経由で受け取る(offscreen が生きている間は他コンテキストからも参照できる)。
- `chrome.runtime.sendMessage` は `Blob` などの非 JSON 値を安全に送れない。Blob URL などの文字列にしてから送る。
- **`chrome.tabs.captureVisibleTab` は実質2回/秒程度のレート制限がある。** 超えると例外にならず `undefined` が返るだけなので、呼び出し側で必ずチェックする(フルページ撮影で一部タイルが `undefined` になり、`fetch()` で `Failed to fetch` に化けた)。連続呼び出しには呼び出し間隔のレートリミッター(実測で550ms以上)を入れ、失敗時はリトライする。
- content script にメッセージを送るときは、まず `chrome.tabs.sendMessage` を試し、受信側がいない場合だけ注入して再送する(`sendToContentScript()`)。すでに選択を保持しているタブに「念のため注入」しない(content script の再注入は選択状態を全部消す)。
