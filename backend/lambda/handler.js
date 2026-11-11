"use strict";
/**
 * AIVIC Backend Lambda Handler — 販売・仕入統合管理システム
 * DynamoDB CRUD API (テーブル数: 18)
 *
 * ルート:
 *   GET    /api/{tableIndex}         → テーブル全件取得 (Scan)
 *   GET    /api/{tableIndex}/{id}    → 1件取得
 *   POST   /api/{tableIndex}         → 新規作成
 *   PUT    /api/{tableIndex}/{id}    → 更新
 *   DELETE /api/{tableIndex}/{id}    → 削除
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "ap-northeast-1" });
const docClient = DynamoDBDocumentClient.from(ddbClient);

// テーブルインデックス → DynamoDB テーブル名マッピング
const TABLE_NAMES = [
  "AIVIC_TABLE_0",
  "AIVIC_TABLE_1",
  "AIVIC_TABLE_2",
  "AIVIC_TABLE_3",
  "AIVIC_TABLE_4",
  "AIVIC_TABLE_5",
  "AIVIC_TABLE_6",
  "AIVIC_TABLE_7",
  "AIVIC_TABLE_8",
  "AIVIC_TABLE_9",
  "AIVIC_TABLE_10",
  "AIVIC_TABLE_11",
  "AIVIC_TABLE_12",
  "AIVIC_TABLE_13",
  "AIVIC_TABLE_14",
  "AIVIC_TABLE_15",
  "AIVIC_TABLE_16",
  "AIVIC_TABLE_17"
].map((envKey) => process.env[envKey] || "");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Content-Type": "application/json",
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

exports.handler = async (event) => {
  // CORS プリフライト
  if (event.httpMethod === "OPTIONS") {
    return respond(200, "");
  }

  const pathParts = (event.path || "").replace(/^\/api\//, "").split("/");
  const tableIndex = parseInt(pathParts[0], 10);
  const itemId = pathParts[1] || null;

  if (isNaN(tableIndex) || tableIndex < 0 || tableIndex >= TABLE_NAMES.length) {
    return respond(404, { error: "Table not found", index: tableIndex });
  }

  const tableName = TABLE_NAMES[tableIndex];
  if (!tableName) {
    return respond(500, { error: "Table name not configured", index: tableIndex });
  }

  try {
    switch (event.httpMethod) {
      case "GET": {
        if (itemId) {
          // 1件取得
          const result = await docClient.send(new GetCommand({
            TableName: tableName,
            Key: { id: itemId },
          }));
          if (!result.Item) return respond(404, { error: "Not found" });
          return respond(200, result.Item);
        } else {
          // 全件取得（ページネーション対応: 最大200件）
          const result = await docClient.send(new ScanCommand({
            TableName: tableName,
            Limit: 200,
          }));
          return respond(200, { items: result.Items || [], count: result.Count || 0 });
        }
      }

      case "POST": {
        // 新規作成
        const body = JSON.parse(event.body || "{}");
        const now = new Date().toISOString();
        const item = {
          ...body,
          id: body.id || crypto.randomUUID(),
          createdAt: body.createdAt || now,
          updatedAt: now,
        };
        await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
        return respond(201, item);
      }

      case "PUT": {
        // 更新
        if (!itemId) return respond(400, { error: "ID required for update" });
        const body = JSON.parse(event.body || "{}");
        const now = new Date().toISOString();
        const updateBody = { ...body, updatedAt: now };
        delete updateBody.id;
        delete updateBody.createdAt;

        const setExprs = Object.keys(updateBody).map((k, i) => `#k${i} = :v${i}`);
        const exprNames = Object.fromEntries(Object.keys(updateBody).map((k, i) => [`#k${i}`, k]));
        const exprVals = Object.fromEntries(Object.keys(updateBody).map((k, i) => [`:v${i}`, updateBody[k]]));

        const result = await docClient.send(new UpdateCommand({
          TableName: tableName,
          Key: { id: itemId },
          UpdateExpression: `SET ${setExprs.join(", ")}`,
          ExpressionAttributeNames: exprNames,
          ExpressionAttributeValues: exprVals,
          ReturnValues: "ALL_NEW",
        }));
        return respond(200, result.Attributes || {});
      }

      case "DELETE": {
        // 削除
        if (!itemId) return respond(400, { error: "ID required for delete" });
        await docClient.send(new DeleteCommand({
          TableName: tableName,
          Key: { id: itemId },
        }));
        return respond(200, { deleted: true, id: itemId });
      }

      default:
        return respond(405, { error: "Method not allowed" });
    }
  } catch (err) {
    console.error(`[AIVIC API] Error: ${err.message}`, { tableName, itemId, method: event.httpMethod });
    return respond(500, { error: "Internal server error", detail: err.message });
  }
};
