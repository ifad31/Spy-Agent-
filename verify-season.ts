// ============================================================
// SPY AGENT — verify-season (SELF-CONTAINED)
// Browser extension calls this to claim a verification task
// Returns exact-casing target_usernames (yep_ifad stays yep_ifad)
// ============================================================

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // Find latest ready extension_state
    const rows: Record<string, unknown>[] = await sbQuery(
      "extension_state?scan_status=eq.ready&order=created_at.desc&limit=1"
    ) ?? [];

    if (!rows.length) {
      return new Response(
        JSON.stringify({ error: "No active verification task" }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const state = rows[0];

    // Claim it — move to scanning
    await sbQuery(`extension_state?id=eq.${state.id}`, {
      method: "PATCH",
      body:   JSON.stringify({ scan_status: "scanning" }),
    });

    // Return exact-casing target_usernames (underscore preserved, no mangling)
    return new Response(
      JSON.stringify({
        state_id:         state.id,
        season_id:        state.season_id,
        vetting_url:      state.vetting_url,
        target_usernames: state.target_usernames, // exact: yep_ifad, see_ff etc.
        total_to_check:   (state.target_usernames as string[]).length,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("verify-season error:", e);
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
