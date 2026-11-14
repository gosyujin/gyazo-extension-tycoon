# Claude 向け指示

このリポジトリで作業する際は、以下のルールに従うこと。

## 作業ルール

- 作業を始める前に、必ず [README.md](README.md) を読み、プロジェクトの現状・これまでの意思決定の経緯を把握すること。
- 機能を実装したら、その方針・経緯(なぜその設計にしたか)を README.md の「実装ログ / 意思決定の経緯」セクションに追記し、push すること。
- チャットの中で残しておいた方がよいと感じた指示・注意点があれば追記し、push すること。特定のファイルに結びつく注意は `.claude/rules/` の該当ファイル(`paths` に対象を書く)へ、結びつかないものはこのファイルへ書く。
- **修正(バグ修正・機能追加問わず)のたびに `manifest.json` の `version` をバンプすること。** 目安はバグ修正・小さな変更は patch(例: 0.1.0 → 0.1.1)、まとまった機能追加は minor。バージョンを上げ忘れたまま複数の変更を1コミットに混ぜないこと。

## ファイル別の注意(.claude/rules/)

`background/` / `offscreen/` / `content/` の MV3 の罠は `.claude/rules/` にあり、Read / Edit ツールで該当ファイルを開くと自動で読み込まれる。Bash(`cat` / `sed` / `grep` など)で読み書きするときは自動では読み込まれないので、先に該当する `.claude/rules/*.md` を読む。

中身の見出し: サービスワーカーの状態は信用しない / offscreen に `chrome.downloads` は無い / `sendMessage` で Blob を送らない / `captureVisibleTab` のレート制限 / content script の再注入は選択を壊す / 拡張機能の UI は撮影に写り込む / 他コンテキストの Blob URL は content script から fetch できない。

## いつも効かせる注意

- このプロジェクトはビルドツール(webpack/vite等)を使わないプレーンな JS/HTML/CSS の Chrome Extension(Manifest V3)。npm はライブラリ取得(`npm pack` で ESM バンドルを `vendor/` に配置する等)にのみ使い、依存パッケージとして `node_modules` に持ち込む使い方はしていない。この方針を変える場合はユーザーに確認すること。
- 実装の背景・アーキテクチャ判断(なぜ offscreen document を使うか、GIF をどう作っているか等)は README.md にまとまっているので、拡張機能まわりを触る前に必ず目を通すこと。
- **重要**: このセッションで使える組み込みブラウザ(Claude Browser / preview 系ツール)はサンドボックス化されており、`chrome://` 系ページや拡張機能の読み込み(`chrome://extensions` での Load unpacked)には使えない。Chrome Extension の動作確認は静的チェック(`node --check` での構文確認など)止まりになるため、実際の動作確認はユーザー自身に実機の Chrome で行ってもらう必要がある。「動作確認しました」と安易に言わないこと。
- **エラーを握りつぶさない**: content script → background → offscreen のように一方向的にメッセージを投げるだけの箇所(`sendResponse` を誰も見ていない経路)では、失敗してもユーザーからは何も起きていないように見える。ユーザーが「ボタンを押しても何も起きない」と報告してきたら、まずログ経路(3つの DevTools コンソール)とエラー通知(`chrome.notifications`)が足りているかを疑うこと。
