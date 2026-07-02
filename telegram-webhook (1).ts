// ============================================================
// SPY AGENT — telegram-webhook (SELF-CONTAINED)
// Paste this entire file into Supabase Edge Function editor
// ============================================================

// ── ENV ────────────────────────────────────────────────────
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN             = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const BOT_USERNAME          = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "";

const _adminIds = (Deno.env.get("ADMIN_IDS") ?? "")
  .split(",").map(s => s.trim()).filter(Boolean).map(Number);
const _ownerId  = Number(Deno.env.get("OWNER_ID") ?? "0");

function isAdmin(id: number): boolean { return id === _ownerId || _adminIds.includes(id); }
function isOwner(id: number): boolean { return id === _ownerId; }

// ── CONSTANTS ──────────────────────────────────────────────
const BOT_DISPLAY_NAME     = "Spy Agent";
const NO_PFP_URL           = "https://i.imgur.com/8zVzfhs.png"; // 100x100 grey placeholder
const EDIT_WINDOW_MINS     = 5;
const PAGE_SIZE            = 20;
const MAX_LINKS_PER_SEASON = 100;
const MAX_SEASONS_PER_DAY  = 4;

const DEFAULT_SCHEDULE = [
  { n: 1, oH: 6,  oM: 0,  cH: 7,  cM: 0  },
  { n: 2, oH: 10, oM: 0,  cH: 11, cM: 0  },
  { n: 3, oH: 13, oM: 30, cH: 14, cM: 30 },
  { n: 4, oH: 17, oM: 30, cH: 18, cM: 30 },
];

const REPORT_REASONS: Record<string, string> = {
  cant_reply: "🚫 Can't reply",
  spam:       "🚫 Spam",
  fake_link:  "🚫 Fake link",
  other:      "🚫 Other",
};

const MSG_KEY_MAP: Record<string, string> = {
  open:               "msg_open",
  rules:              "msg_rules",
  welcome:            "msg_welcome",
  season_start:       "msg_season_start",
  season_close:       "msg_season_close",
  submission_confirm: "msg_submission_confirm",
  reminder:           "msg_reminder",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

// ── TYPES ──────────────────────────────────────────────────
interface SlotDef { n: number; oH: number; oM: number; cH: number; cM: number; }

interface BotConfig {
  group_id:               number;
  engage_topic:           number;
  defaulters_topic:       number;
  report_topic:           number;
  group_invite_link:      string;
  sessions_per_day:       number;
  auto_manage_enabled:    boolean;
  topic_auto_enabled:     boolean;
  schedule:               SlotDef[];
  msg_open:               string | null;
  msg_rules:              string | null;
  msg_welcome:            string | null;
  msg_season_start:       string | null;
  msg_season_close:       string | null;
  msg_submission_confirm: string | null;
  msg_reminder:           string | null;
}

interface TgUser    { id: number; username?: string; first_name?: string; last_name?: string; }
interface TgChat    { id: number; type: string; }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  message_thread_id?: number;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id:       number;
  message?:        TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ── SUPABASE ───────────────────────────────────────────────
function sbHeaders() {
  return {
    "apikey":        SUPABASE_SERVICE_ROLE,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
  };
}

async function sbQuery(path: string, opts: RequestInit = {}): Promise<any> {
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
let _cfgCache: BotConfig | null = null;
let _cfgFetchedAt = 0;

async function getConfig(): Promise<BotConfig> {
  const now = Date.now();
  if (_cfgCache && now - _cfgFetchedAt < 10_000) return _cfgCache;

  const rows: { key: string; value: string }[] = await sbQuery("bot_config?select=key,value");
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  let schedule: SlotDef[] = DEFAULT_SCHEDULE;
  try {
    const parsed = JSON.parse(map.schedule ?? "[]");
    if (Array.isArray(parsed) && parsed.length) schedule = parsed;
  } catch { /* keep default */ }

  _cfgCache = {
    group_id:               Number(map.group_id          ?? "-1"),
    engage_topic:           Number(map.engage_topic      ?? "0"),
    defaulters_topic:       Number(map.defaulters_topic  ?? "0"),
    report_topic:           Number(map.report_topic      ?? "0"),
    group_invite_link:      map.group_invite_link        ?? Deno.env.get("GROUP_INVITE_LINK") ?? "",
    sessions_per_day:       Number(map.sessions_per_day  ?? "4"),
    auto_manage_enabled:    map.auto_manage_enabled      === "true",
    topic_auto_enabled:     map.topic_auto_enabled       === "true",
    schedule,
    msg_open:               map.msg_open               ?? null,
    msg_rules:              map.msg_rules              ?? null,
    msg_welcome:            map.msg_welcome            ?? null,
    msg_season_start:       map.msg_season_start       ?? null,
    msg_season_close:       map.msg_season_close       ?? null,
    msg_submission_confirm: map.msg_submission_confirm ?? null,
    msg_reminder:           map.msg_reminder           ?? null,
  };
  _cfgFetchedAt = now;
  return _cfgCache;
}

async function setConfigKey(key: string, value: string) {
  await sbQuery("bot_config", {
    method:  "POST",
    headers: { "Prefer": "resolution=merge-duplicates" },
    body:    JSON.stringify({ key, value }),
  });
  _cfgCache = null;
}

function tpl(template: string | null, vars: Record<string, string | number>): string | null {
  if (!template) return null;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
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

async function send(chatId: number, text: string, threadId?: number) {
  return tgApi("sendMessage", {
    chat_id:    chatId,
    text,
    parse_mode: "Markdown",
    ...(threadId ? { message_thread_id: threadId } : {}),
  });
}

async function delMsg(chatId: number, msgId: number) {
  return tgApi("deleteMessage", { chat_id: chatId, message_id: msgId });
}

async function openTopic(groupId: number, threadId: number) {
  return tgApi("reopenForumTopic", { chat_id: groupId, message_thread_id: threadId });
}

async function closeTopic(groupId: number, threadId: number) {
  return tgApi("closeForumTopic", { chat_id: groupId, message_thread_id: threadId });
}

async function editReplyMarkup(groupId: number, messageId: number, replyMarkup: unknown) {
  return tgApi("editMessageReplyMarkup", {
    chat_id: groupId, message_id: messageId, reply_markup: replyMarkup,
  });
}

async function answerCb(id: string, text?: string, alert = false) {
  return tgApi("answerCallbackQuery", {
    callback_query_id: id,
    ...(text ? { text, show_alert: alert } : {}),
  });
}

async function sendDM(chatId: number, text: string, replyMarkup?: unknown) {
  return tgApi("sendMessage", {
    chat_id:    chatId,
    text,
    parse_mode: "Markdown",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editDM(chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
  return tgApi("editMessageText", {
    chat_id:    chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function sendIfSet(chatId: number, text: string | null, threadId?: number, replyMarkup?: unknown) {
  if (!text) return null;
  return tgApi("sendMessage", {
    chat_id:    chatId,
    text,
    parse_mode: "Markdown",
    ...(threadId    ? { message_thread_id: threadId }  : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup }     : {}),
  });
}

async function getUserPhotoFileId(userId: number): Promise<string | null> {
  const res = await tgApi("getUserProfilePhotos", { user_id: userId, limit: 1 });
  if (!res?.ok || !res.result?.photos?.length) return null;
  const sizes = res.result.photos[0] as { file_id: string; width: number }[];
  // Sort by width ascending → pick the smallest available size
  const sorted = [...sizes].sort((a, b) => a.width - b.width);
  return sorted[0]?.file_id ?? null;
}

async function sendDocumentTopic(
  groupId: number, threadId: number,
  content: string, filename: string, caption: string
) {
  try {
    const fd = new FormData();
    fd.append("chat_id",           String(groupId));
    fd.append("message_thread_id", String(threadId));
    fd.append("caption",           caption);
    fd.append("document", new Blob([content], { type: "text/plain" }), filename);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
      method: "POST", body: fd,
    });
    return res.json();
  } catch (e) {
    console.error("sendDocumentTopic error:", e);
    return null;
  }
}

// ── URL / USERNAME PARSING ─────────────────────────────────
// Exact casing preserved — underscore never stripped
const X_RE    = /^https?:\/\/(x|twitter)\.com\/([A-Za-z0-9_]{1,50})\/status\/(\d+)$/i;
const LINK_RE = /https?:\/\/\S+/gi;

function parseXUrl(text: string): { url: string; username: string; tweetId: string } | null {
  const links = text.match(LINK_RE) ?? [];
  for (const raw of links) {
    // Strip query params, fragments, and trailing punctuation Telegram may include
    const clean = raw.split("?")[0].split("#")[0].replace(/[.,;:!?)]+$/, "");
    const m = clean.match(X_RE);
    // username group = m[2] — exact casing from URL (yep_ifad, see_ff etc.)
    if (m && m[2] !== "i") return { url: clean, username: m[2], tweetId: m[3] };
  }
  return null;
}

function hasInvalidLink(text: string): boolean {
  const links = text.match(LINK_RE) ?? [];
  for (const raw of links) {
    const clean = raw.split("?")[0].split("#")[0].replace(/[.,;:!?)]+$/, "");
    if (!clean.match(X_RE)) return true;
    const m = clean.match(X_RE);
    if (m && m[2] === "i") return true;
    // NOTE: query params (?s=xx etc.) and trailing punctuation stripped before matching
  }
  return false;
}

function linkCount(text: string): number {
  return (text.match(LINK_RE) ?? []).length;
}

// ── DATE HELPERS ───────────────────────────────────────────
function dateLabel(d: Date): string   { return d.toISOString().slice(0, 10); }
function toMinutes(h: number, m: number): number { return h * 60 + m; }
function utcMinutes(d: Date): number  { return d.getUTCHours() * 60 + d.getUTCMinutes(); }

// ── DISPLAY NAME ───────────────────────────────────────────
function displayName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
}

// ── SEASON HELPERS ─────────────────────────────────────────
async function getActiveSeason(): Promise<Record<string, unknown> | null> {
  const rows = await sbQuery("seasons?status=eq.active&order=started_at.desc&limit=1");
  return rows?.[0] ?? null;
}

async function getOpenSession(seasonId: string): Promise<Record<string, unknown> | null> {
  const rows = await sbQuery(`sessions?season_id=eq.${seasonId}&status=eq.open&limit=1`);
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

  await sbQuery(`sessions?season_id=eq.${seasonId}&status=eq.open`, {
    method: "PATCH",
    body:   JSON.stringify({ status: "closed", close_msg_sent: true }),
  });

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

  const vetSub     = subs[Math.floor(Math.random() * subs.length)];
  const vettingUrl = vetSub.tweet_url as string;

  await sbQuery(`seasons?id=eq.${seasonId}`, {
    method: "PATCH",
    body:   JSON.stringify({ status: "closed", closed_at: new Date().toISOString(), vetting_url: vettingUrl }),
  });

  const vrInsert = await sbQuery("verification_reports", {
    method: "POST",
    body:   JSON.stringify({
      season_id:           seasonId,
      vetting_tweet_url:   vettingUrl,
      vetting_tweet_owner: vetSub.x_username ?? null,
      total_submitted:     total,
      // exact original casing
      submitted_usernames: subs.map(s => s.x_username as string),
      status:              "pending",
    }),
  });
  const vrId = vrInsert?.[0]?.id as string | undefined;

  // target_usernames: deduplicated, exact original casing preserved
  const targetUsernames: string[] = [
    ...new Map(
      subs.map(s => [(s.x_username as string).toLowerCase(), s.x_username as string])
    ).values(),
  ];

  await sbQuery("extension_state", {
    method: "POST",
    body:   JSON.stringify({
      report_id:        vrId ?? null,
      season_id:        seasonId,
      vetting_url:      vettingUrl,
      target_usernames: targetUsernames,
      scan_status:      "ready",
    }),
  });

  const closeText = tpl(cfg.msg_season_close, {
    season_number: season.season_number as number,
    total,
    unique,
    vetting_url: vettingUrl,
  });
  await sendIfSet(cfg.group_id, closeText, cfg.engage_topic);

  // .txt export — always, regardless of topic_auto_enabled
  const txtLines = subs.map((s, i) => `${i + 1}. @${s.x_username} - ${s.tweet_url}`).join("\n");
  sendDocumentTopic(
    cfg.group_id,
    cfg.engage_topic,
    txtLines,
    `season_${season.season_number}_links.txt`,
    `📄 Season ${season.season_number} — All Links (${total})`,
  ).catch(e => console.error("sendDocument error:", e));
}

// ── AUTO SESSION (fire-and-forget from webhook) ────────────
async function runAutoSession() {
  const cfg = await getConfig();
  if (!cfg.auto_manage_enabled) return;

  const now    = new Date();
  const dl     = dateLabel(now);
  const nowMin = utcMinutes(now);

  // Step A: 5-min reminder
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

  // Step B: Slot open
  for (const slot of cfg.schedule) {
    if (toMinutes(slot.oH, slot.oM) !== nowMin) continue;

    const existing = await sbQuery(
      `sessions?date_label=eq.${dl}&session_number=eq.${slot.n}&open_msg_sent=eq.true&limit=1`
    );
    if (existing?.length) break;

    const activeSeason = await getActiveSeason();
    if (activeSeason) await runSeasonCloseFlow(activeSeason, cfg);

    const nextNum = await computeNextSeasonNumber();
    if (nextNum === null) break;

    const opensAt  = new Date(now); opensAt.setUTCHours(slot.oH, slot.oM, 0, 0);
    const closesAt = new Date(now); closesAt.setUTCHours(slot.cH, slot.cM, 0, 0);

    const seasonRow = await sbQuery("seasons", {
      method: "POST",
      body:   JSON.stringify({ season_number: nextNum, status: "active", started_at: now.toISOString(), date_label: dl }),
    });
    const newSeason = seasonRow?.[0];
    if (!newSeason) break;

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

    if (cfg.topic_auto_enabled) {
      await openTopic(cfg.group_id, cfg.engage_topic);
      await sendIfSet(cfg.group_id, cfg.msg_open, cfg.engage_topic);
    }
    break;
  }

  // Step C: Slot close
  for (const slot of cfg.schedule) {
    if (toMinutes(slot.cH, slot.cM) !== nowMin) continue;

    const activeSeason = await getActiveSeason();
    if (!activeSeason) break;

    const sessRows: Record<string, unknown>[] = await sbQuery(
      `sessions?season_id=eq.${activeSeason.id}&session_number=eq.${slot.n}&status=eq.open&close_msg_sent=eq.false&limit=1`
    ) ?? [];
    if (!sessRows.length) break;

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

  // Step D: Safety-net force-close overdue sessions
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
        console.error("force-close error:", e)
      );
    }
  }
}

// ── CARD ───────────────────────────────────────────────────
function buildCardCaption(postNumber: number, name: string, username: string, url: string): string {
  return `Post ${postNumber}\n\n👤 ${name}\n🆔 \`@${username}\`\n\n• ${url}`;
}

function buildCardKeyboard(submissionId: string, reportCount = 0) {
  return { inline_keyboard: [[{ text: `⚠️ Report (${reportCount})`, callback_data: `report:${submissionId}` }]] };
}

// ── ENSURE USER ────────────────────────────────────────────
async function ensureUser(from: TgUser) {
  await sbQuery("users", {
    method:  "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
    body:    JSON.stringify({
      telegram_id:       from.id,
      telegram_username: from.username ?? null,
      updated_at:        new Date().toISOString(),
    }),
  });
}

// ── SUBMISSION HANDLING ────────────────────────────────────
async function handleSubmission(msg: TgMessage, cfg: BotConfig) {
  const from = msg.from!;
  const text = msg.text ?? "";

  if (msg.message_thread_id !== cfg.engage_topic) return;
  if (linkCount(text) === 0) return;

  if (linkCount(text) > 1 || hasInvalidLink(text)) {
    await delMsg(msg.chat.id, msg.message_id);
    return;
  }

  const parsed = parseXUrl(text);
  if (!parsed) { await delMsg(msg.chat.id, msg.message_id); return; }

  const activeSeason = await getActiveSeason();
  if (!activeSeason) { await delMsg(msg.chat.id, msg.message_id); return; }

  const [countRows, openSession] = await Promise.all([
    sbQuery(`submissions?season_id=eq.${activeSeason.id}&select=id`) as Promise<{ id: string }[]>,
    getOpenSession(activeSeason.id as string),
  ]);
  const seasonCount = (countRows ?? []).length;

  if (seasonCount >= MAX_LINKS_PER_SEASON) { await delMsg(msg.chat.id, msg.message_id); return; }
  if (!openSession) { await delMsg(msg.chat.id, msg.message_id); return; }

  await delMsg(msg.chat.id, msg.message_id);

  const photoPromise = getUserPhotoFileId(from.id);

  let newSub: Record<string, unknown> | null = null;
  try {
    const inserted = await sbQuery("submissions", {
      method: "POST",
      body:   JSON.stringify({
        season_id:         activeSeason.id,
        session_id:        openSession.id,
        telegram_id:       from.id,
        telegram_username: from.username ?? null,
        // x_username stored EXACTLY as parsed from tweet URL
        // parseXUrl preserves: yep_ifad → yep_ifad, see_ff → see_ff
        x_username:        parsed.username,
        tweet_url:         parsed.url,
      }),
    });
    newSub = inserted?.[0] ?? null;
  } catch (e: any) {
    if (String(e).includes("23505")) return; // unique constraint — silent drop
    console.error("submission insert error:", e);
    return;
  }
  if (!newSub) return;

  // Update user's x_username (exact casing) — fire-and-forget, doesn't block the card
  sbQuery(`users?telegram_id=eq.${from.id}`, {
    method: "PATCH",
    body:   JSON.stringify({ x_username: parsed.username, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  const postNumber  = seasonCount + 1;
  const photoFileId = await photoPromise;
  const photo       = photoFileId ?? NO_PFP_URL;
  const name        = displayName(from);

  const caption  = buildCardCaption(postNumber, name, parsed.username, parsed.url);
  const keyboard = buildCardKeyboard(newSub.id as string, 0);

  const cardRes = await tgApi("sendPhoto", {
    chat_id:           cfg.group_id,
    message_thread_id: cfg.engage_topic,
    photo,
    caption,
    parse_mode:        "Markdown",
    reply_markup:      keyboard,
  });
  const cardMsgId = cardRes?.result?.message_id ?? null;

  if (cardMsgId) {
    await sbQuery(`submissions?id=eq.${newSub.id}`, {
      method: "PATCH",
      body:   JSON.stringify({ card_message_id: cardMsgId }),
    });
  }

  const confirmMsg = tpl(cfg.msg_submission_confirm, {
    session_number: postNumber,
    edit_window:    EDIT_WINDOW_MINS,
  });
  const manageBtn = {
    inline_keyboard: [[{
      text:          `✏️ Manage my S${activeSeason.season_number} link`,
      callback_data: "dm:manage",
    }]],
  };

  if (confirmMsg) {
    await sendDM(from.id, confirmMsg, manageBtn).catch(() => {});
  } else {
    await sendDM(from.id, `✅ Link submitted! (Post ${postNumber})`, manageBtn).catch(() => {});
  }
}

// ── USER DASHBOARD ─────────────────────────────────────────
async function sendUserDashboard(chatId: number, editMsgId?: number) {
  const cfg    = await getConfig();
  const now    = new Date();
  const nowMin = utcMinutes(now);

  const activeSeason = await getActiveSeason();
  const openSession  = activeSeason ? await getOpenSession(activeSeason.id as string) : null;

  const remRows: { enabled: boolean }[] = await sbQuery(
    `user_reminders?telegram_id=eq.${chatId}&select=enabled&limit=1`
  ) ?? [];
  const remEnabled = remRows.length ? remRows[0].enabled : true;

  let activeSubmission: Record<string, unknown> | null = null;
  let lastSubmission:   Record<string, unknown> | null = null;

  if (activeSeason) {
    const actRows = await sbQuery(
      `submissions?season_id=eq.${activeSeason.id}&telegram_id=eq.${chatId}&select=id,tweet_url,submitted_at&limit=1`
    ) ?? [];
    activeSubmission = actRows[0] ?? null;
  }
  if (!activeSubmission) {
    const lastRows = await sbQuery(
      `submissions?telegram_id=eq.${chatId}&order=submitted_at.desc&select=id,tweet_url,submitted_at,season_id&limit=1`
    ) ?? [];
    lastSubmission = lastRows[0] ?? null;
  }

  let liveCount = 0;
  if (openSession) {
    const liveRows = await sbQuery(`submissions?session_id=eq.${openSession.id}&select=id`) ?? [];
    liveCount = liveRows.length;
  }

  let nextSlotMins: number | null = null;
  for (const slot of cfg.schedule) {
    const slotMin = toMinutes(slot.oH, slot.oM);
    if (slotMin > nowMin) { nextSlotMins = slotMin - nowMin; break; }
  }

  const header = cfg.msg_welcome ?? `👋 *${BOT_DISPLAY_NAME}*`;

  let statusLine  = "";
  let sessionLine = "";
  let statsLine   = "";

  if (openSession) {
    const closesAt = new Date(openSession.closes_at as string);
    const minsLeft = Math.max(0, Math.round((closesAt.getTime() - now.getTime()) / 60000));
    statusLine  = "🚦 Status: ✅ Good to post";
    sessionLine = `⏱ Session closes in *${minsLeft}m*`;
    statsLine   = `📊 Live stats: *${liveCount}* links posted`;
  } else if (activeSeason) {
    statusLine  = "⚠️ No active session right now";
    sessionLine = nextSlotMins !== null
      ? `⏰ Next session in *${Math.floor(nextSlotMins / 60)}h ${nextSlotMins % 60}m*`
      : "No more sessions today";
    statsLine   = "—";
  } else {
    statusLine  = "⚠️ No active season";
    sessionLine = nextSlotMins !== null
      ? `⏰ Next session in *${Math.floor(nextSlotMins / 60)}h ${nextSlotMins % 60}m*`
      : "No session scheduled";
    statsLine   = "—";
  }

  const tweetUrl  = activeSubmission?.tweet_url ?? lastSubmission?.tweet_url;
  const tweetLine = tweetUrl ? `🔗 Your link: ${tweetUrl}` : "No tweet submitted yet.";

  const text = `${header}\n\n${statusLine}\n${sessionLine}\n${statsLine}\n\n${tweetLine}`;

  const seasonLabel = activeSeason ? `S${activeSeason.season_number}` : "";
  const rows: unknown[][] = [];

  if (openSession && !activeSubmission) {
    rows.push([{ text: `🔥 Start ${seasonLabel} engagement`, url: cfg.group_invite_link }]);
  }
  rows.push([
    { text: `${remEnabled ? "🔔" : "🔕"} Reminders: ${remEnabled ? "ON" : "OFF"}`, callback_data: "dm:reminder_toggle" },
    { text: activeSubmission ? `✏️ Manage my ${seasonLabel} link` : "✏️ Manage my link", callback_data: "dm:manage" },
  ]);
  rows.push([{ text: "🔗 Go to the group ↗", url: cfg.group_invite_link }]);
  rows.push([{ text: "🔄 Refresh", callback_data: "dm:refresh" }]);

  const replyMarkup = { inline_keyboard: rows };

  if (editMsgId) await editDM(chatId, editMsgId, text, replyMarkup);
  else           await sendDM(chatId, text, replyMarkup);

  if (!openSession && activeSeason) {
    await sendLastSessionLinks(chatId, activeSeason);
  }
}

async function sendLastSessionLinks(
  chatId: number,
  season: Record<string, unknown>,
  page    = 1,
  editMsgId?: number,
) {
  const sessions: Record<string, unknown>[] = await sbQuery(
    `sessions?season_id=eq.${season.id}&status=eq.closed&order=closes_at.desc&limit=1`
  ) ?? [];
  if (!sessions.length) return;

  const sess    = sessions[0];
  const allSubs: Record<string, unknown>[] = await sbQuery(
    `submissions?session_id=eq.${sess.id}&select=x_username,tweet_url&order=submitted_at.asc`
  ) ?? [];

  const totalPages = Math.ceil(allSubs.length / PAGE_SIZE) || 1;
  const pageItems  = allSubs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  let text = `📋 *Last Session Links* (${allSubs.length} total) — Page ${page}/${totalPages}\n\n`;
  pageItems.forEach((s, i) => {
    text += `${(page - 1) * PAGE_SIZE + i + 1}. @${s.x_username} — ${s.tweet_url}\n`;
  });

  const navBtns: unknown[] = [];
  if (page > 1)          navBtns.push({ text: "⬅️ Prev", callback_data: `dm:links:${season.id}:${sess.id}:${page - 1}` });
  if (page < totalPages) navBtns.push({ text: "➡️ Next", callback_data: `dm:links:${season.id}:${sess.id}:${page + 1}` });

  const rows: unknown[][] = [];
  if (navBtns.length) rows.push(navBtns);
  rows.push([{ text: "✅ Engagement confirmed", callback_data: "dm:engaged" }]);
  rows.push([{ text: "⬅️ Back to menu",         callback_data: "dm:refresh" }]);

  const replyMarkup = { inline_keyboard: rows };
  if (editMsgId) await editDM(chatId, editMsgId, text, replyMarkup);
  else           await sendDM(chatId, text, replyMarkup);
}

// ── DM CALLBACKS ───────────────────────────────────────────
async function handleDMCallback(cq: TgCallbackQuery) {
  const data   = cq.data!;
  const userId = cq.from.id;
  const msgId  = cq.message?.message_id;

  if (data === "dm:refresh") {
    await answerCb(cq.id);
    await sendUserDashboard(userId, msgId);
    return;
  }

  if (data === "dm:reminder_toggle") {
    const rows: { enabled: boolean }[] = await sbQuery(
      `user_reminders?telegram_id=eq.${userId}&select=enabled&limit=1`
    ) ?? [];
    if (rows.length) {
      await sbQuery(`user_reminders?telegram_id=eq.${userId}`, {
        method: "PATCH",
        body:   JSON.stringify({ enabled: !rows[0].enabled }),
      });
    } else {
      await sbQuery("user_reminders", {
        method: "POST",
        body:   JSON.stringify({ telegram_id: userId, enabled: false }),
      });
    }
    await answerCb(cq.id);
    await sendUserDashboard(userId, msgId);
    return;
  }

  if (data === "dm:manage") {
    await handleManageLink(cq);
    return;
  }

  if (data === "dm:engaged") {
    await answerCb(cq.id, "Thanks! Keep engaging 💪", true);
    return;
  }

  if (data.startsWith("dm:delete_sub:")) {
    await handleDeleteSub(cq, data.split(":")[2]);
    return;
  }

  if (data.startsWith("dm:links:")) {
    // dm:links:{seasonId}:{sessionId}:{page}
    const parts    = data.split(":");
    const seasonId = parts[2];
    const page     = parseInt(parts[4]) || 1;
    await answerCb(cq.id);
    const seasonRows = await sbQuery(`seasons?id=eq.${seasonId}&limit=1`) ?? [];
    if (seasonRows.length) await sendLastSessionLinks(userId, seasonRows[0], page, msgId);
    return;
  }

  await answerCb(cq.id);
}

async function handleManageLink(cq: TgCallbackQuery) {
  const userId = cq.from.id;
  const msgId  = cq.message?.message_id;

  const activeSeason = await getActiveSeason();
  if (!activeSeason) {
    await answerCb(cq.id, "No active submission to manage.", true);
    return;
  }

  const subRows: Record<string, unknown>[] = await sbQuery(
    `submissions?season_id=eq.${activeSeason.id}&telegram_id=eq.${userId}&select=id,tweet_url,submitted_at&limit=1`
  ) ?? [];
  if (!subRows.length) {
    await answerCb(cq.id, "No active submission to manage.", true);
    return;
  }

  const sub    = subRows[0];
  const ageMs  = Date.now() - new Date(sub.submitted_at as string).getTime();
  if (ageMs > EDIT_WINDOW_MINS * 60 * 1000) {
    await answerCb(cq.id, `⏰ ${EDIT_WINDOW_MINS} min window expired.`, true);
    return;
  }

  const minsLeft = Math.max(0, Math.round((EDIT_WINDOW_MINS * 60 * 1000 - ageMs) / 60000));
  const text =
    `✏️ *Manage your link*\n\n` +
    `URL: ${sub.tweet_url}\n\n` +
    `⚠️ Delete window: *${minsLeft}m remaining*`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: "🗑 Delete my submission", callback_data: `dm:delete_sub:${sub.id}` }],
      [{ text: "⬅️ Back",                callback_data: "dm:refresh" }],
    ],
  };

  await answerCb(cq.id);
  if (msgId) await editDM(userId, msgId, text, replyMarkup);
  else       await sendDM(userId, text, replyMarkup);
}

async function handleDeleteSub(cq: TgCallbackQuery, subId: string) {
  const userId = cq.from.id;
  const msgId  = cq.message?.message_id;

  const subRows: Record<string, unknown>[] = await sbQuery(
    `submissions?id=eq.${subId}&telegram_id=eq.${userId}&select=id,card_message_id,submitted_at&limit=1`
  ) ?? [];
  if (!subRows.length) { await answerCb(cq.id, "Submission not found.", true); return; }

  const sub   = subRows[0];
  const ageMs = Date.now() - new Date(sub.submitted_at as string).getTime();
  if (ageMs > EDIT_WINDOW_MINS * 60 * 1000) {
    await answerCb(cq.id, "⏰ 5 min window expired.", true);
    return;
  }

  await sbQuery(`submissions?id=eq.${subId}`, { method: "DELETE" });

  const cfg = await getConfig();
  if (sub.card_message_id) {
    await delMsg(cfg.group_id, sub.card_message_id as number).catch(() => {});
  }

  await answerCb(cq.id, "✅ Submission deleted.");
  await sendUserDashboard(userId, msgId);
}

// ── REPORT SYSTEM ──────────────────────────────────────────
async function handleReportCallback(cq: TgCallbackQuery) {
  const submissionId = cq.data!.split(":")[1];
  const userId       = cq.from.id;

  const reasonRows = Object.entries(REPORT_REASONS).map(([key, label]) => ([{
    text:          label,
    callback_data: `reportreason:${submissionId}:${key}`,
  }]));
  reasonRows.push([{ text: "⬅️ Cancel", callback_data: "dm:refresh" }]);

  const dmRes = await sendDM(userId, "⚠️ Choose a reason for your report:", {
    inline_keyboard: reasonRows,
  }).catch(() => null);

  if (!dmRes?.ok) {
    await answerCb(
      cq.id,
      `Please DM @${BOT_USERNAME} first (tap Start), then try Report again.`,
      true,
    );
    return;
  }

  await answerCb(cq.id, "Check your DMs to pick a reason.");
}

async function handleReportReasonCallback(cq: TgCallbackQuery) {
  const parts        = cq.data!.split(":");
  const submissionId = parts[1];
  const reasonKey    = parts[2];
  const reasonLabel  = REPORT_REASONS[reasonKey] ?? "🚫 Other";
  const from         = cq.from;
  const msgId        = cq.message?.message_id;
  const cfg          = await getConfig();

  await sbQuery("reports", {
    method: "POST",
    body:   JSON.stringify({
      submission_id:         submissionId,
      reporter_telegram_id:  from.id,
      reporter_username:     from.username ?? null,
      reason:                reasonLabel,
    }),
  });

  const countRows: { id: string }[] = await sbQuery(
    `reports?submission_id=eq.${submissionId}&select=id`
  ) ?? [];
  const reportCount = countRows.length;

  const subRows: Record<string, unknown>[] = await sbQuery(
    `submissions?id=eq.${submissionId}&select=card_message_id,telegram_username,x_username,tweet_url&limit=1`
  ) ?? [];
  const sub = subRows[0];

  if (sub?.card_message_id) {
    await editReplyMarkup(cfg.group_id, sub.card_message_id as number, buildCardKeyboard(submissionId, reportCount));
  }

  const subOwner    = sub?.telegram_username ? `@${sub.telegram_username}` : (sub?.x_username ?? "unknown");
  const cardLink    = sub?.card_message_id
    ? `https://t.me/c/${String(cfg.group_id).replace("-100", "")}/${cfg.engage_topic}/${sub.card_message_id}`
    : "n/a";
  const reporterStr = from.username ? `@${from.username}` : String(from.id);

  await send(
    cfg.group_id,
    `⚠️ *Report Filed*\n\n` +
    `Post by: ${subOwner}\n` +
    `Reason: ${reasonLabel}\n` +
    `Reported by: ${reporterStr}\n` +
    `Card: ${cardLink}\n` +
    `Total reports: *${reportCount}*`,
    cfg.report_topic,
  );

  if (msgId) await delMsg(from.id, msgId).catch(() => {});
  await answerCb(cq.id, "Report submitted. Thank you.", true);
}

// ── ADMIN PANEL ────────────────────────────────────────────
async function sendAdminPanel(chatId: number, editMsgId?: number) {
  const cfg         = await getConfig();
  const scheduleStr = cfg.schedule.map(s =>
    `S${s.n}: ${String(s.oH).padStart(2,"0")}:${String(s.oM).padStart(2,"0")}–${String(s.cH).padStart(2,"0")}:${String(s.cM).padStart(2,"0")}`
  ).join(" | ");

  const text =
    `⚙️ *Spy Agent — Admin Panel*\n\n` +
    `Group ID: \`${cfg.group_id}\`\n` +
    `Engage Topic: \`${cfg.engage_topic}\`\n` +
    `Defaulters Topic: \`${cfg.defaulters_topic}\`\n` +
    `Report Topic: \`${cfg.report_topic}\`\n` +
    `Sessions/day: \`${cfg.sessions_per_day}\`\n` +
    `Auto Manage: ${cfg.auto_manage_enabled ? "🟢 ON" : "🔴 OFF"}\n` +
    `Topic Auto: ${cfg.topic_auto_enabled ? "🟢 ON" : "🔴 OFF"}\n\n` +
    `📅 Schedule (UTC):\n${scheduleStr}`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: "🏠 Group Config", callback_data: "admin:group"    }, { text: "📅 Schedule", callback_data: "admin:schedule" }],
      [{ text: "💬 Messages",     callback_data: "admin:messages" }, { text: "⚙️ Auto Manage", callback_data: "admin:auto" }],
      [{ text: "🔄 Refresh",      callback_data: "admin:refresh"  }],
    ],
  };

  if (editMsgId) await editDM(chatId, editMsgId, text, replyMarkup);
  else           await sendDM(chatId, text, replyMarkup);
}

async function sendAutoPanel(chatId: number, editMsgId?: number) {
  const cfg  = await getConfig();
  const text =
    `⚙️ *Auto Management*\n\n` +
    `Auto Group Management: ${cfg.auto_manage_enabled ? "🟢 ON" : "🔴 OFF"}\n` +
    `Topic Auto-Manage: ${cfg.topic_auto_enabled ? "🟢 ON" : "🔴 OFF"}`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: `${cfg.auto_manage_enabled ? "🔴 Turn OFF" : "🟢 Turn ON"} Auto Group`, callback_data: "admin:toggle_automanage" }],
      [{ text: `${cfg.topic_auto_enabled  ? "🔴 Turn OFF" : "🟢 Turn ON"} Topic Auto`, callback_data: "admin:toggle_topicauto"  }],
      [{ text: "⬅️ Back", callback_data: "admin:refresh" }],
    ],
  };

  if (editMsgId) await editDM(chatId, editMsgId, text, replyMarkup);
  else           await sendDM(chatId, text, replyMarkup);
}

// ── ADMIN CALLBACKS ────────────────────────────────────────
async function handleAdminCallback(cq: TgCallbackQuery) {
  const data   = cq.data!;
  const chatId = cq.from.id;
  const msgId  = cq.message?.message_id;
  const cfg    = await getConfig();

  if (data === "admin:refresh") {
    await answerCb(cq.id);
    await sendAdminPanel(chatId, msgId);
    return;
  }

  if (data === "admin:group") {
    await answerCb(cq.id);
    const text =
      `🏠 *Group Config*\n\n` +
      `Group ID: \`${cfg.group_id}\` → /setgroup <id>\n` +
      `Engage Topic: \`${cfg.engage_topic}\` → /setengagetopic <id>\n` +
      `Defaulters Topic: \`${cfg.defaulters_topic}\` → /setdefaulterstopic <id>\n` +
      `Report Topic: \`${cfg.report_topic}\` → /setreporttopic <id>\n` +
      `Invite Link: \`${cfg.group_invite_link}\` → /setgrouplink <url>`;
    await editDM(chatId, msgId!, text, { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin:refresh" }]] });
    return;
  }

  if (data === "admin:schedule") {
    await answerCb(cq.id);
    const scheduleStr = cfg.schedule.map(s =>
      `Slot ${s.n}: ${String(s.oH).padStart(2,"0")}:${String(s.oM).padStart(2,"0")} → ${String(s.cH).padStart(2,"0")}:${String(s.cM).padStart(2,"0")} UTC`
    ).join("\n");
    const example = `[{"n":1,"oH":6,"oM":0,"cH":7,"cM":0},{"n":2,"oH":10,"oM":0,"cH":11,"cM":0}]`;
    await editDM(
      chatId, msgId!,
      `📅 *Schedule*\n\n${scheduleStr}\n\nUpdate: \`/setschedule <json>\`\nExample:\n\`${example}\``,
      { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin:refresh" }]] }
    );
    return;
  }

  if (data === "admin:messages") {
    await answerCb(cq.id);
    const keys = [
      ["open",               cfg.msg_open,               "{season_number}, {session_number}"],
      ["rules",              cfg.msg_rules,              "none"],
      ["welcome",            cfg.msg_welcome,            "none"],
      ["season_start",       cfg.msg_season_start,       "{season_number}"],
      ["season_close",       cfg.msg_season_close,       "{season_number}, {total}, {unique}, {vetting_url}"],
      ["submission_confirm", cfg.msg_submission_confirm, "{session_number}, {edit_window}"],
      ["reminder",           cfg.msg_reminder,           "none"],
    ];
    const lines = keys.map(([k, v, p]) =>
      `\`${k}\`: ${v ? "✅ Set" : "⚠️ Not set"}\n  _Placeholders: ${p}_`
    ).join("\n\n");
    await editDM(
      chatId, msgId!,
      `💬 *Message Templates*\n\nSet with: \`/setmsg <key> <text>\`\n\n${lines}`,
      { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin:refresh" }]] }
    );
    return;
  }

  if (data === "admin:auto") {
    await answerCb(cq.id);
    await sendAutoPanel(chatId, msgId);
    return;
  }

  if (data === "admin:toggle_automanage") {
    const newVal = !cfg.auto_manage_enabled;
    await setConfigKey("auto_manage_enabled", String(newVal));
    await answerCb(cq.id, `Auto Group Management ${newVal ? "ON" : "OFF"}`);
    await sendAutoPanel(chatId, msgId);
    return;
  }

  if (data === "admin:toggle_topicauto") {
    const newVal = !cfg.topic_auto_enabled;
    await setConfigKey("topic_auto_enabled", String(newVal));
    await answerCb(cq.id, `Topic Auto-Manage ${newVal ? "ON" : "OFF"}`);
    await sendAutoPanel(chatId, msgId);
    return;
  }

  await answerCb(cq.id);
}

// ── GROUP COMMANDS ─────────────────────────────────────────
async function handleGroupCommand(cmd: string, msg: TgMessage, cfg: BotConfig) {
  const chatId   = msg.chat.id;
  const fromId   = msg.from!.id;
  const threadId = msg.message_thread_id;

  switch (cmd) {
    case "/managegroup": {
      const newVal = !cfg.auto_manage_enabled;
      await setConfigKey("auto_manage_enabled", String(newVal));
      await send(chatId,
        newVal
          ? `✅ Auto Group Management: ON\n\nবট এখন থেকে দৈনিক শিডিউল অনুযায়ী সব season automatic খুলবে, বন্ধ করবে ও রিপোর্ট বানাবে।`
          : `❌ Auto Group Management: OFF\n\nবট আর নতুন season তৈরি করবে না।`,
        threadId,
      );
      break;
    }

    case "/managetopic": {
      const newVal = !cfg.topic_auto_enabled;
      await setConfigKey("topic_auto_enabled", String(newVal));
      await send(chatId,
        newVal
          ? `🔔 Topic Auto-Manage: ON\nবট প্রতিটা session-এ engage topic open/close করবে।`
          : `🔕 Topic Auto-Manage: OFF\nTopic আর automatic open/close হবে না।`,
        threadId,
      );
      break;
    }

    case "/info": {
      const dl           = dateLabel(new Date());
      const todaySeasons = await sbQuery(`seasons?date_label=eq.${dl}&select=id`) ?? [];
      const activeSeason = await getActiveSeason();
      const openSession  = activeSeason ? await getOpenSession(activeSeason.id as string) : null;
      let subCount = 0;
      if (openSession) {
        const sc = await sbQuery(`submissions?session_id=eq.${openSession.id}&select=id`) ?? [];
        subCount = sc.length;
      }
      const scheduleStr = cfg.schedule.map(s =>
        `• Slot ${s.n}: ${String(s.oH).padStart(2,"0")}:${String(s.oM).padStart(2,"0")}–${String(s.cH).padStart(2,"0")}:${String(s.cM).padStart(2,"0")} UTC`
      ).join("\n");
      await send(chatId,
        `ℹ️ *Info*\n\n` +
        `Seasons today: *${todaySeasons.length}/${cfg.sessions_per_day}*\n` +
        `Active season: ${activeSeason ? `S${activeSeason.season_number}` : "None"}\n` +
        `Open session: ${openSession ? `#${openSession.session_number} (${subCount} links)` : "None"}\n\n` +
        `Auto Manage: ${cfg.auto_manage_enabled ? "🟢 ON" : "🔴 OFF"}\n` +
        `Topic Auto: ${cfg.topic_auto_enabled ? "🟢 ON" : "🔴 OFF"}\n\n` +
        `📅 Schedule (UTC):\n${scheduleStr}`,
        threadId,
      );
      break;
    }

    case "/status": {
      const now          = new Date();
      const nowMin       = utcMinutes(now);
      const activeSeason = await getActiveSeason();
      const openSession  = activeSeason ? await getOpenSession(activeSeason.id as string) : null;
      if (openSession) {
        const minsLeft = Math.max(0, Math.round(
          (new Date(openSession.closes_at as string).getTime() - now.getTime()) / 60000
        ));
        await send(chatId, `🟢 Session *${openSession.session_number}* is open — closes in *${minsLeft}m*`, threadId);
      } else {
        let nextInfo = "No upcoming session today";
        for (const slot of cfg.schedule) {
          const slotMin = toMinutes(slot.oH, slot.oM);
          if (slotMin > nowMin) {
            const diff = slotMin - nowMin;
            nextInfo = `Next session (Slot ${slot.n}) in *${Math.floor(diff/60)}h ${diff%60}m*`;
            break;
          }
        }
        await send(chatId, `🔴 No session open. ${nextInfo}`, threadId);
      }
      break;
    }

    case "/stats": {
      const activeSeason = await getActiveSeason();
      const season       = activeSeason ??
        (await sbQuery("seasons?order=started_at.desc&limit=1") ?? [])[0];
      if (!season) { await send(chatId, "No season data found.", threadId); break; }

      const sessRows: { id: string; session_number: number }[] = await sbQuery(
        `sessions?season_id=eq.${season.id}&select=id,session_number&order=session_number.asc`
      ) ?? [];
      let text = `📊 *Stats — Season ${season.season_number}*\n\n`;
      for (const sess of sessRows) {
        const subs: { telegram_id: number }[] = await sbQuery(
          `submissions?session_id=eq.${sess.id}&select=telegram_id`
        ) ?? [];
        const unique = new Set(subs.map(s => s.telegram_id)).size;
        text += `Session ${sess.session_number}: *${subs.length} links*, ${unique} unique\n`;
      }
      await send(chatId, text, threadId);
      break;
    }

    case "/report": {
      const vrRows: Record<string, unknown>[] = await sbQuery(
        "verification_reports?status=eq.complete&order=generated_at.desc&limit=1"
      ) ?? [];
      if (!vrRows.length) {
        const stateRows: Record<string, unknown>[] = await sbQuery(
          "extension_state?scan_status=eq.uploaded&order=created_at.desc&limit=1"
        ) ?? [];
        if (stateRows.length) {
          fetch(`${SUPABASE_URL}/functions/v1/generate-report`, {
            method:  "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}` },
            body:    JSON.stringify({ state_id: stateRows[0].id }),
          }).catch(() => {});
          await send(chatId, "🔄 Generating report...", threadId);
        } else {
          await send(chatId, "No verification report available yet.", threadId);
        }
        break;
      }
      const vr  = vrRows[0];
      const pct = vr.total_submitted
        ? Math.round(((vr.total_engaged as number) / (vr.total_submitted as number)) * 100)
        : 0;
      await send(
        chatId,
        `📊 *Verification Report*\n\nParticipants: *${vr.total_submitted}*\nEngaged: *${vr.total_engaged}* (${pct}%)\nMissing: *${vr.total_missing}*`,
        threadId,
      );
      break;
    }

    case "/defaulters": {
      const vrRows: Record<string, unknown>[] = await sbQuery(
        "verification_reports?status=eq.complete&order=generated_at.desc&limit=1"
      ) ?? [];
      if (!vrRows.length) { await send(chatId, "No report available.", threadId); break; }

      const missing = vrRows[0].missing_usernames as string[];
      if (!missing.length) { await send(chatId, "No defaulters! Everyone engaged. 🎉", threadId); break; }

      // Group → defaulters_topic; DM → normal reply
      const isDM      = msg.chat.type === "private";
      const targetId  = isDM ? chatId : cfg.group_id;
      const targetTid = isDM ? undefined : cfg.defaulters_topic;

      for (let i = 0; i < missing.length; i += 30) {
        const chunk = missing.slice(i, i + 30).map(u => `@${u}`).join("\n");
        await send(targetId, `❌ *Defaulters* (${i + 1}–${Math.min(i + 30, missing.length)}):\n\n${chunk}`, targetTid);
      }
      break;
    }

    case "/verify": {
      const stateRows: Record<string, unknown>[] = await sbQuery(
        "extension_state?scan_status=in.(ready,scanning,uploaded)&order=created_at.desc&limit=1"
      ) ?? [];
      if (!stateRows.length) { await send(chatId, "No pending verification task.", threadId); break; }
      const s = stateRows[0];
      await send(
        chatId,
        `🔍 *Verification Status*\n\nStatus: \`${s.scan_status}\`\nTargets: *${(s.target_usernames as string[]).length}*\nVetting URL: ${s.vetting_url}`,
        threadId,
      );
      break;
    }

    case "/export": {
      const activeSeason = await getActiveSeason();
      const season       = activeSeason ??
        (await sbQuery("seasons?order=started_at.desc&limit=1") ?? [])[0];
      if (!season) { await send(chatId, "No season data.", threadId); break; }

      const subs: Record<string, unknown>[] = await sbQuery(
        `submissions?season_id=eq.${season.id}&select=telegram_id,telegram_username,x_username,tweet_url,session_id,submitted_at&order=submitted_at.asc`
      ) ?? [];
      const sessionRows: { id: string; session_number: number }[] = await sbQuery(
        `sessions?season_id=eq.${season.id}&select=id,session_number`
      ) ?? [];
      const sessMap: Record<string, number> = {};
      for (const sr of sessionRows) sessMap[sr.id] = sr.session_number;

      const esc    = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const header = ["TG ID","TG Username","X Username","Tweet URL","Session","Date","Submitted At"].map(esc).join(",");
      const rows   = subs.map(s => [
        s.telegram_id, s.telegram_username ?? "", s.x_username,
        s.tweet_url, sessMap[s.session_id as string] ?? "",
        (s.submitted_at as string).slice(0,10), s.submitted_at,
      ].map(esc).join(","));

      await sendDocumentTopic(
        chatId, threadId ?? 0,
        [header, ...rows].join("\n"),
        `season_${season.season_number}_export.csv`,
        `📊 Season ${season.season_number} Export — ${subs.length} submissions`,
      );
      break;
    }

    case "/clearsession": {
      if (!isOwner(fromId)) break;
      const activeSeason = await getActiveSeason();
      if (!activeSeason) { await send(chatId, "No active season.", threadId); break; }
      await sbQuery(`sessions?season_id=eq.${activeSeason.id}&status=eq.open`, {
        method: "PATCH",
        body:   JSON.stringify({ status: "closed", close_msg_sent: true }),
      });
      await send(chatId, "✅ All open sessions force-closed.", threadId);
      break;
    }
  }
}

// ── CONFIG COMMANDS ────────────────────────────────────────
const CONFIG_CMDS = new Set([
  "/setgroup", "/setengagetopic", "/setdefaulterstopic", "/setreporttopic",
  "/setgrouplink", "/setschedule", "/setmsg",
]);

async function handleConfigCmd(cmd: string, fullText: string, chatId: number) {
  const parts = fullText.trim().split(/\s+/);
  const arg   = parts.slice(1).join(" ").trim();

  const numericCmd: Record<string, string> = {
    "/setgroup":           "group_id",
    "/setengagetopic":     "engage_topic",
    "/setdefaulterstopic": "defaulters_topic",
    "/setreporttopic":     "report_topic",
  };

  if (numericCmd[cmd]) {
    if (isNaN(Number(arg))) { await sendDM(chatId, "❌ Provide a numeric ID."); return; }
    await setConfigKey(numericCmd[cmd], arg);
    await sendDM(chatId, `✅ \`${numericCmd[cmd]}\` set to \`${arg}\``);
    return;
  }

  if (cmd === "/setgrouplink") {
    if (!arg.startsWith("http")) { await sendDM(chatId, "❌ Provide a valid URL."); return; }
    await setConfigKey("group_invite_link", arg);
    await sendDM(chatId, "✅ group_invite_link updated.");
    return;
  }

  if (cmd === "/setschedule") {
    try {
      const parsed = JSON.parse(arg);
      if (!Array.isArray(parsed) || !parsed.length) throw new Error("empty");
      await setConfigKey("schedule", arg);
      await sendDM(chatId, `✅ Schedule updated with ${parsed.length} slots.`);
    } catch {
      await sendDM(chatId, "❌ Invalid JSON. Provide a non-empty array.");
    }
    return;
  }

  if (cmd === "/setmsg") {
    // Preserve internal newlines in the message template — only split off
    // the command and the key, keep the rest (including line breaks) intact.
    const m = fullText.match(/^\S+\s+(\S+)\s+([\s\S]+)$/);
    if (!m) {
      await sendDM(chatId, "❌ Usage: /setmsg <key> <text>");
      return;
    }
    const key   = m[1];
    const value = m[2].trim();
    const dbKey = MSG_KEY_MAP[key];
    if (!dbKey) {
      await sendDM(chatId, `❌ Unknown key. Valid: ${Object.keys(MSG_KEY_MAP).join(", ")}`);
      return;
    }
    if (!value) { await sendDM(chatId, "❌ Message text cannot be empty."); return; }
    await setConfigKey(dbKey, value);
    await sendDM(chatId, `✅ \`${key}\` message set.`);
    return;
  }
}

// ── MAIN SERVE ─────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST")    return new Response("ok", { status: 200 });

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  // Fire-and-forget auto session logic (non-blocking)
  runAutoSession().catch(e => console.error("runAutoSession error:", e));

  try {
    // ── CALLBACK QUERY ──────────────────────────────────
    if (update.callback_query) {
      const cq   = update.callback_query;
      const data = cq.data ?? "";
      const uid  = cq.from.id;

      if      (data.startsWith("admin:")       && isAdmin(uid)) await handleAdminCallback(cq);
      else if (data.startsWith("dm:"))                          await handleDMCallback(cq);
      else if (data.startsWith("reportreason:"))                await handleReportReasonCallback(cq);
      else if (data.startsWith("report:"))                      await handleReportCallback(cq);
      else                                                       await answerCb(cq.id);

      return new Response("ok", { status: 200 });
    }

    const msg = update.message ?? update.edited_message;
    if (!msg) return new Response("ok", { status: 200 });

    const from    = msg.from!;
    const chatId  = msg.chat.id;
    const text    = msg.text ?? "";
    const admin   = isAdmin(from.id);
    const owner   = isOwner(from.id);
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isDM    = msg.chat.type === "private";
    const cfg     = await getConfig();

    // ── GROUP ──────────────────────────────────────────
    if (isGroup) {
      if (!text.startsWith("/")) {
        if (!admin) await handleSubmission(msg, cfg);
        return new Response("ok", { status: 200 });
      }
      if (admin) {
        const cmd = text.split(/[\s@]/)[0].toLowerCase();
        await handleGroupCommand(cmd, msg, cfg);
      }
      return new Response("ok", { status: 200 });
    }

    if (!isDM) return new Response("ok", { status: 200 });

    // ── DM ─────────────────────────────────────────────
    const cmd = text.split(/[\s@]/)[0].toLowerCase();

    // Owner config commands
    if (owner && CONFIG_CMDS.has(cmd)) {
      await handleConfigCmd(cmd, text, chatId);
      return new Response("ok", { status: 200 });
    }

    // /start or /help
    if (cmd === "/start" || cmd === "/help") {
      if (!admin) {
        await ensureUser(from);
        await sendUserDashboard(chatId);
      } else if (owner) {
        await sendDM(
          chatId,
          `👋 *${BOT_DISPLAY_NAME}*\n\n` +
          `*Auto-Management:* /managegroup /managetopic\n` +
          `*Info:* /info /stats /status /report /defaulters /verify /export\n` +
          `*Emergency (Owner):* /clearsession\n` +
          `*Settings (Owner):* /settings\n\n` +
          `/setgroup /setengagetopic /setdefaulterstopic\n` +
          `/setreporttopic /setgrouplink /setschedule\n` +
          `/setmsg <key> <text>`,
        );
      } else {
        await sendDM(
          chatId,
          `👋 *${BOT_DISPLAY_NAME}*\n\n` +
          `*Auto-Management:* /managegroup /managetopic\n` +
          `*Info:* /info /stats /status /report /defaulters /verify /export`,
        );
      }
      return new Response("ok", { status: 200 });
    }

    // /settings (owner only)
    if (cmd === "/settings" && owner) {
      await sendAdminPanel(chatId);
      return new Response("ok", { status: 200 });
    }

    // Admin DM commands (same as group commands)
    if (admin) {
      await handleGroupCommand(cmd, msg, cfg);
      return new Response("ok", { status: 200 });
    }

    // Regular user sent something else in DM (plain text / unknown command) —
    // always respond with their dashboard instead of staying silent.
    await ensureUser(from);
    await sendUserDashboard(chatId);

  } catch (e) {
    console.error("Webhook top-level error:", e);
  }

  // Always return 200 to prevent Telegram retries
  return new Response("ok", { status: 200 });
});
