-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('HTTP', 'EMAIL', 'SLACK', 'TELEGRAM', 'SCADA_OPC');

-- AlterTable
ALTER TABLE "webhook_subscriptions" ADD COLUMN "type" "NotificationChannelType" NOT NULL DEFAULT 'HTTP';
ALTER TABLE "webhook_subscriptions" ADD COLUMN "config" JSONB;
ALTER TABLE "webhook_subscriptions" ALTER COLUMN "url" DROP NOT NULL;
