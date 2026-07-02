// ============================================================
// SPY AGENT — generate-report (SELF-CONTAINED)
// Compares engaged (lowercase) vs submitted (original casing)
// Sends DM report to all admins with original-casing usernames
// ============================================================

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN             = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

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

async function sendDM(chatId: number, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    return res.json();
  } catch (e) {
    console.error(`sendDM to ${chatId} error:`, e);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { state_id } = await req.json().catch(() => ({}));
    if (!state_id) {
      return new Response(
        JSON.stringify({ error: "Missing state_id" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // 1. Load extension_state
    const stateRows: Record<string, unknown>[] = await sbQuery(
      `extension_state?id=eq.${state_id}&limit=1`
    ) ?? [];
    if (!stateRows.length) {
      return new Response(
        JSON.stringify({ error: "state not found" }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
    const state    = stateRows[0];
    const seasonId = state.season_id as string;

    // 2. Load all submissions for this season
    // x_username stored with EXACT original casing (yep_ifad, see_ff)
    const subs: { x_username: string; telegram_username: string | null; telegram_id: number }[] =
      await sbQuery(
        `submissions?season_id=eq.${seasonId}&select=x_username,telegram_username,telegram_id`
      ) ?? [];

    // 3. Build display map: lowercase key → original casing value
    // Uses submissions table directly (authoritative exact casing)
    const displayMap = new Map<string, string>();
    for (const s of subs) {
      const key = s.x_username.toLowerCase();
      // If multiple entries for same user (shouldn't happen due to unique index),
      // keep the most recent (last wins — order is submission order)
      displayMap.set(key, s.x_username);
    }

    // 4. Unique submitted usernames (lowercase keys for comparison)
    const submittedKeys = new Set(subs.map(s => s.x_username.toLowerCase()));

    // 5. Engaged set — already lowercase from upload-engaged normalization
    const engagedKeys = new Set((state.engaged_usernames as string[]) ?? []);

    // 6. Compute sets
    // engaged: submitted ∩ engaged (comparison on lowercase)
    // missing: submitted − engaged
    const engagedList: string[] = []; // original casing
    const missingList: string[] = []; // original casing

    for (const key of submittedKeys) {
      const original = displayMap.get(key) ?? key; // fallback to key if not in map
      if (engagedKeys.has(key)) {
        engagedList.push(original);
      } else {
        missingList.push(original);
      }
    }

    const totalSubmitted = submittedKeys.size;
    const totalEngaged   = engagedList.length;
    const totalMissing   = missingList.length;

    // 7. Insert verification_report (status: complete)
    const vrInsert = await sbQuery("verification_reports", {
      method: "POST",
      body:   JSON.stringify({
        season_id:           seasonId,
        vetting_tweet_url:   state.vetting_url,
        vetting_tweet_owner: null,
        total_submitted:     totalSubmitted,
        total_engaged:       totalEngaged,
        total_missing:       totalMissing,
        engaged_usernames:   engagedList,   // original casing
        missing_usernames:   missingList,   // original casing
        submitted_usernames: [...displayMap.values()], // original casing
        status:              "complete",
        generated_at:        new Date().toISOString(),
      }),
    });
    const reportId = vrInsert?.[0]?.id as string | undefined;

    // 8. Update extension_state: complete
    await sbQuery(`extension_state?id=eq.${state_id}`, {
      method: "PATCH",
      body:   JSON.stringify({
        scan_status: "complete",
        ...(reportId ? { report_id: reportId } : {}),
      }),
    });

    // 9. Build DM report
    const engagePct   = totalSubmitted > 0
      ? Math.round((totalEngaged / totalSubmitted) * 100)
      : 0;
    const reportShort = reportId ? reportId.slice(0, 8) : "n/a";

    // Missing usernames display: original casing with @
    const missingDisplay  = missingList.map(u => `@${u}`);
    const firstForty      = missingDisplay.slice(0, 40).join(", ");
    const remainder       = missingDisplay.length > 40
      ? ` ... +${missingDisplay.length - 40} more`
      : "";

    const dmText =
      `📊 *Verification Report* \`${reportShort}\`\n\n` +
      `👥 Participants: *${totalSubmitted}*\n` +
      `✅ Engaged: *${totalEngaged}* (${engagePct}%)\n` +
      `❌ Missing: *${totalMissing}*\n\n` +
      (totalMissing > 0
        ? `*Missing users:*\n${firstForty}${remainder}`
        : `_All participants engaged! 🎉_`);

    // 10. DM all admins
    const adminRows: { telegram_id: number }[] = await sbQuery("admins?select=telegram_id") ?? [];
    for (const admin of adminRows) {
      sendDM(admin.telegram_id, dmText).catch(e =>
        console.error(`DM to ${admin.telegram_id} failed:`, e)
      );
    }

    return new Response(
      JSON.stringify({ ok: true, report_id: reportId, total_submitted: totalSubmitted, total_engaged: totalEngaged, total_missing: totalMissing }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("generate-report error:", e);
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
