---
paths:
  - "offscreen/**"
---
# offscreen document(offscreen/)

- **`chrome.offscreen` の document には `chrome.downloads` が無い**(`undefined` になる)。offscreen は Canvas / Blob / MediaStream など DOM に依存する処理だけに使い、ダウンロードは background 側で Blob URL 経由で行う。
- 処理結果を background に返すときは、Blob URL などの文字列にしてから `chrome.runtime.sendMessage` で送る(Blob は安全に送れない)。
- 録画中かどうかなど、複数メッセージにまたがる状態の真実の情報源はここに置く(サービスワーカーは破棄されるので持たない)。
