#!/bin/bash
# AIVIC Backend Deploy Script — 販売・仕入統合管理システム
# 使い方: bash deploy.sh [--guided]
#
# 前提条件:
#   - AWS CLI と SAM CLI がインストール済み
#   - AWS credentials が設定済み
#   - git がインストール済み（config.js の自動コミット用）

set -e

STACK_NAME="aivic--------------"
REGION=${AWS_REGION:-ap-northeast-1}
GUIDED=${1:-""}

echo "=== AIVIC Backend Deploy ==="
echo "Stack: $STACK_NAME"
echo "Region: $REGION"
echo ""

cd "$(dirname "$0")"

# Lambda 依存パッケージインストール
echo "[1/4] Installing Lambda dependencies..."
cd lambda
npm install --production --no-package-lock 2>/dev/null || true
cd ..

# SAM ビルド
echo "[2/4] Building SAM application..."
sam build

# SAM デプロイ
echo "[3/4] Deploying to AWS..."
if [ "$GUIDED" = "--guided" ]; then
  sam deploy --guided --stack-name "$STACK_NAME" --region "$REGION" --capabilities CAPABILITY_IAM
else
  sam deploy \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset \
    --resolve-s3
fi

# API Gateway URL を取得して config.js を更新
echo "[4/4] Updating config.js with API URL..."
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$API_URL" ] || [ "$API_URL" = "None" ]; then
  echo "WARNING: Could not retrieve API URL from CloudFormation outputs."
  echo "  config.js は手動で更新してください。"
else
  echo "API URL: $API_URL"
  # config.js の REPLACE_WITH_API_URL を実際の URL に置換
  sed -i.bak "s|REPLACE_WITH_API_URL|$API_URL|g" ../config.js
  rm -f ../config.js.bak
  echo "config.js updated."

  # DynamoDB にサンプルデータを投入
  if [ -f "../api/data.json" ] && [ -f "../seed/seed.js" ]; then
    echo ""
    echo "Seeding DynamoDB with sample data..."
    cd ..
    npm install --prefix seed @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb 2>/dev/null || true
    AWS_REGION="$REGION" node seed/seed.js && echo "Seeding complete." || echo "WARNING: Seeding failed (DynamoDB tables may not exist yet)"
    cd backend
  fi

  # config.js を git コミット
  cd ..
  if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    git add config.js
    git diff --cached --quiet || git commit -m "chore: update API endpoint URL after deploy"
    git push origin HEAD 2>/dev/null && echo "config.js committed and pushed." || echo "WARNING: git push failed. 手動でconfig.jsをpushしてください。"
  fi
fi

echo ""
echo "=== Deploy complete! ==="
echo "フロントエンド（Amplify）が config.js の更新を検知して再デプロイされます。"
