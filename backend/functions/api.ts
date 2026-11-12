import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  BatchWriteItemCommand,
  BatchWriteItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { extractAuthContext, hasPermission } from './rbac';

const client = new DynamoDBClient({ region: 'ap-northeast-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'SalesManagementTable';

const TABLE_INDICES: Record<number, string> = {
  0: 'customer',
  1: 'order',
  2: 'orderDetail',
  3: 'supplier',
  4: 'purchase',
  5: 'purchaseDetail',
  6: 'delivery',
  7: 'deliveryDetail',
  8: 'invoice',
  9: 'invoiceDetail',
  10: 'inventory',
  11: 'inventoryAllocation',
  12: 'product',
  13: 'salesFlowAnomaly',
  14: 'purchaseFlowAnomaly',
  15: 'anomalyNotificationLog',
  16: 'alternativeSupplier',
  17: 'deliveryAdjustment',
  18: 'user',
};

interface AuditLogEntry {
  pk: string;
  sk: string;
  userId: string;
  operationType: string;
  targetTable: string;
  targetId?: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

async function writeAuditLog(
  userId: string,
  operationType: string,
  targetTable: string,
  targetId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  const auditEntry: AuditLogEntry = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    userId,
    operationType,
    targetTable,
    targetId,
    timestamp: Date.now(),
    details,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: auditEntry,
    })
  );
}

function createErrorResponse(
  statusCode: number,
  message: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}

function createSuccessResponse(
  statusCode: number,
  data: unknown
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

async function handleGetResources(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return createErrorResponse(401, 'Unauthorized');
  }

  if (!hasPermission(authContext.role, 'customer:read')) {
    return createErrorResponse(403, 'Forbidden');
  }

  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'attribute_exists(pk) AND pk <> :auditPk',
        ExpressionAttributeValues: {
          ':auditPk': 'AUDIT',
        },
        Limit: 100,
      })
    );

    return createSuccessResponse(200, {
      items: result.Items || [],
      count: result.Count || 0,
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return createErrorResponse(500, 'Internal Server Error');
  }
}

async function handleBulkImport(
  event: APIGatewayProxyEvent,
  tableIndex: number
): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return createErrorResponse(401, 'Unauthorized');
  }

  const tableName = TABLE_INDICES[tableIndex];
  if (!tableName) {
    return createErrorResponse(400, 'Invalid table index');
  }

  if (!hasPermission(authContext.role, `${tableName}:bulk`)) {
    return createErrorResponse(403, 'Forbidden');
  }

  if (authContext.role === 'viewer') {
    return createErrorResponse(403, 'Viewers cannot perform bulk operations');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];

    if (!Array.isArray(items)) {
      return createErrorResponse(400, 'Items must be an array');
    }

    if (items.length === 0) {
      return createSuccessResponse(200, {
        imported: 0,
        failed: 0,
        errors: [],
      });
    }

    const now = Date.now();
    const enrichedItems = items.map((item: Record<string, unknown>) => ({
      ...item,
      pk: tableName,
      sk: item.id || randomUUID(),
      id: item.id || randomUUID(),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
      createdBy: item.createdBy || authContext.userId,
      updatedBy: item.updatedBy || authContext.userId,
    }));

    const chunks: Record<string, unknown>[][] = [];
    for (let i = 0; i < enrichedItems.length; i += 25) {
      chunks.push(enrichedItems.slice(i, i + 25));
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      const writeRequests = chunk.map((item) => ({
        PutRequest: {
          Item: item,
        },
      }));

      const params: BatchWriteItemCommandInput = {
        RequestItems: {
          [TABLE_NAME]: writeRequests,
        },
      };

      try {
        await client.send(new BatchWriteItemCommand(params));
        imported += chunk.length;
      } catch (error) {
        failed += chunk.length;
        errors.push(`Batch write failed: ${String(error)}`);
      }
    }

    await writeAuditLog(
      authContext.userId,
      'BULK_IMPORT',
      tableName,
      undefined,
      { imported, failed, itemCount: items.length }
    );

    return createSuccessResponse(200, {
      imported,
      failed,
      errors,
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createErrorResponse(500, 'Internal Server Error');
  }
}

async function handleGetItem(
  event: APIGatewayProxyEvent,
  tableIndex: number
): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return createErrorResponse(401, 'Unauthorized');
  }

  const tableName = TABLE_INDICES[tableIndex];
  if (!tableName) {
    return createErrorResponse(400, 'Invalid table index');
  }

  if (!hasPermission(authContext.role, `${tableName}:read`)) {
    return createErrorResponse(403, 'Forbidden');
  }

  const itemId = event.pathParameters?.id;
  if (!itemId) {
    return createErrorResponse(400, 'Missing item ID');
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: itemId,
        },
      })
    );

    if (!result.Item) {
      return createErrorResponse(404, 'Item not found');
    }

    return createSuccessResponse(200, result.Item);
  } catch (error) {
    console.error('Error fetching item:', error);
    return createErrorResponse(500, 'Internal Server Error');
  }
}

async function handleCreateItem(
  event: APIGatewayProxyEvent,
  tableIndex: number
): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return createErrorResponse(401, 'Unauthorized');
  }

  const tableName = TABLE_INDICES[tableIndex];
  if (!tableName) {
    return createErrorResponse(400, 'Invalid table index');
  }

  if (!hasPermission(authContext.role, `${tableName}:create`)) {
    return createErrorResponse(403, 'Forbidden');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const now = Date.now();
    const itemId = randomUUID();

    const item = {
      ...body,
      pk: tableName,
      sk: itemId,
      id: itemId,
      createdAt: now,
      updatedAt: now,
      createdBy: authContext.userId,
      updatedBy: authContext.userId,
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    await writeAuditLog(
      authContext.userId,
      'CREATE',
      tableName,
      itemId,
      { item }
    );

    return createSuccessResponse(201, item);
  } catch (error) {
    console.error('Error creating item:', error);
    return createErrorResponse(500, 'Internal Server Error');
  }
}

async function handleUpdateItem(
  event: APIGatewayProxyEvent,
  tableIndex: number
): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return createErrorResponse(401, 'Unauthorized');
  }

  const tableName = TABLE_INDICES[tableIndex];
  if (!tableName) {
    return createErrorResponse(400, 'Invalid table index');
  }

  if (!hasPermission(authContext.role, `${tableName}:update`)) {
    return createErrorResponse(403, 'Forbidden');
  }

  const itemId = event.pathParameters?.id;
  if (!itemId) {
    return createErrorResponse(400, 'Missing item ID');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const now = Date.now();

    const updateExpressionParts: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};

    Object.entries(body).forEach(([key, value], index) => {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      updateExpressionParts.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = value;
    });

    updateExpressionParts.push('#updatedAt = :updatedAt');
    updateExpressionParts.push('#updatedBy = :updatedBy');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeNames['#updatedBy'] = 'updatedBy';
    expressionAttributeValues[':updatedAt'] = now;
    expressionAttributeValues[':updatedBy'] = authContext.userId;

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: itemId,
        },
        UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    await writeAuditLog(
      authContext.userId,
      'UPDATE',
      tableName,
      itemId,
      { changes: body }
    );

    return createSuccessResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating item:', error);
    return createErrorResponse(500, 'Internal Server Error');
  }
}

async function handleDeleteItem(
  event: APIGatewayProxyEvent,
  tableIndex: number
): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return createErrorResponse(401, 'Unauthorized');
  }

  const tableName = TABLE_INDICES[tableIndex];
  if (!tableName) {
    return createErrorResponse(400, 'Invalid table index');
  }

  if (!hasPermission(authContext.role, `${tableName}:delete`)) {
    return createErrorResponse(403, 'Forbidden');
  }

  const itemId = event.pathParameters?.id;
  if (!itemId) {
    return createErrorResponse(400, 'Missing item ID');
  }

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: itemId,
        },
      })
    );

    await writeAuditLog(
      authContext.userId,
      'DELETE',
      tableName,
      itemId
    );

    return createSuccessResponse(204, { message: 'Item deleted' });
  } catch (error) {
    console.error('Error deleting item:', error);
    return createErrorResponse(500, 'Internal Server Error');
  }
}

async function handleListItems(
  event: APIGatewayProxyEvent,
  tableIndex: number
): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return createErrorResponse(401, 'Unauthorized');
  }

  const tableName = TABLE_INDICES[tableIndex];
  if (!tableName) {
    return createErrorResponse(400, 'Invalid table index');
  }

  if (!hasPermission(authContext.role, `${tableName}:read`)) {
    return createErrorResponse(403, 'Forbidden');
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableName,
        },
        Limit: 100,
      })
    );

    return createSuccessResponse(200, {
      items: result.Items || [],
      count: result.Count || 0,
    });
  } catch (error) {
    console.error('Error listing items:', error);
    return createErrorResponse(500, 'Internal Server Error');
  }
}

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const path = event.path || '';
  const method = event.httpMethod || 'GET';

  console.log(`${method} ${path}`);

  if (path === '/resources' && method === 'GET') {
    return handleGetResources(event);
  }

  const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
  if (bulkMatch && method === 'POST') {
    const tableIndex = parseInt(bulkMatch[1], 10);
    return handleBulkImport(event, tableIndex);
  }

  const getMatch = path.match(/^\/api\/(\d+)\/([a-f0-9-]+)$/);
  if (getMatch && method === 'GET') {
    const tableIndex = parseInt(getMatch[1], 10);
    return handleGetItem(event, tableIndex);
  }

  const listMatch = path.match(/^\/api\/(\d+)$/);
  if (listMatch && method === 'GET') {
    const tableIndex = parseInt(listMatch[1], 10);
    return handleListItems(event, tableIndex);
  }

  if (listMatch && method === 'POST') {
    const tableIndex = parseInt(listMatch[1], 10);
    return handleCreateItem(event, tableIndex);
  }

  const updateMatch = path.match(/^\/api\/(\d+)\/([a-f0-9-]+)$/);
  if (updateMatch && method === 'PUT') {
    const tableIndex = parseInt(updateMatch[1], 10);
    return handleUpdateItem(event, tableIndex);
  }

  const deleteMatch = path.match(/^\/api\/(\d+)\/([a-f0-9-]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const tableIndex = parseInt(deleteMatch[1], 10);
    return handleDeleteItem(event, tableIndex);
  }

  return createErrorResponse(404, 'Not Found');
}