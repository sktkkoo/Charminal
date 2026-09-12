# Peer call lifecycle foundation

ローカルの複数 AI と別 PC の AI、人間を、同じ参加者モデルで扱うための内部的な状態管理。
`call-session.ts` はネットワーク、React、アバター描画、AI 実行に依存しない。
アプリや SDK にはまだ接続していないので、通話機能が利用できる状態ではない。

## Membership invariants

- `CallParticipant.kind` は人 / AI、`ownerEndpointId` はその参加者を所有する endpoint。
  一つの endpoint が複数の AI と人間を持てる。参加者 ID はセッション内で一意。
- `origin` は host が渡した `localEndpointId` との比較から導出する表示上の分類。
  peer から受け取った `origin: "local"` は利用しない。ただし endpoint ID 自体の認証は
  このモデルの仕事ではなく、将来の host / transport 境界で解決する必要がある。
- 状態は `invited → accepted → joined → left`。招待は `leave()` で辞退・取消できる。
  `accept()` だけでは media は有効にならず、`join()` と明示した consent の両方が必要。
- media consent は音声 / カメラ / 画面の**送信意思**のみを表す。既定はすべて無効。
  `setConsent()` は完全置換で、省略した項目も無効に戻す。
- `leave()` と `end()` は即時に consent を破棄する。再参加には新しい招待・承諾が必要。
  同じ参加者 ID の owner / kind は途中で差し替えない。
- `CallAdmission` は発行されたオブジェクトそのものだけが有効なローカルハンドル。
  JSON 化 / 複製、別セッション、終了済みセッション、退出前のハンドルは再利用できない。
  同じ表示用 session ID でモデルを作り直しても古いハンドルは利用できない。
- snapshot は変更できない過去の観測値。送信時には現在の admission に対して
  `canPublish()` を再確認し、古い snapshot を認可に使わない。

## Deliberate limits

これは local state の単体テスト可能な土台であり、peer の認証・認可、暗号化、
E2EE、署名付き招待、リプレイ対策の wire protocol を実装していない。
admission の revision や参照一致を認証 credential と呼んではいけない。
公開メソッドは信頼された host 用で、ネットワーク payload を直接渡す API ではない。

media の停止、キューにある送信の取消、track の解放、切断の検出などの IO も行わない。
接続時には退出・切断・同意撤回を実際の media 停止へ結び付ける必要がある。
接続断時の再入室や遅延処理では、古いハンドルを新しいハンドルへ自動変換しない。

AI が会話を聞く・発言する権限、参加者別の共有範囲、各所有者による同意確認、
AI provider への送信、録音・保存、ローカルの記憶や tool の境界は別の設計対象。
この consent を AI のコンテキスト参照や tool 実行の許可として流用しない。
人格や記憶、pack、ローカルファイルは保持・複製・送信しない。

## Verification

```sh
npm run test:run -- src/runtime/peer-call/call-session.test.ts
```

UI のシアター / コール / ポートレートの配置は、このモデルには含めない。
