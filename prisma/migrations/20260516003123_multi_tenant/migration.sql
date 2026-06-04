-- CreateTable ManagedClient
CREATE TABLE "managed_clients" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "registration_number" TEXT,
    "monitored" BOOLEAN NOT NULL DEFAULT false,
    "response_company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "managed_clients_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "managed_clients_monitored_idx" ON "managed_clients"("monitored");
CREATE INDEX "managed_clients_registration_number_idx" ON "managed_clients"("registration_number");

-- CreateTable HubClientLink
CREATE TABLE "hub_client_links" (
    "id" UUID NOT NULL,
    "hub_id" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hub_client_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hub_client_links_hub_id_key" ON "hub_client_links"("hub_id");
CREATE INDEX "hub_client_links_client_id_idx" ON "hub_client_links"("client_id");
ALTER TABLE "hub_client_links" ADD CONSTRAINT "hub_client_links_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "managed_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable UserClientAccess
CREATE TABLE "user_client_access" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_client_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_client_access_user_id_client_id_key" ON "user_client_access"("user_id","client_id");
CREATE INDEX "user_client_access_user_id_idx" ON "user_client_access"("user_id");
CREATE INDEX "user_client_access_client_id_idx" ON "user_client_access"("client_id");
ALTER TABLE "user_client_access" ADD CONSTRAINT "user_client_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_client_access" ADD CONSTRAINT "user_client_access_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "managed_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
