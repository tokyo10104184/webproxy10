# WebProxy10 (2026)

1画面でURL入力→即表示できる、モダン向けWebプロキシ実装です。

## まず洗い出した要件

- **1画面完結UI**: 入力欄 + 実表示エリア(iframe)のみ。
- **動的コンテンツ対応**: SPAで後から追加されるDOMの`src/href/action/srcset`を書き換え。
- **動画・画像対応**: バイナリ配信、Rangeヘッダー引き継ぎ、MIME温存。
- **API通信対応**: `fetch` / `XMLHttpRequest`をランタイムでパッチ。
- **実運用で壊れやすい要因への対策**:
  - `CSP` / `X-Frame-Options`の無効化
  - `<base>`注入で相対リンク基準を固定
  - CSS `url()` / `@import` の再書換
- **サーバ側要件**:
  - GET/POST等メソッド透過
  - リダイレクト追従
  - クッキー保持(簡易jar)
  - ヘルスチェック

## 実装ファイル

- `server.js`: Node.js標準APIベースのプロキシ本体
- `public/index.html`: 1画面UI

## 起動

```bash
npm install
npm start
# http://localhost:8080
```

## 注意 (重要)

「どんなサイトでも完璧」はWeb標準/セキュリティ仕様上、100%保証不可です。特に以下は制限が残る可能性があります。

- DRM(Eme/Widevine)付き動画
- 高度なBot対策/CAPTCHA
- Service Workerを必須にした設計
- WebSocket独自プロトコルや証明書ピンニング依存
- 銀行/決済など厳格なオリジン前提フロー

本実装は**2026時点の一般的なサイトを幅広く表示できる現実解**を狙ったベースラインです。
