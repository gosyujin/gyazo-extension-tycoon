---
paths:
  - "content/**"
---
# content script(content/)

- **再注入は選択状態を壊す。** `content/content-script.js` の二重注入ガードは `__gyazoExtTycoonReinit` → `cleanupOverlay()` を呼び、矩形・要素選択の選択枠・ツールバー・マスクを全部消す。メッセージは、まず `chrome.tabs.sendMessage` を試し、受信側がいない場合だけ注入して再送する(`sendToContentScript()`)。
- **ページに置いた拡張機能の UI は撮影に写り込む。** 選択枠・ツールバー・トーストは `captureVisibleTab` にそのまま写る。新しく UI 要素を足したら、画像保存・タイル撮影・録画のそれぞれで隠す / 消す処理が要るかを必ず確認する(`hideFloatingElements()` は拡張機能自身の UI を除外するので、タイル撮影では自分で隠す)。
- background(サービスワーカー)や offscreen の Blob URL は、ページと別オリジンなので content script から直接 `fetch` できない。画像データが要るときは background に取得(必要なら base64 化)してもらう。
