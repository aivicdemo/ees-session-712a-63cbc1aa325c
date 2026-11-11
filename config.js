// AIVIC Backend Configuration
// AIVIC_APP_URL 環境変数が設定されている場合は自動セットされます
// 未設定の場合: REPLACE_WITH_API_URL を AIVIC アプリの URL（例: https://your-app.amplifyapp.com）に書き換えてください

window.AIVIC_API_URL = "https://aivic-next.dq7lb2l26qhlt.amplifyapp.com";
window.AIVIC_TABLES = {
  "受注": 0,
  "受注明細": 1,
  "仕入先マスタ": 2,
  "発注": 3,
  "発注明細": 4,
  "納品": 5,
  "納品明細": 6,
  "請求": 7,
  "請求明細": 8,
  "在庫": 9,
  "在庫引当": 10,
  "販売フロー異常": 11,
  "仕入フロー異常": 12,
  "異常通知ログ": 13,
  "代替仕入先候補": 14,
  "納期調整案": 15,
  "ユーザー": 16,
  "操作履歴": 17
};
