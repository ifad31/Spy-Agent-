// ============================================================
// SPY AGENT — session-cron (SELF-CONTAINED)
// Triggered every 1 minute via Supabase Scheduled Functions
// ============================================================

// ── ENV ────────────────────────────────────────────────────
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN             = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

// ── CONSTANTS ──────────────────────────────────────────────
const MAX_LINKS_PER_SEASON = 100;
const MAX_SEASONS_PER_DAY  = 4;

const DEFAULT_SCHEDULE = [
  { n: 1, oH: 6,  oM: 0,  cH: 7,  cM: 0  },
  { n: 2, oH: 10, oM: 0,  cH: 11, cM: 0  },
  { n: 3, oH: 13, oM: 30, cH: 14, cM: 30 },
  { n: 4, oH: 17, oM: 30, cH: 18, cM: 30 },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

// ── SUPABASE ───────────────────────────────────────────────
function sbHeaders() {
  return {
    "apikey":        SUPABASE_SERVICE_ROLE,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
  };
}

async function sbQuery(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...sbHeaders(), ...(opts.headers as Record<string,string> ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase [${path}] ${res.status}: ${body}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return res.json();
  return null;
}

// ── CONFIG ─────────────────────────────────────────────────
interface SlotDef { n: number; oH: number; oM: number; cH: number; cM: number; }

interface BotConfig {
  group_id:            number;
  engage_topic:        number;
  topic_auto_enabled:  boolean;
  auto_manage_enabled: boolean;
  schedule:            SlotDef[];
  msg_open:            string | null;
  msg_rules:           string | null;
  msg_season_close:    string | null;
  msg_reminder:        string | null;
}

let _cfgCache: BotConfig | null = null;
let _cfgFetchedAt = 0;

async function getConfig(): Promise<BotConfig> {
  const now = Date.now();
  if (_cfgCache && now - _cfgFetchedAt < 30_000) return _cfgCache;

  const rows: { key: string; value: string }[] = await sbQuery("bot_config?select=key,value");
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  let schedule: SlotDef[] = DEFAULT_SCHEDULE;
  try {
    const parsed = JSON.parse(map.schedule ?? "[]");
    if (Array.isArray(parsed) && parsed.length) schedule = parsed;
  } catch { /* keep default */ }

  _cfgCache = {
    group_id:            Number(map.group_id ?? "-1"),
    engage_topic:        Number(map.engage_topic ?? "0"),
    topic_auto_enabled:  map.topic_auto_enabled  === "true",
    auto_manage_enabled: map.auto_manage_enabled === "true",
    schedule,
    msg_open:         map.msg_open         ?? null,
    msg_rules:        map.msg_rules        ?? null,
    msg_season_close: map.msg_season_close ?? null,
    msg_reminder:     map.msg_reminder     ?? null,
  };
  _cfgFetchedAt = now;
  return _cfgCache;
}

function tpl(template: string | null, vars: Record<string, string | number>): string | null {
  if (!template) return null;
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? String(vars[k]) : `{${k}}`);
}

// ── TELEGRAM ───────────────────────────────────────────────
async function tgApi(method: string, body: unknown) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error(`tgApi ${method}:`, JSON.stringify(data));
    return data;
  } catch (e) {
    console.error(`tgApi ${method} exception:`, e);
    return null;
  }
}

async function sendIfSet(chatId: number, text: string | null, threadId?: number) {
  if (!text) return null;
  return tgApi("sendMessage", {
    chat_id:    chatId,
    text,
    parse_mode: "Markdown",
    ...(threadId ? { message_thread_id: threadId } : {}),
  });
}

async function sendDM(chatId: number, text: string) {
  return tgApi("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

async function openTopic(groupId: number, threadId: number) {
  return tgApi("reopenForumTopic", { chat_id: groupId, message_thread_id: threadId });
}

async function closeTopic(groupId: number, threadId: number) {
  return tgApi("closeForumTopic", { chat_id: groupId, message_thread_id: threadId });
}

async function sendDocumentTopic(groupId: number, threadId: number, content: string, filename: string, caption: string) {
  try {
    const fd = new FormData();
    fd.append("chat_id",           String(groupId));
    fd.append("message_thread_id", String(threadId));
    fd.append("caption",           caption);
    fd.append("document", new Blob([content], { type: "text/plain" }), filename);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
    return res.json();
  } catch (e) {
    console.error("sendDocument error:", e);
    return null;
  }
}

// ── DATE HELPERS ───────────────────────────────────────────
function dateLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toMinutes(h: number, m: number): number {
  return h * 60 + m;
}

function utcMinutes(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ── SEASON HELPERS ─────────────────────────────────────────
async function getActiveSeason(): Promise<Record<string, unknown> | null> {
  const rows = await sbQuery("seasons?status=eq.active&order=started_at.desc&limit=1");
  return rows?.[0] ?? null;
}

async function computeNextSeasonNumber(): Promise<number | null> {
  const dl   = dateLabel(new Date());
  const rows = await sbQuery(`seasons?date_label=eq.${dl}&select=id`);
  const count = rows?.length ?? 0;
  if (count >= MAX_SEASONS_PER_DAY) return null;
  return count + 1;
}

// ── SEASON CLOSE FLOW ──────────────────────────────────────
async function runSeasonCloseFlow(season: Record<string, unknown>, cfg: BotConfig) {
  const seasonId = season.id as string;

  // Close all open sessions
  await sbQuery(`sessions?season_id=eq.${seasonId}&status=eq.open`, {
    method: "PATCH",
    body:   JSON.stringify({ status: "closed", close_msg_sent: true }),
  });

  // Count submissions
  const subs: Record<string, unknown>[] = await sbQuery(
    `submissions?season_id=eq.${seasonId}&select=id,telegram_id,x_username,tweet_url,submitted_at&order=submitted_at.asc`
  ) ?? [];
  const total  = subs.length;
  const unique = new Set(subs.map(s => s.telegram_id)).size;

  if (total === 0) {
    await sbQuery(`seasons?id=eq.${seasonId}`, {
      method: "PATCH",
      body:   JSON.stringify({ status: "closed", closed_at: new Date().toISOString() }),
    });
    return;
  }

  // Pick random vetting submission
  const vetSub     = subs[Math.floor(Math.random() * subs.length)];
  const vettingUrl = vetSub.tweet_url as string;

  // Update season
  await sbQuery(`seasons?id=eq.${seasonId}`, {
    method: "PATCH",
    body:   JSON.stringify({ status: "closed", closed_at: new Date().toISOString(), vetting_url: vettingUrl }),
  });

  // Insert verification_report (pending)
  const vrInsert = await sbQuery("verification_reports", {
    method: "POST",
    body:   JSON.stringify({
      season_id:          seasonId,
      vetting_tweet_url:  vettingUrl,
      vetting_tweet_owner: vetSub.x_username ?? null,
      total_submitted:    total,
      // Store exact original casing in submitted_usernames
      submitted_usernames: subs.map(s => s.x_username as string),
      status:             "pending",
    }),
  });
  const vrId = vrInsert?.[0]?.id as string | undefined;

  // target_usernames — exact original casing (yep_ifad stays yep_ifad)
  const targetUsernames: string[] = [
    ...new Map(
      subs.map(s => [( s.x_username as string).toLowerCase(), s.x_username as string])
    ).values()
  ];

  // Insert extension_state
  await sbQuery("extension_state", {
    method: "POST",
    body:   JSON.stringify({
      report_id:       vrId ?? null,
      season_id:       seasonId,
      vetting_url:     vettingUrl,
      target_usernames: targetUsernames,   // exact casing
      scan_status:     "ready",
    }),
  });

  // Send msg_season_close (if set)
  const closeText = tpl(cfg.msg_season_close, {
    season_number: season.season_number as number,
    total,
    unique,
    vetting_url: vettingUrl,
  });
  await sendIfSet(cfg.group_id, closeText, cfg.engage_topic);

  // Export .txt — always, regardless of topic_auto_enabled
  const txtLines = subs.map((s, i) => `${i + 1}. @${s.x_username} - ${s.tweet_url}`).join("\n");
  sendDocumentTopic(
    cfg.group_id,
    cfg.engage_topic,
    txtLines,
    `season_${season.season_number}_links.txt`,
    `📄 Season ${season.season_number} — All Links (${total})`,
  ).catch(e => console.error("sendDocument error:", e));
}

// ── MAIN AUTO SESSION LOGIC ────────────────────────────────
async function runAutoSession() {
  const cfg = await getConfig();
  if (!cfg.auto_manage_enabled) return;

  const now    = new Date();
  const dl     = dateLabel(now);
  const nowMin = utcMinutes(now);

  // ── STEP A: 5-min reminder ─────────────────────────────
  for (const slot of cfg.schedule) {
    if (toMinutes(slot.oH, slot.oM) - nowMin === 5) {
      const users: { telegram_id: number }[] = await sbQuery(
        "user_reminders?enabled=eq.true&select=telegram_id"
      ) ?? [];
      for (const u of users) {
        sendIfSet(u.telegram_id, cfg.msg_reminder).catch(() => {});
      }
    }
  }

  // ── STEP B: SLOT OPEN ──────────────────────────────────
  for (const slot of cfg.schedule) {
    if (toMinutes(slot.oH, slot.oM) !== nowMin) continue;

    // Duplicate guard: already opened this slot today?
    const existing = await sbQuery(
      `sessions?date_label=eq.${dl}&session_number=eq.${slot.n}&open_msg_sent=eq.true&limit=1`
    );
    if (existing?.length) break;

    // Safety-net: close any lingering active season first
    const activeSeason = await getActiveSeason();
    if (activeSeason) await runSeasonCloseFlow(activeSeason, cfg);

    // Day cap check
    const nextNum = await computeNextSeasonNumber();
    if (nextNum === null) {
      console.log(`Day cap (${MAX_SEASONS_PER_DAY}) reached for ${dl}, skipping.`);
      break;
    }

    const opensAt  = new Date(now); opensAt.setUTCHours(slot.oH, slot.oM, 0, 0);
    const closesAt = new Date(now); closesAt.setUTCHours(slot.cH, slot.cM, 0, 0);

    // Create season
    const seasonRow = await sbQuery("seasons", {
      method: "POST",
      body:   JSON.stringify({
        season_number: nextNum,
        status:        "active",
        started_at:    now.toISOString(),
        date_label:    dl,
      }),
    });
    const newSeason = seasonRow?.[0];
    if (!newSeason) break;

    // Create session
    await sbQuery("sessions", {
      method: "POST",
      body:   JSON.stringify({
        season_id:      newSeason.id,
        session_number: slot.n,
        date_label:     dl,
        opens_at:       opensAt.toISOString(),
        closes_at:      closesAt.toISOString(),
        status:         "open",
        open_msg_sent:  true,
      }),
    });

    // Topic visual layer
    if (cfg.topic_auto_enabled) {
      await openTopic(cfg.group_id, cfg.engage_topic);
      await sendIfSet(cfg.group_id, cfg.msg_open, cfg.engage_topic);
    }
    break;
  }

  // ── STEP C: SLOT CLOSE ─────────────────────────────────
  for (const slot of cfg.schedule) {
    if (toMinutes(slot.cH, slot.cM) !== nowMin) continue;

    const activeSeason = await getActiveSeason();
    if (!activeSeason) break;

    const sessRows: Record<string, unknown>[] = await sbQuery(
      `sessions?season_id=eq.${activeSeason.id}&session_number=eq.${slot.n}&status=eq.open&close_msg_sent=eq.false&limit=1`
    ) ?? [];
    if (!sessRows.length) break;

    // Mark session closed
    await sbQuery(`sessions?id=eq.${sessRows[0].id}`, {
      method: "PATCH",
      body:   JSON.stringify({ status: "closed", close_msg_sent: true }),
    });

    if (cfg.topic_auto_enabled) {
      await sendIfSet(cfg.group_id, cfg.msg_rules, cfg.engage_topic);
      await closeTopic(cfg.group_id, cfg.engage_topic);
    }

    await runSeasonCloseFlow(activeSeason, cfg);
    break;
  }

  // ── STEP D: Safety-net force-close overdue sessions ────
  const staleSessions: Record<string, unknown>[] = await sbQuery(
    `sessions?status=eq.open&closes_at=lt.${now.toISOString()}&select=id,season_id`
  ) ?? [];

  for (const sess of staleSessions) {
    await sbQuery(`sessions?id=eq.${sess.id}`, {
      method: "PATCH",
      body:   JSON.stringify({ status: "closed", close_msg_sent: true }),
    });
    const seasonRows: Record<string, unknown>[] = await sbQuery(
      `seasons?id=eq.${sess.season_id}&status=eq.active&limit=1`
    ) ?? [];
    if (seasonRows.length) {
      await runSeasonCloseFlow(seasonRows[0], cfg).catch(e =>
        console.error("force-close runSeasonCloseFlow error:", e)
      );
    }
  }
}

// ── SERVE ──────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    await runAutoSession();
    return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("session-cron error:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status:  500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
