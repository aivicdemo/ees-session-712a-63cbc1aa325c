import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { extractAuthContext, checkPermission, Role } from './rbac';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'SalesManagementTable';

interface ApiResponse {
  statusCode: number;
  body: string;
}

function response(statusCode: number, data: unknown): ApiResponse {
  return {
    statusCode,
    body: JSON.stringify(data),
  };
}

function errorResponse(statusCode: number, message: string): ApiResponse {
  return response(statusCode, { error: message });
}

async function auditLog(
  userId: string,
  operationType: string,
  tableName: string,
  recordId: string,
  details: Record<string, unknown>
): Promise<void> {
  const auditEntry = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    userId,
    operationType,
    tableName,
    recordId,
    timestamp: new Date().toISOString(),
    ...details,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: auditEntry }));
}

async function getResource(id: string, resourceType: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: resourceType, sk: id },
      })
    );
    return result.Item || null;
  } catch (error) {
    console.error('Error getting resource:', error);
    return null;
  }
}

async function listResources(
  resourceType: string,
  limit: number = 100,
  lastEvaluatedKey?: Record<string, unknown>
): Promise<{ items: Record<string, unknown>[]; lastEvaluatedKey?: Record<string, unknown> }> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': resourceType },
        Limit: limit,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    return {
      items: result.Items || [],
      lastEvaluatedKey: result.LastEvaluatedKey,
    };
  } catch (error) {
    console.error('Error listing resources:', error);
    return { items: [] };
  }
}

async function createResource(
  resourceType: string,
  data: Record<string, unknown>,
  userId: string
): Promise<Record<string, unknown>> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const item = {
    pk: resourceType,
    sk: id,
    id,
    ...data,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    updatedBy: userId,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  await auditLog(userId, 'CREATE', resourceType, id, { data });
  return item;
}

async function updateResource(
  resourceType: string,
  id: string,
  data: Record<string, unknown>,
  userId: string
): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString();
  const updateData = {
    ...data,
    updatedAt: now,
    updatedBy: userId,
  };

  const updateExpression = Object.keys(updateData)
    .map((key, index) => `${key} = :val${index}`)
    .join(', ');
  const expressionAttributeValues = Object.entries(updateData).reduce(
    (acc, [key, value], index) => {
      acc[`:val${index}`] = value;
      return acc;
    },
    {} as Record<string, unknown>
  );

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: resourceType, sk: id },
        UpdateExpression: `SET ${updateExpression}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );
    await auditLog(userId, 'UPDATE', resourceType, id, { data });
    return result.Attributes || null;
  } catch (error) {
    console.error('Error updating resource:', error);
    return null;
  }
}

async function deleteResource(
  resourceType: string,
  id: string,
  userId: string
): Promise<boolean> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: resourceType, sk: id },
      })
    );
    await auditLog(userId, 'DELETE', resourceType, id, {});
    return true;
  } catch (error) {
    console.error('Error deleting resource:', error);
    return false;
  }
}

async function bulkImport(
  resourceType: string,
  items: Record<string, unknown>[],
  userId: string
): Promise<{ imported: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  let failed = 0;
  const now = new Date().toISOString();

  const processedItems = items.map((item) => ({
    PutRequest: {
      Item: {
        pk: resourceType,
        sk: item.id || randomUUID(),
        ...item,
        createdAt: item.createdAt || now,
        updatedAt: item.updatedAt || now,
        createdBy: item.createdBy || userId,
        updatedBy: item.updatedBy || userId,
      },
    },
  }));

  for (let i = 0; i < processedItems.length; i += 25) {
    const batch = processedItems.slice(i, i + 25);
    try {
      const result = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: batch,
          },
        })
      );
      imported += batch.length - (result.UnprocessedItems?.[TABLE_NAME]?.length || 0);
      failed += result.UnprocessedItems?.[TABLE_NAME]?.length || 0;
      if (result.UnprocessedItems?.[TABLE_NAME]?.length) {
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${result.UnprocessedItems[TABLE_NAME].length} items unprocessed`);
      }
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await auditLog(userId, 'BULK_IMPORT', resourceType, 'bulk', { count: imported, failed });
  return { imported, failed, errors };
}

const TABLE_TYPES: Record<string, string> = {
  '0': 'CUSTOMER',
  '1': 'ORDER',
  '2': 'ORDER_DETAIL',
  '3': 'SUPPLIER',
  '4': 'PURCHASE',
  '5': 'PURCHASE_DETAIL',
  '6': 'DELIVERY',
  '7': 'DELIVERY_DETAIL',
  '8': 'INVOICE',
  '9': 'INVOICE_DETAIL',
  '10': 'INVENTORY',
  '11': 'INVENTORY_ALLOCATION',
  '12': 'PRODUCT',
  '13': 'SALES_FLOW_ANOMALY',
  '14': 'PURCHASE_FLOW_ANOMALY',
  '15': 'ANOMALY_NOTIFICATION_LOG',
  '16': 'ALTERNATIVE_SUPPLIER',
  '17': 'DELIVERY_DATE_ADJUSTMENT',
  '18': 'USER',
};

const PERMISSION_MAP: Record<string, string> = {
  CUSTOMER: 'customer',
  ORDER: 'order',
  ORDER_DETAIL: 'orderDetail',
  SUPPLIER: 'supplier',
  PURCHASE: 'purchase',
  PURCHASE_DETAIL: 'purchaseDetail',
  DELIVERY: 'delivery',
  DELIVERY_DETAIL: 'deliveryDetail',
  INVOICE: 'invoice',
  INVOICE_DETAIL: 'invoiceDetail',
  INVENTORY: 'inventory',
  INVENTORY_ALLOCATION: 'inventoryAllocation',
  PRODUCT: 'product',
  SALES_FLOW_ANOMALY: 'salesFlowAnomaly',
  PURCHASE_FLOW_ANOMALY: 'purchaseFlowAnomaly',
  ANOMALY_NOTIFICATION_LOG: 'anomalyNotificationLog',
  ALTERNATIVE_SUPPLIER: 'alternativeSupplier',
  DELIVERY_DATE_ADJUSTMENT: 'deliveryDateAdjustment',
  USER: 'user',
};

export async function handler(event: APIGatewayProxyEvent): Promise<ApiResponse> {
  try {
    const authContext = extractAuthContext(event);
    const path = event.path || '';
    const method = event.httpMethod || 'GET';
    const pathParts = path.split('/').filter(Boolean);

    if (path === '/resources' && method === 'GET') {
      checkPermission(authContext.role, 'customer:read');
      const result = await listResources('CUSTOMER', 100);
      return response(200, result);
    }

    if (pathParts[0] === 'api' && pathParts[2] === 'bulk' && method === 'POST') {
      const tableIndex = pathParts[1];
      const resourceType = TABLE_TYPES[tableIndex];

      if (!resourceType) {
        return errorResponse(400, 'Invalid table index');
      }

      const permissionKey = PERMISSION_MAP[resourceType];
      checkPermission(authContext.role, `${permissionKey}:bulk`);

      if (authContext.role === 'viewer') {
        return errorResponse(403, 'Viewers cannot perform bulk operations');
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];

      if (!Array.isArray(items)) {
        return errorResponse(400, 'Items must be an array');
      }

      const result = await bulkImport(resourceType, items, authContext.userId);
      return response(200, result);
    }

    if (pathParts[0] === 'api' && pathParts[2] && method === 'GET') {
      const tableIndex = pathParts[1];
      const resourceId = pathParts[2];
      const resourceType = TABLE_TYPES[tableIndex];

      if (!resourceType) {
        return errorResponse(400, 'Invalid table index');
      }

      const permissionKey = PERMISSION_MAP[resourceType];
      checkPermission(authContext.role, `${permissionKey}:read`);

      const resource = await getResource(resourceId, resourceType);
      if (!resource) {
        return errorResponse(404, 'Resource not found');
      }
      return response(200, resource);
    }

    if (pathParts[0] === 'api' && pathParts[1] && method === 'GET') {
      const tableIndex = pathParts[1];
      const resourceType = TABLE_TYPES[tableIndex];

      if (!resourceType) {
        return errorResponse(400, 'Invalid table index');
      }

      const permissionKey = PERMISSION_MAP[resourceType];
      checkPermission(authContext.role, `${permissionKey}:read`);

      const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 100;
      const result = await listResources(resourceType, limit);
      return response(200, result);
    }

    if (pathParts[0] === 'api' && pathParts[1] && method === 'POST') {
      const tableIndex = pathParts[1];
      const resourceType = TABLE_TYPES[tableIndex];

      if (!resourceType) {
        return errorResponse(400, 'Invalid table index');
      }

      const permissionKey = PERMISSION_MAP[resourceType];
      checkPermission(authContext.role, `${permissionKey}:create`);

      const body = JSON.parse(event.body || '{}');
      const resource = await createResource(resourceType, body, authContext.userId);
      return response(201, resource);
    }

    if (pathParts[0] === 'api' && pathParts[2] && method === 'PUT') {
      const tableIndex = pathParts[1];
      const resourceId = pathParts[2];
      const resourceType = TABLE_TYPES[tableIndex];

      if (!resourceType) {
        return errorResponse(400, 'Invalid table index');
      }

      const permissionKey = PERMISSION_MAP[resourceType];
      checkPermission(authContext.role, `${permissionKey}:update`);

      const body = JSON.parse(event.body || '{}');
      const resource = await updateResource(resourceType, resourceId, body, authContext.userId);
      if (!resource) {
        return errorResponse(404, 'Resource not found');
      }
      return response(200, resource);
    }

    if (pathParts[0] === 'api' && pathParts[2] && method === 'DELETE') {
      const tableIndex = pathParts[1];
      const resourceId = pathParts[2];
      const resourceType = TABLE_TYPES[tableIndex];

      if (!resourceType) {
        return errorResponse(400, 'Invalid table index');
      }

      const permissionKey = PERMISSION_MAP[resourceType];
      checkPermission(authContext.role, `${permissionKey}:delete`);

      const success = await deleteResource(resourceType, resourceId, authContext.userId);
      if (!success) {
        return errorResponse(404, 'Resource not found');
      }
      return response(204, {});
    }

    return errorResponse(404, 'Endpoint not found');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('FORBIDDEN')) {
      return errorResponse(403, error.message.replace('FORBIDDEN: ', ''));
    }
    console.error('Handler error:', error);
    return errorResponse(500, error instanceof Error ? error.message : 'Internal server error');
  }
}