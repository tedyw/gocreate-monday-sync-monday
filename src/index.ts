/* eslint-disable no-console */

import express from "express";
import { EnvironmentVariablesManager, SecretsManager, Storage, Logger } from "@mondaycom/apps-sdk";

const MONDAY_API_URL = "https://api.monday.com/v2";
const TZ = "Europe/Stockholm";

type GoCreateCustomerInfo = {
  FirstName?: string;
  LastName?: string;
  MobileNumber?: string;
  Email?: string;
  CompanyName?: string;
};

type GoCreateByDateRangeResponse = {
  CustomerInfo?: GoCreateCustomerInfo[];
  IsValidResult?: boolean;
  ErrorCode?: string;
  ErrorMessage?: string;
};

const logger = new Logger("gocreate-monday-sync");

// Loads monday-code env vars into process.env at runtime
new EnvironmentVariablesManager({ updateProcessEnv: true });

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}
function getEnvBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(v.toLowerCase());
}
function getEnvInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function isoNowUtc(): string {
  return new Date().toISOString();
}
function isoDaysAgoUtc(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function isValidIsoDate(s: string): boolean {
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(s);
}

/**
 * Returns time parts in Europe/Stockholm without extra deps.
 */
function stockholmParts(date = new Date()): { yyyyMMdd: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});

  const yyyy = parts.year;
  const mm = parts.month;
  const dd = parts.day;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);

  return { yyyyMMdd: `${yyyy}-${mm}-${dd}`, hour, minute };
}

class MondayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MondayAuthError";
  }
}

async function mondayGraphql<T>(token: string, query: string, variables?: Record<string, any>): Promise<T> {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new MondayAuthError(`monday auth failed HTTP ${res.status}: ${body}`);
  }

  if (!res.ok) throw new Error(`monday HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json() as any;

  if (json?.errors?.length) {
    const msg = json.errors.map((e: any) => e.message).join(" | ");
    if (/unauthorized|authentication|not authorized|invalid token/i.test(msg)) {
      throw new MondayAuthError(`monday auth failed (GraphQL): ${msg}`);
    }
    throw new Error(`monday GraphQL: ${msg}`);
  }

  if (!json?.data) throw new Error("monday: missing data");
  return json.data as T;
}

async function mondayFindItemByColumnValue(args: {
  token: string;
  boardId: number;
  columnId: string;
  value: string;
}): Promise<{ id: string; name: string } | undefined> {
  const query = `
    query ($board_id: ID!, $column_id: String!, $column_value: String!) {
      items_page_by_column_values(
        board_id: $board_id,
        columns: [{column_id: $column_id, column_values: [$column_value]}],
        limit: 1
      ) { items { id name } }
    }
  `;

  const data = await mondayGraphql<{
    items_page_by_column_values: { items: Array<{ id: string; name: string }> };
  }>(args.token, query, {
    board_id: String(args.boardId),
    column_id: args.columnId,
    column_value: args.value,
  });

  return data.items_page_by_column_values.items[0];
}

async function mondayCreateItem(args: {
  token: string;
  boardId: number;
  groupId: string;
  itemName: string;
  columnValues: Record<string, any>;
}): Promise<string> {
  const query = `
    mutation ($board_id: ID!, $group_id: String!, $item_name: String!, $column_values: JSON!) {
      create_item(board_id: $board_id, group_id: $group_id, item_name: $item_name, column_values: $column_values) { id }
    }
  `;

  const data = await mondayGraphql<{ create_item: { id: string } }>(args.token, query, {
    board_id: String(args.boardId),
    group_id: args.groupId,
    item_name: args.itemName,
    column_values: JSON.stringify(args.columnValues),
  });

  return data.create_item.id;
}

async function mondayUpdateItemColumns(args: {
  token: string;
  boardId: number;
  itemId: string;
  columnValues: Record<string, any>;
}): Promise<void> {
  const query = `
    mutation ($board_id: ID!, $item_id: ID!, $column_values: JSON!) {
      change_multiple_column_values(board_id: $board_id, item_id: $item_id, column_values: $column_values) { id }
    }
  `;

  await mondayGraphql<{ change_multiple_column_values: { id: string } }>(args.token, query, {
    board_id: String(args.boardId),
    item_id: String(args.itemId),
    column_values: JSON.stringify(args.columnValues),
  });
}

async function goCreateFetchCustomersByDateRange(args: {
  baseUrl: string;
  startISO: string;
  endISO: string;
  userName: string;
  password: string;
  authToken: string;
}): Promise<GoCreateCustomerInfo[]> {
  const url = new URL("/Customer/ByDateRange/", args.baseUrl);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      DateTime: args.startISO,
      EndDateTime: args.endISO,
      UserName: args.userName,
      Password: args.password,
      AuthenticationToken: args.authToken,
    }),
  });

  if (!res.ok) throw new Error(`GoCreate HTTP ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as GoCreateByDateRangeResponse;

  if (json.IsValidResult === false) {
    throw new Error(`GoCreate invalid result: ${(json.ErrorCode ?? "").trim()} ${(json.ErrorMessage ?? "").trim()}`.trim());
  }

  return json.CustomerInfo ?? [];
}

type RuntimeSecrets = {
  mondayAccessToken: string;
  gocreateBaseUrl: string;
  gocreateUsername: string;
  gocreatePassword: string;
  gocreateAuthToken: string;
};

async function getSecrets(): Promise<RuntimeSecrets> {
  const secrets = new SecretsManager();

  const mondayAccessToken = await secrets.get("MONDAY_ACCESS_TOKEN");
  const gocreateUsername = await secrets.get("GOCREATE_USERNAME");
  const gocreatePassword = await secrets.get("GOCREATE_PASSWORD");
  const gocreateAuthToken = await secrets.get("GOCREATE_AUTH_TOKEN");
  const gocreateBaseUrl = (await secrets.get("GOCREATE_BASE_URL")) ?? "http://api.gocreate.nu";

  if (!mondayAccessToken) throw new Error("Missing secret: MONDAY_ACCESS_TOKEN");
  if (!gocreateUsername || !gocreatePassword || !gocreateAuthToken) {
    throw new Error("Missing GoCreate secrets: GOCREATE_USERNAME / GOCREATE_PASSWORD / GOCREATE_AUTH_TOKEN");
  }

  return { mondayAccessToken, gocreateBaseUrl, gocreateUsername, gocreatePassword, gocreateAuthToken } as RuntimeSecrets;
}

async function runSync(opts: { force: boolean }): Promise<any> {
  const dryRun = getEnvBool("DRY_RUN", false);
  const updateExisting = getEnvBool("UPDATE_EXISTING", true);
  const lookbackDays = getEnvInt("LOOKBACK_DAYS", 1);

  // DST-safe gating: only run at 23:59 Stockholm time (unless forced).
  const now = new Date();
  const { yyyyMMdd, hour, minute } = stockholmParts(now);
  if (!opts.force && !(hour === 23 && minute === 59)) return { skipped: true };

  const secrets = await getSecrets();
  const mondayToken = secrets.mondayAccessToken;

  const boardId = Number(mustGetEnv("MONDAY_BOARD_ID"));
  const groupId = mustGetEnv("MONDAY_GROUP_ID");

  const colEmail = mustGetEnv("MONDAY_COL_EMAIL");
  const colTelefon = mustGetEnv("MONDAY_COL_TELEFON");
  const colForetag = mustGetEnv("MONDAY_COL_FORETAG");

  const storage = new Storage(mondayToken);

  // Run-once-per-day guard (Stockholm calendar date) — only for scheduled runs, not forced runs
  const ranKey = "sync:lastRunDateStockholm";
  if (!opts.force) {
    const already = await storage.get(ranKey);
    if (already?.success && already.value === yyyyMMdd) return { skipped: true, alreadyRan: true, date: yyyyMMdd };
  }

  // Date window
  const lastRunKey = "sync:lastRunISO";
  const stored = await storage.get(lastRunKey);
  const storedLastRun = stored?.success ? (stored.value as string | undefined) : undefined;

  const startISO = storedLastRun && isValidIsoDate(storedLastRun) ? storedLastRun : isoDaysAgoUtc(lookbackDays);
  const endISO = isoNowUtc();

  const customers = await goCreateFetchCustomersByDateRange({
    baseUrl: secrets.gocreateBaseUrl,
    startISO,
    endISO,
    userName: secrets.gocreateUsername,
    password: secrets.gocreatePassword,
    authToken: secrets.gocreateAuthToken,
  });

  let created = 0;
  let updated = 0;
  let skippedExisting = 0;
  let skippedNoEmail = 0;
  const errors: Array<{ email?: string; error: string }> = [];

  for (const c of customers) {
    try {
      const emailRaw = (c.Email ?? "").trim();
      if (!emailRaw) {
        skippedNoEmail++;
        continue;
      }
      const email = emailRaw.toLowerCase();

      const firstName = (c.FirstName ?? "").trim();
      const lastName = (c.LastName ?? "").trim();
      const itemName = `${firstName} ${lastName}`.trim() || email;

      const mobile = (c.MobileNumber ?? "").trim();
      const company = (c.CompanyName ?? "").trim();

      const columnValues: Record<string, any> = {
        [colTelefon]: mobile,
        [colEmail]: email,
        [colForetag]: company,
      };

      const found = await mondayFindItemByColumnValue({ token: mondayToken, boardId, columnId: colEmail, value: email });

      if (!found) {
        if (!dryRun) await mondayCreateItem({ token: mondayToken, boardId, groupId, itemName, columnValues });
        created++;
      } else {
        if (!updateExisting) {
          skippedExisting++;
        } else {
          if (!dryRun) await mondayUpdateItemColumns({ token: mondayToken, boardId, itemId: found.id, columnValues });
          updated++;
        }
      }

      await sleep(120);
    } catch (e: any) {
      // Bubble up auth errors immediately (no partial runs if token is dead)
      if (e?.name === "MondayAuthError") throw e;
      errors.push({ email: (c as any)?.Email, error: String(e?.message ?? e) });
    }
  }

  const nowISO = isoNowUtc();
  const result = {
    tz: TZ,
    stockholmDate: yyyyMMdd,
    forced: opts.force,
    window: { startISO, endISO },
    fetched: customers.length,
    created,
    updated,
    skippedExisting,
    skippedNoEmail,
    errors,
    finishedUtc: nowISO,
  };

  logger.info("sync finished");

  // Advance state only on full success and not dry-run, and only when not forced.
  if (!opts.force && !dryRun && errors.length === 0) {
    await storage.set(lastRunKey, nowISO);
    await storage.set(ranKey, yyyyMMdd);
  }

  return result;
}

// ---- HTTP server ----
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Cron endpoint (scheduler calls POST /mndy-cronjob/*)
app.post("/mndy-cronjob/sync-customers", async (_req, res) => {
  try {
    const out = await runSync({ force: false });
    if (out?.skipped) return res.status(204).send();
    return res.status(200).json(out);
  } catch (e: any) {
    if (e?.name === "MondayAuthError") {
      logger.error("MONDAY AUTH ERROR - rotate MONDAY_ACCESS_TOKEN secret");
    } else {
      logger.error("sync failed", { error: e });
    }
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Manual run endpoint (protected)
app.post("/manual/run", async (_req, res) => {
  const key = getEnv("MANUAL_RUN_KEY");
  if (!key) return res.status(404).send(); // disabled
  if ((res.req?.headers["x-manual-run-key"] ?? "") !== key) return res.status(403).json({ error: "Forbidden" });

  try {
    const out = await runSync({ force: true });
    return res.status(200).json(out);
  } catch (e: any) {
    if (e?.name === "MondayAuthError") {
      logger.error("MONDAY AUTH ERROR - rotate MONDAY_ACCESS_TOKEN secret");
    } else {
      logger.error("manual sync failed");
    }
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => logger.info(`Server listening on port: ${port}`));
